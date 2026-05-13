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
          includePackage ? false,
        }:
        let
          settings = pkgs.lib.recursiveUpdate (
            { }
            // pkgs.lib.optionalAttrs includePackage {
              packages = [ "${piConfigPackage}" ];
            }
            // pkgs.lib.optionalAttrs (agentTeam != null) {
              activeAgentTeam = agentTeam;
            }
          ) extraSettings;
        in
        ''
          mkdir -p .pi
          ln -sfnT ${piConfigPackage}/agents .pi/agents
          ln -sfnT ${piConfigPackage}/agent-teams .pi/agent-teams
          cat > .pi/settings.json <<'EOF'
          ${builtins.toJSON settings}
          EOF
        '';
    };
}
