{ ... }:
{
  perSystem =
    { pkgs, self', ... }:
    let
      piRemote = self'.packages."pi-remote";

      piDeps = import ../../nix/packages/pi-deps.nix {
        inherit pkgs piRemote;
      };

      settingsLib = import ../../nix/lib/settings.nix {
        inherit (pkgs) lib;
      };

      themeLib = import ../../nix/lib/theme.nix { };

      baseSettings = builtins.fromJSON (builtins.readFile ../../resources/settings.json);

      fallbackPalette = {
        base00 = "282828";
        base01 = "3c3836";
        base02 = "504945";
        base03 = "665c54";
        base04 = "bdae93";
        base05 = "d5c4a1";
        base06 = "ebdbb2";
        base07 = "fbf1c7";
        base08 = "fb4934";
        base09 = "fe8019";
        base0A = "fabd2f";
        base0B = "b8bb26";
        base0C = "8ec07c";
        base0D = "83a598";
        base0E = "d3869b";
        base0F = "d65d0e";
      };

      settings = settingsLib.mkSettings {
        inherit baseSettings;
        inherit (piDeps) packagePaths;
        theme = "stylix";
      };

      stylixTheme = themeLib.mkStylixTheme fallbackPalette;

      settingsJson = pkgs.writeText "settings.json" (builtins.toJSON settings);
      stylixJson = pkgs.writeText "stylix.json" (builtins.toJSON stylixTheme);

      piConfig = pkgs.runCommand "pi-config" { } ''
        mkdir -p "$out/resources" "$out/node_modules"

        cp ${../../package.json} "$out/package.json"
        cp ${../../.npmignore} "$out/.npmignore"
        cp ${../../resources/AGENTS.md} "$out/AGENTS.md"
        cp ${settingsJson} "$out/settings.json"

        cp -r ${../../resources/extensions} "$out/resources/extensions"
        cp -r ${../../resources/skills} "$out/resources/skills"
        cp -r ${../../resources/themes} "$out/resources/themes"
        cp -r ${../../resources/agents} "$out/resources/agents"
        cp -r ${../../resources/agent-teams} "$out/resources/agent-teams"

        chmod u+w "$out/resources/themes"
        cp ${stylixJson} "$out/resources/themes/stylix.json"

        ln -s resources/extensions "$out/extensions"
        ln -s resources/skills "$out/skills"
        ln -s resources/themes "$out/themes"
        ln -s resources/agents "$out/agents"
        ln -s resources/agent-teams "$out/agent-teams"

        ln -s ${piDeps.nodeModulePaths.diff} "$out/node_modules/diff"
      '';
    in
    {
      packages = {
        "pi-config" = piConfig;
        default = piConfig;
      };

      checks."pi-config-build" = piConfig;
    };
}
