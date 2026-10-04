{ ... }:
{
  perSystem =
    { pkgs, self', ... }:
    {
      checks.pi-loadout-runtime =
        pkgs.runCommand "pi-loadout-runtime-tests"
          {
            nativeBuildInputs = [ pkgs.python3 ];
            PI_LOADOUT_TEST_PI = "${self'.packages.pi}/bin/pi";
            PI_LOADOUT_TEST_CONFIG = self'.packages.pi-config;
            PI_LOADOUT_TEST_PROBE = ../../nix/check-support/pi-bootstrap-probe.ts;
          }
          ''
            python ${../../nix/check-support/loadout-runtime.test.py} -v
            touch "$out"
          '';

      checks.pi-loadout-presets =
        pkgs.runCommand "pi-loadout-presets-tests"
          {
            nativeBuildInputs = [ pkgs.python3 ];
          }
          ''
            mkdir -p nix/lib nix/check-support
            cp ${../../nix/lib/loadout_presets.py} nix/lib/loadout_presets.py
            cp ${../../nix/check-support/loadout-presets.test.py} nix/check-support/loadout-presets.test.py
            python nix/check-support/loadout-presets.test.py
            touch "$out"
          '';
    };
}
