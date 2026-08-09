{
  self,
  lib,
  inputs ? self.inputs,
  ...
}:
let
  inherit (lib)
    all
    hasPrefix
    isValidPosixName
    mkEnableOption
    mkIf
    mkOption
    optional
    types
    ;

  apiKeyType = types.submodule {
    options = {
      file = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Path to a file containing the provider API key.";
      };

      fromEnv = mkOption {
        type = types.nullOr types.bool;
        default = null;
        description = "Whether to forward this API key from the caller environment.";
      };
    };
  };

  jailedPiModule =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.programs."roche-pi".jailed;
      piCfg = config.programs."roche-pi";
      upstreamPiPackage = inputs.llm-agents.packages.${pkgs.system}.pi;
      piPackage = self.packages.${pkgs.system}.pi-superpowers;
      claudePackage = inputs.llm-agents.packages.${pkgs.system}."claude-code";
      zellijPackage = inputs.llm-agents.inputs.nixpkgs.legacyPackages.${pkgs.system}.zellij;
      homeDir = config.home.homeDirectory;
      authSetupLib = import ../../nix/lib/jailed-pi-auth.nix { inherit lib; };
      githubBrokerLib = import ../../nix/lib/jailed-github-broker.nix {
        inherit lib pkgs;
      };
      authSetupScript = authSetupLib.mkAuthSetup {
        inherit (cfg) authMode;
        globalAuthPathExpr = lib.escapeShellArg "${homeDir}/.pi/agent/auth.json";
      };
      credentialJail = inputs.jail-nix.lib.init pkgs;
      sessionEditor = config.home.sessionVariables.EDITOR or "vi";
      editorPackage = if sessionEditor == "nvim" || cfg.editor == "nvim" then pkgs.neovim else null;
      editorCommand = if sessionEditor == "nvim" then "${pkgs.neovim}/bin/nvim" else sessionEditor;

      piResources = import ../../nix/lib/pi-resources.nix {
        inherit pkgs;
        package = piCfg.package;
        settings = lib.recursiveUpdate piCfg.settings {
          lastChangelogVersion = upstreamPiPackage.version;
        };
        stylix = {
          enable = piCfg.stylix.enable;
          colors = config.lib.stylix.colors;
        };
      };

      apiKeyFiles = lib.filter (file: file != null) (
        lib.mapAttrsToList (_: apiKey: apiKey.file) cfg.apiKeys
      );

      hostCredentialPermissions = with credentialJail.combinators; [
        (add-runtime ''
          if [ -n "''${XDG_RUNTIME_DIR:-}" ]; then
            RUNTIME_ARGS+=(
              --dir /run
              --dir /run/user
              --dir "$XDG_RUNTIME_DIR"
              --bind-try "$XDG_RUNTIME_DIR/op-daemon.sock" "$XDG_RUNTIME_DIR/op-daemon.sock"
              --bind-try "$XDG_RUNTIME_DIR/gnupg" "$XDG_RUNTIME_DIR/gnupg"
            )
          fi
        '')
        (try-fwd-env "XDG_RUNTIME_DIR")
        (try-fwd-env "GPG_TTY")
        (try-readwrite (noescape ''"$HOME/.config/op"''))
        (try-readwrite (noescape ''"$HOME/.gnupg"''))
        (try-readonly (noescape ''"$HOME/.config/git"''))
        (try-readwrite (noescape ''"$HOME/.claude"''))
        (try-readwrite (noescape ''"$HOME/.claude.json"''))
        (try-readwrite (noescape ''"$HOME/.config/claude"''))
      ];
    in
    {
      options.programs."roche-pi".jailed = {
        enable = mkEnableOption "the jailed Roche Pi Home Manager module";

        packageName = mkOption {
          type = types.str;
          default = "jailed-pi";
        };

        agentDir = mkOption {
          type = types.str;
          default = "${homeDir}/.pi/agent-jailed";
        };

        authMode = mkOption {
          type = types.enum [
            "global"
            "local"
          ];
          default = "global";
          description = "Whether jailed Pi shares global authentication or stores authentication in its agent directory.";
        };

        inheritGitIdentity = mkOption {
          type = types.bool;
          default = true;
          description = "Whether jailed Pi inherits Git's effective name and email from the launch repository.";
        };

        githubBroker = mkOption {
          type = githubBrokerLib.mkSubmoduleType;
          default = { };
          description = "Non-secret repository policy and resource limits for the host-side GitHub broker.";
        };

        apiKeys = mkOption {
          type = types.attrsOf apiKeyType;
          default = { };
          example = {
            OPENROUTER_API_KEY.file = "/run/secrets/openrouter-api-key";
            ANTHROPIC_API_KEY.fromEnv = true;
          };
        };

        editor = mkOption {
          type = types.str;
          default = editorCommand;
        };

        docker = {
          enable = mkEnableOption "Docker client access from jailed Pi, including host Docker socket access";

          package = mkOption {
            type = types.package;
            default = pkgs.docker-client;
            description = "Docker client package to include when Docker support is enabled.";
          };

          composePackage = mkOption {
            type = types.package;
            default = pkgs.docker-compose;
            description = "Docker Compose package to include when Docker support is enabled.";
          };
        };

        podman = {
          enable = mkEnableOption "Podman client access from jailed Pi via the rootless host Podman socket path";

          packages = mkOption {
            type = types.listOf types.package;
            default = [
              pkgs.podman
              pkgs.podman-compose
            ];
            description = "Podman client packages to include when Podman support is enabled.";
          };
        };

        extraPkgs = mkOption {
          type = types.listOf types.package;
          default = [ ];
        };

        runtimeStoreClosurePaths = mkOption {
          type = types.listOf types.str;
          default = [ ];
          description = "Project-relative or absolute runtime paths whose resolved /nix/store closure should be exposed inside jailed Pi.";
          example = [
            ''"$PWD/.pre-commit-config.yaml"''
            ''"$PWD/.pre-commit-config.yml"''
          ];
        };

        extraPermissions = mkOption {
          type = types.listOf types.anything;
          default = [ ];
        };
      };

      config = mkIf cfg.enable {
        assertions = [
          {
            assertion = piCfg.enable;
            message = "programs.roche-pi.jailed.enable requires programs.roche-pi.enable = true.";
          }
          {
            assertion = hasPrefix "/" cfg.agentDir;
            message = "programs.roche-pi.jailed.agentDir must be an absolute path.";
          }
          {
            assertion = cfg.agentDir != "${homeDir}/.pi/agent";
            message = "programs.roche-pi.jailed.agentDir must not be the normal ~/.pi/agent directory.";
          }
          {
            assertion = !cfg.githubBroker.enable || cfg.githubBroker.repository != "";
            message = "programs.roche-pi.jailed.githubBroker.repository is required when the broker is enabled.";
          }
          {
            assertion =
              lib.length cfg.githubBroker.capabilities == lib.length (lib.unique cfg.githubBroker.capabilities);
            message = "programs.roche-pi.jailed.githubBroker.capabilities must not contain duplicates.";
          }
          {
            assertion =
              !builtins.elem "git:write" cfg.githubBroker.capabilities
              || builtins.elem "git:read" cfg.githubBroker.capabilities;
            message = "programs.roche-pi.jailed.githubBroker git:write requires git:read.";
          }
          {
            assertion =
              lib.length cfg.githubBroker.pushPolicy.denyRefs
              == lib.length (lib.unique cfg.githubBroker.pushPolicy.denyRefs);
            message = "programs.roche-pi.jailed.githubBroker.pushPolicy.denyRefs must not contain duplicates.";
          }
          {
            assertion = all (name: isValidPosixName name) (lib.attrNames cfg.apiKeys);
            message = "programs.roche-pi.jailed.apiKeys attribute names must be valid POSIX environment variable names.";
          }
          {
            assertion = all (file: hasPrefix "/" file) apiKeyFiles;
            message = "programs.roche-pi.jailed.apiKeys.<name>.file values must be absolute paths.";
          }
        ];

        home.activation.jailedPiAgentDir = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
          agent_dir=${lib.escapeShellArg cfg.agentDir}

          mkdir -p ${lib.escapeShellArg homeDir}/.pi/agent/sessions

          mkdir -p "$agent_dir"

          ln -sfnT ${piResources.package}/AGENTS.md "$agent_dir/AGENTS.md"
          ln -sfnT ${piResources.package}/settings.json "$agent_dir/settings.json"
          ln -sfnT ${piResources.package}/mcp.json "$agent_dir/mcp.json"
          ln -sfnT ${piResources.package}/agents "$agent_dir/agents"
          ln -sfnT ${piResources.package}/extensions "$agent_dir/extensions"
          ln -sfnT ${piResources.package}/multi-model-planning-teams "$agent_dir/multi-model-planning-teams"
          ln -sfnT ${piResources.package}/node_modules "$agent_dir/node_modules"
          ln -sfnT ${piResources.package}/skills "$agent_dir/skills"
          ln -sfnT ${piResources.package}/themes "$agent_dir/themes"
          ${authSetupScript}
          ln -sfnT ${lib.escapeShellArg homeDir}/.pi/agent/sessions "$agent_dir/sessions"
        '';

        home.packages = [
          (self.lib.${pkgs.system}.mkJailedPi {
            name = cfg.packageName;
            agentConfigPackage = piResources.package;
            defaultAgentDir = cfg.agentDir;
            authMode = cfg.authMode;
            apiKeys = cfg.apiKeys;
            inherit piPackage;
            editor = cfg.editor;
            inheritGitIdentity = cfg.inheritGitIdentity;
            githubBroker = cfg.githubBroker;
            docker = cfg.docker;
            podman = cfg.podman;
            extraPkgs = [
              pkgs._1password-cli
              config.programs.gpg.package
              claudePackage
              zellijPackage
            ]
            ++ cfg.extraPkgs
            ++ optional (editorPackage != null) editorPackage;
            runtimeStoreClosurePaths = cfg.runtimeStoreClosurePaths ++ [ ''"$HOME/.config/git/config"'' ];
            runtimeClosurePkgs = [ piResources.package ];
            extraPermissions = hostCredentialPermissions ++ cfg.extraPermissions;
          })
        ];
      };
    };
in
{
  flake.homeModules."jailed-pi" = jailedPiModule;
}
