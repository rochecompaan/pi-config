{ ... }:
{
  perSystem =
    { pkgs, self', ... }:
    let
      piLocalAuth = pkgs.writeShellApplication {
        name = "pi-local-auth";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.gnugrep
          pkgs.jq
        ];
        text = ''
          export PI_LOCAL_AUTH_SETTINGS_TEMPLATE=${self'.packages.pi-config}/settings.json
          # shellcheck disable=SC1091
          source ${../../scripts/pi-local-auth.sh}
        '';
      };
    in
    {
      packages."pi-local-auth" = piLocalAuth;

      checks."pi-local-auth" =
        pkgs.runCommand "pi-local-auth-check" { nativeBuildInputs = [ pkgs.jq ]; }
          ''
            export PI_LOCAL_AUTH_BIN=${piLocalAuth}/bin/pi-local-auth
            # shellcheck disable=SC1091
            source ${../../scripts/pi-local-auth-check.sh}
          '';
    };
}
