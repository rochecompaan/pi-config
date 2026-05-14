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
      themeLib = import ../../nix/lib/theme.nix { };
      jsonFormat = pkgs.formats.json { };

      settingsOverridesJson = builtins.toJSON cfg.settings;

      settingsJsonSource =
        pkgs.runCommand "roche-pi-settings.json"
          {
            nativeBuildInputs = [ pkgs.python3 ];
            packageSettingsPath = "${cfg.package}/settings.json";
            inherit settingsOverridesJson;
          }
          ''
            python - <<'PY' > "$out"
            import json
            import os

            with open(os.environ["packageSettingsPath"], "r", encoding="utf-8") as f:
                settings = json.load(f)

            overrides = json.loads(os.environ["settingsOverridesJson"])

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

      stylixJsonSource = pkgs.writeText "stylix.json" (
        builtins.toJSON (themeLib.mkStylixTheme config.lib.stylix.colors)
      );

      themesSource =
        if cfg.stylix.enable then
          pkgs.runCommand "roche-pi-themes"
            {
              baseThemes = "${cfg.package}/themes";
              inherit stylixJsonSource;
            }
            ''
              mkdir -p "$out"
              cp -rT "$baseThemes" "$out"
              chmod -R u+w "$out"
              cp -f "$stylixJsonSource" "$out/stylix.json"
            ''
        else
          "${cfg.package}/themes";

      intervalsExtensionsTarget =
        if cfg.intervals.package != null then
          "${cfg.intervals.package}/extensions/pi-intervals"
        else
          cfg.intervals.path;

      intervalsSkillsTarget =
        if cfg.intervals.package != null then
          "${cfg.intervals.package}/skills/intervals-time-entries"
        else
          "${cfg.intervals.path}/skills/intervals-time-entries";

      extensionsSource =
        if cfg.intervals.enable then
          pkgs.runCommand "roche-pi-extensions"
            {
              baseExtensions = "${cfg.package}/extensions";
              intervalsExtensionsTarget = intervalsExtensionsTarget;
            }
            ''
              mkdir -p "$out"
              cp -rT "$baseExtensions" "$out"
              ln -s "$intervalsExtensionsTarget" "$out/pi-intervals"
            ''
        else
          "${cfg.package}/extensions";

      skillsSource =
        if cfg.intervals.enable then
          pkgs.runCommand "roche-pi-skills"
            {
              baseSkills = "${cfg.package}/skills";
              intervalsSkillsTarget = intervalsSkillsTarget;
            }
            ''
              mkdir -p "$out"
              cp -rT "$baseSkills" "$out"
              ln -s "$intervalsSkillsTarget" "$out/intervals-time-entries"
            ''
        else
          "${cfg.package}/skills";
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
          ".pi/agent/AGENTS.md".source = "${cfg.package}/AGENTS.md";
          ".pi/agent/settings.json" = {
            force = true;
            source = settingsJsonSource;
          };
          ".pi/agent/extensions".source = extensionsSource;
          ".pi/agent/agent-teams".source = "${cfg.package}/agent-teams";
          ".pi/agent/agents".source = "${cfg.package}/agents";
          ".pi/agent/skills".source = skillsSource;
          ".pi/agent/themes".source = themesSource;
          ".pi/agent/node_modules".source = "${cfg.package}/node_modules";
          ".pi/dashboard/config.json".text = dashboardConfigJson;
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
