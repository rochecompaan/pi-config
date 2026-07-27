{ inputs, self, ... }:
{
  perSystem =
    {
      pkgs,
      self',
      system,
      ...
    }:
    let
      homePkgs = import inputs.nixpkgs {
        inherit system;
        config.allowUnfreePredicate = package: pkgs.lib.getName package == "1password-cli";
      };

      mkHome =
        {
          packageName,
          inheritGitIdentity ? null,
        }:
        inputs.home-manager.lib.homeManagerConfiguration {
          pkgs = homePkgs;
          modules = [
            self.homeModules.pi
            self.homeModules."jailed-pi"
            {
              home.username = "jailed-pi-git-identity-test";
              home.homeDirectory = "/home/jailed-pi-git-identity-test";
              home.stateVersion = "25.11";

              programs.git = {
                enable = true;
                settings.user = {
                  name = "Home Manager Embedded Name";
                  email = "home-manager-embedded@example.com";
                };
              };

              programs.roche-pi = {
                enable = true;
                installNotionCli = false;
                jailed = {
                  enable = true;
                  inherit packageName;
                }
                // pkgs.lib.optionalAttrs (inheritGitIdentity != null) {
                  inherit inheritGitIdentity;
                };
              };
            }
          ];
        };

      defaultHome = mkHome { packageName = "jailed-pi-git-home-default-test"; };
      disabledHome = mkHome {
        packageName = "jailed-pi-git-home-disabled-test";
        inheritGitIdentity = false;
      };

      findHomePackage =
        packageName: home:
        let
          matches = builtins.filter (
            package: pkgs.lib.getName package == packageName
          ) home.config.home.packages;
        in
        assert pkgs.lib.assertMsg (
          builtins.length matches == 1
        ) "expected one Home Manager package named ${packageName}";
        builtins.head matches;

      defaultJailed = findHomePackage "jailed-pi-git-home-default-test" defaultHome;
      disabledJailed = findHomePackage "jailed-pi-git-home-disabled-test" disabledHome;
    in
    {
      checks."jailed-pi-git-identity-home" =
        assert defaultHome.config.programs.roche-pi.jailed.inheritGitIdentity;
        assert !disabledHome.config.programs.roche-pi.jailed.inheritGitIdentity;
        pkgs.runCommand "jailed-pi-git-identity-home-check" { } ''
          set -eu

          launcher_for() {
            find "$1/bin" -maxdepth 1 -type f -print -quit
          }

          sandbox_launcher_for() {
            launcher="$(launcher_for "$1")"
            sed -n 's|^exec \(/nix/store/[^ ]*-sandbox/bin/[^ ]*\) .*|\1|p' "$launcher"
          }

          default_launcher="$(launcher_for ${defaultJailed})"
          disabled_launcher="$(launcher_for ${disabledJailed})"
          default_sandbox="$(sandbox_launcher_for ${defaultJailed})"
          disabled_sandbox="$(sandbox_launcher_for ${disabledJailed})"

          grep -F "config --includes --get user.name" "$default_launcher" >/dev/null
          if grep -F "config --includes --get user.name" "$disabled_launcher" >/dev/null; then
            echo "disabled Home Manager wrapper unexpectedly resolves host identity" >&2
            exit 1
          fi

          for file in "$default_launcher" "$disabled_launcher" "$default_sandbox" "$disabled_sandbox"; do
            if grep -F "Home Manager Embedded Name" "$file" >/dev/null; then
              echo "Home Manager identity was embedded in $file" >&2
              exit 1
            fi
            if grep -F "home-manager-embedded@example.com" "$file" >/dev/null; then
              echo "Home Manager email was embedded in $file" >&2
              exit 1
            fi
          done

          grep -F '$HOME/.config/git' "$default_sandbox" >/dev/null
          grep -F '$HOME/.config/git' "$disabled_sandbox" >/dev/null
          test -x ${defaultHome.activationPackage}/activate
          test -x ${disabledHome.activationPackage}/activate

          touch "$out"
        '';
    };
}
