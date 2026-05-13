{ lib, flake-parts-lib, ... }:
let
  inherit (lib)
    mkOption
    types
    ;
in
{
  imports = [
    (flake-parts-lib.mkTransposedPerSystemModule {
      name = "lib";
      file = ./settings.nix;
      option = mkOption {
        type = types.lazyAttrsOf types.raw;
        default = { };
        description = "Per-system Pi library helpers.";
      };
    })
  ];

  perSystem =
    { pkgs, ... }:
    {
      lib.mkSettings = (import ../../nix/lib/settings.nix { lib = pkgs.lib; }).mkSettings;
    };
}
