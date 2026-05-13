{ inputs, ... }:
{
  perSystem =
    {
      config,
      pkgs,
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

      formatter = pkgs.nixfmt-rfc-style;
    };
}
