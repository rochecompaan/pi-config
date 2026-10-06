{ inputs, ... }:
{
  perSystem = { pkgs, self', system, ... }:
    let
      claude = inputs.den.lib.${system}.mkClaude {
        bundles = [ self'.packages.den-bundle ];
      };
    in {
      checks.den-bundle-claude = import ../../nix/check-support/den-bundle-claude.nix {
        inherit pkgs claude;
        bundle = self'.packages.den-bundle;
      };
      checks.pi-den-runtime = import ../../nix/check-support/pi-den-runtime.nix {
        inherit pkgs;
        piDen = self'.packages.pi-den;
        piConfig = self'.packages.pi-config;
        bundle = self'.packages.den-bundle;
        probeExtension = ../../nix/check-support/pi-skillset-probe.ts;
        bootstrapProbe = ../../nix/check-support/pi-bootstrap-probe.ts;
      };
    };
}
