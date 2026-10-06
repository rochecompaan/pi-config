{ inputs, ... }:
{
  perSystem = { pkgs, self', system, ... }:
    let
      claude = inputs.den.lib.${system}.mkClaude {
        bundles = [ self'.packages.den-bundle ];
      };
      piDeps = import ../../nix/packages/pi-deps.nix {
        inherit pkgs;
        piRemote = self'.packages.pi-remote;
      };
    in {
      checks.den-bundle-claude = import ../../nix/check-support/den-bundle-claude.nix {
        inherit pkgs claude piDeps;
        bundle = self'.packages.den-bundle;
        piConfig = self'.packages.pi-config;
      };
      checks.pi-den-runtime = import ../../nix/check-support/pi-den-runtime.nix {
        inherit pkgs;
        piDen = self'.packages.pi-den;
        piConfig = self'.packages.pi-config;
        probeExtension = ../../nix/check-support/pi-skillset-probe.ts;
        bootstrapProbe = ../../nix/check-support/pi-bootstrap-probe.ts;
      };
    };
}
