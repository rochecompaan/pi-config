{ ... }:
{
  perSystem = { pkgs, self', ... }:
    let
      piDeps = import ../../nix/packages/pi-deps.nix {
        inherit pkgs;
        piRemote = self'.packages.pi-remote;
      };
    in {
      packages.den-bundle = import ../../nix/packages/den-bundle.nix {
        inherit pkgs piDeps;
        piConfig = self'.packages.pi-config;
      };
    };
}
