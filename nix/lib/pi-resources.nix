{
  pkgs,
  package,
  settings ? { },
  stylix ? {
    enable = false;
    colors = null;
  },
}:
let
  themeLib = import ./theme.nix { };

  settingsOverridesJson = builtins.toJSON settings;

  settingsJson =
    pkgs.runCommand "roche-pi-settings.json"
      {
        nativeBuildInputs = [ pkgs.python3 ];
        packageSettingsPath = "${package}/settings.json";
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

  stylixJson = pkgs.writeText "stylix.json" (builtins.toJSON (themeLib.mkStylixTheme stylix.colors));

  themes =
    if stylix.enable then
      pkgs.runCommand "roche-pi-themes"
        {
          baseThemes = "${package}/themes";
          inherit stylixJson;
        }
        ''
          mkdir -p "$out"
          cp -rT "$baseThemes" "$out"
          chmod -R u+w "$out"
          cp -f "$stylixJson" "$out/stylix.json"
        ''
    else
      "${package}/themes";

  extensions = "${package}/extensions";

  multiModelPlanningTeams = "${package}/multi-model-planning-teams";

  skills = "${package}/skills";

  mcpJson = "${package}/mcp.json";

  claudeBridgeJson = "${package}/claude-bridge.json";

  resourcesPackage = pkgs.runCommand "roche-pi-resources" { } ''
    mkdir -p "$out"
    ln -s ${package}/AGENTS.md "$out/AGENTS.md"
    ln -s ${settingsJson} "$out/settings.json"
    ln -s ${mcpJson} "$out/mcp.json"
    ln -s ${claudeBridgeJson} "$out/claude-bridge.json"
    ln -s ${extensions} "$out/extensions"
    ln -s ${package}/agents "$out/agents"
    ln -s ${multiModelPlanningTeams} "$out/multi-model-planning-teams"
    ln -s ${skills} "$out/skills"
    ln -s ${themes} "$out/themes"
    ln -s ${package}/node_modules "$out/node_modules"
  '';
in
{
  inherit
    claudeBridgeJson
    dashboardConfigJson
    extensions
    mcpJson
    multiModelPlanningTeams
    resourcesPackage
    settingsJson
    skills
    themes
    ;

  agents = "${package}/agents";
  agentsMd = "${package}/AGENTS.md";
  nodeModules = "${package}/node_modules";
  package = resourcesPackage;
}
