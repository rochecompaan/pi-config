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
            authMode = "global";
          },
        }:
        let
          jailedPiCfg = {
            enable = false;
            agentDir = ".pi/agent-jailed";
            authMode = "global";
          }
          // jailedPi;

          authSetupLib = import ../../nix/lib/jailed-pi-auth.nix { lib = pkgs.lib; };
          authSetupScript = authSetupLib.mkAuthSetup {
            inherit (jailedPiCfg) authMode;
          };

          settings = pkgs.lib.recursiveUpdate (
            { }
            // pkgs.lib.optionalAttrs includePackage {
              packages = [ "${piConfigPackage}" ];
            }
          ) extraSettings;
        in
        assert pkgs.lib.assertMsg (builtins.elem jailedPiCfg.authMode [
          "global"
          "local"
        ]) "projectPiShellHook jailedPi.authMode must be either \"global\" or \"local\"";
        ''
          mkdir -p .pi
          ln -sfnT ${piConfigPackage}/agents .pi/agents
          ln -sfnT ${piConfigPackage}/multi-model-planning-teams .pi/multi-model-planning-teams
          ln -sfnT ${piConfigPackage}/mcp.json .pi/mcp.json
          ln -sfnT ${piConfigPackage}/claude-bridge.json .pi/claude-bridge.json
          cat > .pi/settings.json <<'EOF'
          ${builtins.toJSON settings}
          EOF
          ${pkgs.lib.optionalString jailedPiCfg.enable ''
            agent_dir=${pkgs.lib.escapeShellArg jailedPiCfg.agentDir}
            mkdir -p "$agent_dir"
            mkdir -p "$HOME/.pi/agent/sessions"

            ln -sfnT ${piConfigPackage}/AGENTS.md "$agent_dir/AGENTS.md"
            ln -sfnT ${piConfigPackage}/mcp.json "$agent_dir/mcp.json"
            ln -sfnT ${piConfigPackage}/claude-bridge.json "$agent_dir/claude-bridge.json"
            ln -sfnT ${piConfigPackage}/agents "$agent_dir/agents"
            ln -sfnT ${piConfigPackage}/extensions "$agent_dir/extensions"
            ln -sfnT ${piConfigPackage}/multi-model-planning-teams "$agent_dir/multi-model-planning-teams"
            ln -sfnT ${piConfigPackage}/node_modules "$agent_dir/node_modules"
            ln -sfnT ${piConfigPackage}/skills "$agent_dir/skills"
            ln -sfnT ${piConfigPackage}/themes "$agent_dir/themes"
            ${authSetupScript}
            ln -sfn "$HOME/.pi/agent/sessions" "$agent_dir/sessions"

            case "$agent_dir" in
              /*) export PI_CODING_AGENT_DIR="$agent_dir" ;;
              *) export PI_CODING_AGENT_DIR="$PWD/$agent_dir" ;;
            esac
          ''}
        '';
    };
}
