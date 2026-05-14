{ self, lib, ... }:
let
  inherit (lib)
    hasPrefix
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
        intervals = {
          inherit (cfg.intervals) enable path package;
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

        settings = mkOption {
          type = jsonFormat.type;
          default = { };
        };

        stylix.enable = mkOption {
          type = types.bool;
          default = false;
        };

        intervals = {
          enable = mkOption {
            type = types.bool;
            default = false;
          };

          path = mkOption {
            type = types.nullOr types.str;
            default = null;
            description = "Absolute path to the local pi-intervals extension checkout (extension root).";
          };

          package = mkOption {
            type = types.nullOr types.package;
            default = null;
          };
        };
      };

      config = mkIf cfg.enable {
        assertions = [
          {
            assertion = !cfg.intervals.enable || cfg.intervals.path != null || cfg.intervals.package != null;
            message = "programs.roche-pi.intervals.enable requires either programs.roche-pi.intervals.path or programs.roche-pi.intervals.package.";
          }
          {
            assertion = cfg.intervals.path == null || hasPrefix "/" cfg.intervals.path;
            message = "programs.roche-pi.intervals.path must be null or an absolute path.";
          }
        ];

        home.packages = optional cfg.installNotionCli self.packages.${pkgs.system}.notion-cli;

        home.file = {
          ".pi/agent/AGENTS.md".source = piResources.agentsMd;
          ".pi/agent/settings.json" = {
            force = true;
            source = piResources.settingsJson;
          };
          ".pi/agent/extensions".source = piResources.extensions;
          ".pi/agent/agent-teams".source = piResources.agentTeams;
          ".pi/agent/agents".source = piResources.agents;
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
