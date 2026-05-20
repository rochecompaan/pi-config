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
    { config, pkgs, ... }:
    let
      cfg = config.programs."roche-pi".jailed;
      piCfg = config.programs."roche-pi";
      piPackage = inputs.llm-agents.packages.${pkgs.system}.pi;
      homeDir = config.home.homeDirectory;
      gitUserName = config.programs.git.settings.user.name or null;
      gitUserEmail = config.programs.git.settings.user.email or null;
      sessionEditor = config.home.sessionVariables.EDITOR or "vi";
      editorPackage = if sessionEditor == "nvim" || cfg.editor == "nvim" then pkgs.neovim else null;
      editorCommand = if sessionEditor == "nvim" then "${pkgs.neovim}/bin/nvim" else sessionEditor;

      piResources = import ../../nix/lib/pi-resources.nix {
        inherit pkgs;
        package = piCfg.package;
        settings = lib.recursiveUpdate piCfg.settings {
          lastChangelogVersion = piPackage.version;
        };
        stylix = {
          enable = piCfg.stylix.enable;
          colors = config.lib.stylix.colors;
        };
      };

      apiKeyFiles = lib.filter (file: file != null) (
        lib.mapAttrsToList (_: apiKey: apiKey.file) cfg.apiKeys
      );
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
            assertion = all (name: isValidPosixName name) (lib.attrNames cfg.apiKeys);
            message = "programs.roche-pi.jailed.apiKeys attribute names must be valid POSIX environment variable names.";
          }
          {
            assertion = all (file: hasPrefix "/" file) apiKeyFiles;
            message = "programs.roche-pi.jailed.apiKeys.<name>.file values must be absolute paths.";
          }
          {
            assertion = (gitUserName == null) == (gitUserEmail == null);
            message = "Jailed Pi git identity requires both programs.git.settings.user.name and programs.git.settings.user.email.";
          }
        ];

        home.activation.jailedPiAgentDir = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
          agent_dir=${lib.escapeShellArg cfg.agentDir}

          mkdir -p ${lib.escapeShellArg homeDir}/.pi/agent/sessions
          touch ${lib.escapeShellArg homeDir}/.pi/agent/auth.json

          mkdir -p "$agent_dir"

          ln -sfnT ${piResources.package}/AGENTS.md "$agent_dir/AGENTS.md"
          ln -sfnT ${piResources.package}/settings.json "$agent_dir/settings.json"
          ln -sfnT ${piResources.package}/agent-teams "$agent_dir/agent-teams"
          ln -sfnT ${piResources.package}/agents "$agent_dir/agents"
          ln -sfnT ${piResources.package}/extensions "$agent_dir/extensions"
          ln -sfnT ${piResources.package}/node_modules "$agent_dir/node_modules"
          ln -sfnT ${piResources.package}/skills "$agent_dir/skills"
          ln -sfnT ${piResources.package}/themes "$agent_dir/themes"
          ln -sfnT ${lib.escapeShellArg homeDir}/.pi/agent/auth.json "$agent_dir/auth.json"
          ln -sfnT ${lib.escapeShellArg homeDir}/.pi/agent/sessions "$agent_dir/sessions"
        '';

        home.packages = [
          (self.lib.${pkgs.system}.mkJailedPi {
            name = cfg.packageName;
            agentConfigPackage = piResources.package;
            defaultAgentDir = cfg.agentDir;
            apiKeys = cfg.apiKeys;
            inherit piPackage;
            editor = cfg.editor;
            inherit gitUserName gitUserEmail;
            docker = cfg.docker;
            podman = cfg.podman;
            extraPkgs = cfg.extraPkgs ++ optional (editorPackage != null) editorPackage;
            runtimeClosurePkgs = [ piResources.package ];
            extraPermissions = cfg.extraPermissions;
          })
        ];
      };
    };
in
{
  flake.homeModules."jailed-pi" = jailedPiModule;
}
