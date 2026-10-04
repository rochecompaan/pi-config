{
  pkgs,
  catalog,
  overrides ? { },
}:
let
  defaults = import ./loadout-presets.nix;
  config = pkgs.lib.recursiveUpdate defaults overrides;
  configJson = pkgs.writeText "pi-loadout-config.json" (builtins.toJSON config);
in
pkgs.runCommand "pi-loadout-files"
  {
    nativeBuildInputs = [ pkgs.python3 ];
  }
  ''
    python ${./loadout_presets.py} render ${catalog} ${configJson} "$out"
  ''
