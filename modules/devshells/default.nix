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
          pkgs.git
          pkgs.jq
          pkgs.nixfmt-rfc-style
        ];

        shellHook = config.lib.projectPiShellHook {
          agentTeam = "openai-only";
        };
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
          agentTeam = "openai-only";
          jailedPi.enable = true;
        };
      };

      formatter = pkgs.nixfmt-rfc-style;
    };
}
