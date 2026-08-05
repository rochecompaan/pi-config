{ inputs, ... }:
{
  perSystem =
    {
      config,
      pkgs,
      self',
      system,
      ...
    }:
    {
      devShells.default = pkgs.mkShell {
        packages = [
          inputs.llm-agents.packages.${system}.pi
          self'.packages.codegraph
          self'.packages.codegraph-viz
          self'.packages.pi-local-auth
          pkgs.git
          pkgs.jq
          pkgs.nixfmt-rfc-style
        ];

        shellHook = config.lib.projectPiShellHook { };
      };

      devShells.jailed-pi = pkgs.mkShell {
        packages = [
          (config.lib.mkJailedPi {
            agentConfigPackage = self'.packages.pi-config;
            defaultAgentDir = "$PWD/.pi/agent-jailed";
            apiKeys = {
              OPENROUTER_API_KEY.fromEnv = true;
              ANTHROPIC_API_KEY.fromEnv = true;
            };
            extraPkgs = [
              self'.packages.codegraph
              self'.packages.codegraph-viz
              pkgs.git
              pkgs.jq
              pkgs.nixfmt-rfc-style
            ];
          })
          pkgs.git
          pkgs.jq
          pkgs.nixfmt-rfc-style
        ];

        shellHook = config.lib.projectPiShellHook {
          jailedPi.enable = true;
        };
      };

      formatter = pkgs.nixfmt-rfc-style;
    };
}
