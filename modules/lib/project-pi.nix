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
          extraSettings ? { },
          includePackage ? false,
        }:
        let
          settings = pkgs.lib.recursiveUpdate (
            { }
            // pkgs.lib.optionalAttrs includePackage {
              packages = [ "${piConfigPackage}" ];
            }
          ) extraSettings;
        in
        ''
          mkdir -p .pi
          ln -sfnT ${piConfigPackage}/agents .pi/agents
          ln -sfnT ${piConfigPackage}/multi-model-planning-teams .pi/multi-model-planning-teams
          ln -sfnT ${piConfigPackage}/mcp.json .pi/mcp.json
          ln -sfnT ${piConfigPackage}/claude-bridge.json .pi/claude-bridge.json
          cat > .pi/settings.json <<'EOF'
          ${builtins.toJSON settings}
          EOF
        '';
    };
}
