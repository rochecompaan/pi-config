{ inputs, ... }:
{
  perSystem =
    { pkgs, system, ... }:
    let
      inherit (pkgs) lib;

      commonPkgsBase = with pkgs; [
        bashInteractive
        coreutils
        curl
        diffutils
        findutils
        gawkInteractive
        gnugrep
        gnused
        gnutar
        gzip
        jq
        pre-commit
        procps
        ripgrep
        unzip
        wget
        which
      ];

      normalizeApiKey =
        name: value:
        assert lib.isValidPosixName name;
        let
          file = value.file or null;
          requestedFromEnv = value.fromEnv or null;
          fromEnv = if requestedFromEnv == null then file == null else requestedFromEnv;
        in
        {
          inherit file fromEnv;
        };

      mkApiKeyExports =
        apiKeys:
        lib.concatStringsSep "\n" (
          lib.mapAttrsToList (
            name: value:
            lib.optionalString (value.file != null) ''
              ${name}="$(${pkgs.coreutils}/bin/cat ${lib.escapeShellArg value.file})"
              export ${name}
            ''
          ) apiKeys
        );
    in
    {
      lib.mkJailedPi =
        {
          name ? "jailed-pi",
          piPackage ? inputs.llm-agents.packages.${system}.pi,
          agentConfigPackage,
          defaultAgentDir ? "$HOME/.pi/agent-jailed",
          apiKeys ? { },
          editor ? "vi",
          gitUserName ? null,
          gitUserEmail ? null,
          extraPkgs ? [ ],
          runtimeClosurePkgs ? [ agentConfigPackage ],
          extraPermissions ? [ ],
        }:
        assert (gitUserName == null) == (gitUserEmail == null);
        let
          normalizedApiKeys = lib.mapAttrs normalizeApiKey apiKeys;
          apiKeyNames = lib.attrNames normalizedApiKeys;
          apiKeyFiles = lib.filter (file: file != null) (
            map (apiKeyName: normalizedApiKeys.${apiKeyName}.file) apiKeyNames
          );
          forwardedApiKeyNames = lib.filter (apiKeyName: normalizedApiKeys.${apiKeyName}.fromEnv) apiKeyNames;

          jail = inputs.jail-nix.lib.extend {
            inherit pkgs;
            additionalCombinators =
              combinators: with combinators; {
                git-identity-env = compose [
                  (set-env "GIT_CONFIG_COUNT" "2")
                  (set-env "GIT_CONFIG_KEY_0" "user.name")
                  (set-env "GIT_CONFIG_VALUE_0" gitUserName)
                  (set-env "GIT_CONFIG_KEY_1" "user.email")
                  (set-env "GIT_CONFIG_VALUE_1" gitUserEmail)
                ];

                runtime-closures =
                  packages: state:
                  state
                  // {
                    additionalRuntimeClosures = state.additionalRuntimeClosures ++ map toString packages;
                  };
              };
          };

          piRuntime = pkgs.writeShellApplication {
            name = "pi";
            runtimeInputs = [ pkgs.coreutils ];
            text = ''
              set -euo pipefail

              ${mkApiKeyExports normalizedApiKeys}

              exec ${lib.getExe piPackage} "$@"
            '';
          };

          sandbox = jail "${name}-sandbox" piRuntime (
            with jail.combinators;
            [
              network
              time-zone
              no-new-session
              mount-cwd
              (readwrite (noescape ''"$PI_CODING_AGENT_DIR"''))
              (try-readwrite (noescape ''"$HOME/.pi/agent/auth.json"''))
              (try-readwrite (noescape ''"$HOME/.pi/agent/sessions"''))
              (readonly "${agentConfigPackage}")
              (try-fwd-env "EDITOR")
              (try-fwd-env "GIT_EDITOR")
              (try-fwd-env "VISUAL")
              (try-fwd-env "PI_CODING_AGENT_DIR")
            ]
            ++ map (file: readonly file) apiKeyFiles
            ++ map try-fwd-env forwardedApiKeyNames
            ++ lib.optionals (gitUserName != null) [ git-identity-env ]
            ++ lib.optionals (runtimeClosurePkgs != [ ]) [ (runtime-closures runtimeClosurePkgs) ]
            ++ extraPermissions
            ++ [ (add-pkg-deps (commonPkgsBase ++ [ pkgs.git ] ++ extraPkgs)) ]
          );
        in
        pkgs.writeShellApplication {
          inherit name;
          runtimeInputs = [ pkgs.coreutils ];
          text = ''
            export EDITOR="''${EDITOR:-${editor}}"
            export GIT_EDITOR="''${GIT_EDITOR:-$EDITOR}"
            export VISUAL="''${VISUAL:-$EDITOR}"
            export PI_CODING_AGENT_DIR="''${PI_CODING_AGENT_DIR:-${defaultAgentDir}}"
            exec ${lib.getExe sandbox} "$@"
          '';
        };
    };
}
