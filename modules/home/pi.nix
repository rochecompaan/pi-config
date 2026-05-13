{ self, lib, ... }:
let
  inherit (lib)
    mkEnableOption
    mkMerge
    mkOption
    mkIf
    optional
    optionalAttrs
    types
    ;

  piModule =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.programs."roche-pi";
      settingsLib = import ../../nix/lib/settings.nix { inherit lib; };
      themeLib = import ../../nix/lib/theme.nix { };

      intervalsPackagePath =
        if !cfg.intervals.enable then
          null
        else if cfg.intervals.package != null then
          toString cfg.intervals.package
        else
          cfg.intervals.path;

      settingsOverridesJson = builtins.toJSON cfg.settings;

      settingsJsonSource =
        pkgs.runCommand "roche-pi-settings.json"
          {
            nativeBuildInputs = [ pkgs.python3 ];
            packageSettingsPath = "${cfg.package}/settings.json";
            inherit settingsOverridesJson;
            intervalsPackagePath = if intervalsPackagePath == null then "" else intervalsPackagePath;
          }
          ''
            python - <<'PY' > "$out"
            import json
            import os

            with open(os.environ["packageSettingsPath"], "r", encoding="utf-8") as f:
                settings = json.load(f)

            overrides = json.loads(os.environ["settingsOverridesJson"])
            intervals_package_path = os.environ["intervalsPackagePath"]

            if intervals_package_path:
                settings["packages"] = settings.get("packages", []) + [intervals_package_path]

            def recursive_update(base, override):
                if isinstance(base, dict) and isinstance(override, dict):
                    merged = dict(base)
                    for key, value in override.items():
                        merged[key] = recursive_update(base.get(key), value)
                    return merged
                return override

            json.dump(recursive_update(settings, overrides), os.fdopen(1, "w", encoding="utf-8"), separators=(",", ":"))
            PY
          '';

      dashboardConfigJson = builtins.toJSON {
        port = 18765;
        piPort = 18766;
        tunnel.enabled = false;
      };

      stylixJson = builtins.toJSON (themeLib.mkStylixTheme config.lib.stylix.colors);

      intervalsFiles =
        if cfg.intervals.package != null then
          {
            ".pi/agent/extensions/pi-intervals".source = "${cfg.intervals.package}/extensions/pi-intervals";
            ".pi/agent/skills/intervals-time-entries".source =
              "${cfg.intervals.package}/skills/intervals-time-entries";
          }
        else
          {
            ".pi/agent/extensions/pi-intervals".source =
              config.lib.file.mkOutOfStoreSymlink "${cfg.intervals.path}/extensions/pi-intervals";
            ".pi/agent/skills/intervals-time-entries".source =
              config.lib.file.mkOutOfStoreSymlink "${cfg.intervals.path}/skills/intervals-time-entries";
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
          type = types.attrs;
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
        ];

        home.packages = optional cfg.installNotionCli self.packages.${pkgs.system}.notion-cli;

        home.file = mkMerge [
          {
            ".pi/agent/AGENTS.md".source = "${cfg.package}/AGENTS.md";
            ".pi/agent/settings.json" = {
              force = true;
              source = settingsJsonSource;
            };
            ".pi/agent/extensions".source = "${cfg.package}/extensions";
            ".pi/agent/agent-teams".source = "${cfg.package}/agent-teams";
            ".pi/agent/agents".source = "${cfg.package}/agents";
            ".pi/agent/skills".source = "${cfg.package}/skills";
            ".pi/agent/node_modules".source = "${cfg.package}/node_modules";
            ".pi/dashboard/config.json".text = dashboardConfigJson;
          }
          (optionalAttrs cfg.stylix.enable {
            ".pi/agent/themes/stylix.json" = {
              force = true;
              text = stylixJson;
            };
          })
          (optionalAttrs cfg.intervals.enable intervalsFiles)
        ];
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
