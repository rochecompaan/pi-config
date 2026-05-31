{ ... }:
{
  perSystem =
    { pkgs, ... }:
    let
      piLocalAuth = pkgs.writeShellApplication {
        name = "pi-local-auth";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.gnugrep
        ];
        text = ''
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
