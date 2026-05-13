{ ... }:
{
  perSystem =
    { pkgs, self', ... }:
    let
      piConfigPackage = self'.packages.pi-config;
    in
    {
      lib.projectPiShellHook =
        {
          agentTeam ? null,
          extraSettings ? { },
        }:
        let
          settings = pkgs.lib.recursiveUpdate (
            {
              packages = [ "${piConfigPackage}" ];
            }
            // pkgs.lib.optionalAttrs (agentTeam != null) {
              activeAgentTeam = agentTeam;
            }
          ) extraSettings;
        in
        ''
          mkdir -p .pi
          ln -sfn ${piConfigPackage}/agents .pi/agents
          ln -sfn ${piConfigPackage}/agent-teams .pi/agent-teams
          cat > .pi/settings.json <<'EOF'
          ${builtins.toJSON settings}
          EOF
        '';
    };
}
