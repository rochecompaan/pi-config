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
          jailedPi ? {
            enable = false;
            agentDir = ".pi/agent-jailed";
          },
        }:
        let
          jailedPiCfg = {
            enable = false;
            agentDir = ".pi/agent-jailed";
          }
          // jailedPi;

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
          cat > .pi/settings.json <<'EOF'
          ${builtins.toJSON settings}
          EOF
          ${pkgs.lib.optionalString jailedPiCfg.enable ''
            agent_dir=${pkgs.lib.escapeShellArg jailedPiCfg.agentDir}
            mkdir -p "$agent_dir"
            mkdir -p "$HOME/.pi/agent/sessions"
            touch "$HOME/.pi/agent/auth.json"

            ln -sfnT ${piConfigPackage}/AGENTS.md "$agent_dir/AGENTS.md"
            ln -sfnT ${piConfigPackage}/settings.json "$agent_dir/settings.json"
            ln -sfnT ${piConfigPackage}/mcp.json "$agent_dir/mcp.json"
            ln -sfnT ${piConfigPackage}/agents "$agent_dir/agents"
            ln -sfnT ${piConfigPackage}/extensions "$agent_dir/extensions"
            ln -sfnT ${piConfigPackage}/multi-model-planning-teams "$agent_dir/multi-model-planning-teams"
            ln -sfnT ${piConfigPackage}/node_modules "$agent_dir/node_modules"
            ln -sfnT ${piConfigPackage}/skills "$agent_dir/skills"
            ln -sfnT ${piConfigPackage}/themes "$agent_dir/themes"
            ln -sfn "$HOME/.pi/agent/auth.json" "$agent_dir/auth.json"
            ln -sfn "$HOME/.pi/agent/sessions" "$agent_dir/sessions"

            case "$agent_dir" in
              /*) export PI_CODING_AGENT_DIR="$agent_dir" ;;
              *) export PI_CODING_AGENT_DIR="$PWD/$agent_dir" ;;
            esac
          ''}
        '';
    };
}
