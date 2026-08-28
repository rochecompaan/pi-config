{
  self,
  lib,
  ...
}:
let
  inherit (lib)
    mkEnableOption
    mkOption
    mkIf
    optional
    types
    ;

  piModule =
    {
      config,
      pkgs,
      ...
    }:
    let
      cfg = config.programs."roche-pi";
      jsonFormat = pkgs.formats.json { };

      piResources = import ../../nix/lib/pi-resources.nix {
        inherit pkgs;
        package = cfg.package;
        settings = cfg.settings;
        stylix = {
          enable = cfg.stylix.enable;
          colors = config.lib.stylix.colors;
        };
      };
    in
    {
      options.programs."roche-pi" = {
        enable = mkEnableOption "the Roche Pi Home Manager module";

        package = mkOption {
          type = types.package;
          default = self.packages.${pkgs.system}.pi-config;
        };

        installNotionCli = mkOption {
          type = types.bool;
          default = true;
        };

        installCodegraphCli = mkOption {
          type = types.bool;
          default = true;
          description = "Whether to install the CodeGraph CLI used by the pi-codegraph extension.";
        };

        installCodegraphViz = mkOption {
          type = types.bool;
          default = true;
          description = "Whether to install the codegraph-viz graph HTML renderer.";
        };

        settings = mkOption {
          type = jsonFormat.type;
          default = { };
        };

        stylix.enable = mkOption {
          type = types.bool;
          default = false;
        };
      };

      config = mkIf cfg.enable {
        home.packages = [
          self.packages.${pkgs.system}.pi
          self.packages.${pkgs.system}.pi-matt
        ]
        ++ optional cfg.installNotionCli self.packages.${pkgs.system}.notion-cli
        ++ optional cfg.installCodegraphCli self.packages.${pkgs.system}.codegraph
        ++ optional cfg.installCodegraphViz self.packages.${pkgs.system}.codegraph-viz;

        home.file = {
          ".pi/agent/AGENTS.md".source = piResources.agentsMd;
          ".pi/agent/settings.json" = {
            force = true;
            source = piResources.settingsJson;
          };
          ".pi/agent/mcp.json" = {
            force = true;
            source = piResources.mcpJson;
          };
          ".pi/agent/claude-bridge.json" = {
            force = true;
            source = piResources.claudeBridgeJson;
          };
          ".pi/agent/extensions".source = piResources.extensions;
          ".pi/agent/agents".source = piResources.agents;
          ".pi/agent/multi-model-planning-teams".source = piResources.multiModelPlanningTeams;
          ".pi/agent/profiles/pi-subagents".source = piResources.subagentProfiles;
          ".pi/agent/skills".source = piResources.skills;
          ".pi/agent/themes".source = piResources.themes;
          ".pi/agent/node_modules".source = piResources.nodeModules;
          ".pi/dashboard/config.json".text = piResources.dashboardConfigJson;
        };
      };
    };
in
{
  flake = {
    homeModules = {
      pi = piModule;
      default = self.homeModules.pi;
    };
  };
}
