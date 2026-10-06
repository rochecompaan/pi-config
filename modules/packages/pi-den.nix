{ inputs, ... }:
{
  perSystem = { self', system, pkgs, ... }: {
    packages.pi-den = import ../../nix/packages/pi-den.nix {
      inherit pkgs;
      mkPi = inputs.den.lib.${system}.mkPi;
      piConfig = self'.packages.pi-config;
      denBundle = self'.packages.den-bundle;
      piVersion = "1.0.2";
      extraPkgs = [
        self'.packages.codegraph
        self'.packages.codegraph-viz
        self'.packages.notion-cli
      ];
    };
  };
}
