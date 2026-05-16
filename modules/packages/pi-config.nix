{ inputs, ... }:
{
  perSystem =
    {
      pkgs,
      self',
      system,
      ...
    }:
    let
      piRemote = self'.packages."pi-remote";
      piPackage = inputs.llm-agents.packages.${system}.pi;

      piDeps = import ../../nix/packages/pi-deps.nix {
        inherit pkgs piRemote;
      };

      settingsLib = import ../../nix/lib/settings.nix {
        inherit (pkgs) lib;
      };

      themeLib = import ../../nix/lib/theme.nix { };

      baseSettings = builtins.fromJSON (builtins.readFile ../../settings.json);

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
        settingsOverrides = {
          lastChangelogVersion = piPackage.version;
        };
      };

      stylixTheme = themeLib.mkStylixTheme fallbackPalette;

      settingsJson = pkgs.writeText "settings.json" (builtins.toJSON settings);
      stylixJson = pkgs.writeText "stylix.json" (builtins.toJSON stylixTheme);

      piConfig = pkgs.runCommand "pi-config" { } ''
        mkdir -p "$out" "$out/node_modules"

        cp ${../../package.json} "$out/package.json"
        cp ${../../.npmignore} "$out/.npmignore"
        cp ${../../AGENTS.md} "$out/AGENTS.md"
        cp ${settingsJson} "$out/settings.json"

        cp -r ${../../extensions} "$out/extensions"
        cp -r ${../../skills} "$out/skills"
        cp -r ${../../themes} "$out/themes"
        cp -r ${../../agents} "$out/agents"
        cp -r ${../../agent-teams} "$out/agent-teams"

        chmod u+w "$out/themes"
        cp ${stylixJson} "$out/themes/stylix.json"

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
