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
      globalHook = pkgs.writeShellScript "jailed-pi-global-auth-hook" (
        self'.lib.projectPiShellHook {
          jailedPi = {
            enable = true;
            authMode = "global";
          };
        }
      );

      localHook = pkgs.writeShellScript "jailed-pi-local-auth-hook" (
        self'.lib.projectPiShellHook {
          jailedPi = {
            enable = true;
            authMode = "local";
          };
        }
      );

      fakePi = pkgs.writeShellApplication {
        name = "pi";
        text = ''
          exit 0
        '';
      };

      fakeAgentConfig = pkgs.runCommand "jailed-pi-auth-test-config" { } ''
        mkdir -p "$out"
      '';

      mkTestJailed =
        name: args:
        self'.lib.mkJailedPi (
          {
            inherit name;
            piPackage = fakePi;
            agentConfigPackage = fakeAgentConfig;
            extraPkgs = [ ];
            runtimeClosurePkgs = [ ];
          }
          // args
        );

      defaultJailed = mkTestJailed "jailed-pi-auth-default-test" { };
      globalJailed = mkTestJailed "jailed-pi-auth-global-test" { authMode = "global"; };
      localJailed = mkTestJailed "jailed-pi-auth-local-test" { authMode = "local"; };
      invalidBuilder = builtins.tryEval (
        mkTestJailed "jailed-pi-auth-invalid-test" { authMode = "invalid"; }
      );

      mkHome =
        {
          packageName,
          authMode ? null,
        }:
        inputs.home-manager.lib.homeManagerConfiguration {
          pkgs = homePkgs;
          modules = [
            self.homeModules.pi
            self.homeModules."jailed-pi"
            {
              home.username = "jailed-pi-auth-test";
              home.homeDirectory = "/home/jailed-pi-auth-test";
              home.stateVersion = "25.11";

              programs.roche-pi = {
                enable = true;
                installNotionCli = false;
                jailed = {
                  enable = true;
                  inherit packageName;
                }
                // pkgs.lib.optionalAttrs (authMode != null) { inherit authMode; };
              };
            }
          ];
        };

      defaultHome = mkHome { packageName = "jailed-pi-home-default-test"; };
      localHome = mkHome {
        packageName = "jailed-pi-home-local-test";
        authMode = "local";
      };
      invalidHome = builtins.tryEval (
        (mkHome {
          packageName = "jailed-pi-home-invalid-test";
          authMode = "invalid";
        }).config.programs.roche-pi.jailed.authMode
      );

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

      defaultHomeJailed = findHomePackage "jailed-pi-home-default-test" defaultHome;
      localHomeJailed = findHomePackage "jailed-pi-home-local-test" localHome;

      invalidProjectHook = builtins.tryEval (
        self'.lib.projectPiShellHook {
          jailedPi = {
            enable = true;
            authMode = "invalid";
          };
        }
      );
    in
    {
      checks."jailed-pi-auth-mode" =
        assert !invalidProjectHook.success;
        assert !invalidBuilder.success;
        assert defaultHome.config.programs.roche-pi.jailed.authMode == "global";
        assert localHome.config.programs.roche-pi.jailed.authMode == "local";
        assert !invalidHome.success;
        pkgs.runCommand "jailed-pi-auth-mode-check" { } ''
          set -eu

          sandbox_launcher_for() {
            package="$1"
            for launcher in "$package"/bin/*; do
              sandbox_launcher="$(sed -n 's|^exec \(/nix/store/[^ ]*-sandbox/bin/[^ ]*\) .*|\1|p' "$launcher")"
              if [ -n "$sandbox_launcher" ]; then
                printf '%s\n' "$sandbox_launcher"
                return 0
              fi
            done

            echo "could not locate sandbox launcher for $package" >&2
            return 1
          }

          assert_contains_global_auth() {
            package="$1"
            sandbox_launcher="$(sandbox_launcher_for "$package")"
            if ! grep -F -- '$HOME/.pi/agent/auth.json' "$sandbox_launcher" >/dev/null; then
              echo "expected $package to contain the global auth permission" >&2
              exit 1
            fi
          }

          assert_omits_global_auth() {
            package="$1"
            sandbox_launcher="$(sandbox_launcher_for "$package")"
            if grep -F -- '$HOME/.pi/agent/auth.json' "$sandbox_launcher" >/dev/null; then
              echo "expected $package to omit the global auth permission" >&2
              exit 1
            fi
          }

          assert_contains_global_auth ${defaultJailed}
          assert_contains_global_auth ${globalJailed}
          assert_omits_global_auth ${localJailed}
          assert_contains_global_auth ${defaultHomeJailed}
          assert_omits_global_auth ${localHomeJailed}
          test -x ${defaultHome.activationPackage}/activate
          test -x ${localHome.activationPackage}/activate

          run_hook() {
            hook="$1"
            test_home="$2"
            test_repo="$3"

            mkdir -p "$test_home" "$test_repo"
            (
              export HOME="$test_home"
              cd "$test_repo"
              "$hook"
            )
          }

          assert_link_target() {
            path="$1"
            expected="$2"
            test -L "$path"
            actual="$(readlink "$path")"
            if [ "$actual" != "$expected" ]; then
              echo "expected $path -> $expected, got $actual" >&2
              exit 1
            fi
          }

          global_home="$TMPDIR/global-home"
          global_repo="$TMPDIR/global-repo"
          run_hook ${globalHook} "$global_home" "$global_repo"
          global_agent="$global_repo/.pi/agent-jailed"
          global_auth="$global_home/.pi/agent/auth.json"
          assert_link_target "$global_agent/auth.json" "$global_auth"
          assert_link_target "$global_agent/sessions" "$global_home/.pi/agent/sessions"

          printf '%s\n' 'global-secret' > "$global_auth"
          run_hook ${globalHook} "$global_home" "$global_repo"
          grep -Fx 'global-secret' "$global_auth"

          regular_home="$TMPDIR/regular-home"
          regular_repo="$TMPDIR/regular-repo"
          mkdir -p "$regular_repo/.pi/agent-jailed"
          printf '%s\n' 'local-secret' > "$regular_repo/.pi/agent-jailed/auth.json"
          if run_hook ${globalHook} "$regular_home" "$regular_repo"; then
            echo "expected global mode to reject an existing local auth file" >&2
            exit 1
          fi
          grep -Fx 'local-secret' "$regular_repo/.pi/agent-jailed/auth.json"

          global_link_home="$TMPDIR/global-link-home"
          global_link_repo="$TMPDIR/global-link-repo"
          mkdir -p "$global_link_repo/.pi/agent-jailed"
          printf '%s\n' 'other-secret' > "$TMPDIR/other-auth.json"
          ln -s "$TMPDIR/other-auth.json" "$global_link_repo/.pi/agent-jailed/auth.json"
          if run_hook ${globalHook} "$global_link_home" "$global_link_repo"; then
            echo "expected global mode to reject an unrelated auth symlink" >&2
            exit 1
          fi
          assert_link_target "$global_link_repo/.pi/agent-jailed/auth.json" "$TMPDIR/other-auth.json"

          local_home="$TMPDIR/local-home"
          local_repo="$TMPDIR/local-repo"
          mkdir -p "$local_repo/.pi/agent-jailed"
          printf '%s\n' 'repo-secret' > "$local_repo/.pi/agent-jailed/auth.json"
          run_hook ${localHook} "$local_home" "$local_repo"
          grep -Fx 'repo-secret' "$local_repo/.pi/agent-jailed/auth.json"
          test ! -e "$local_home/.pi/agent/auth.json"
          assert_link_target "$local_repo/.pi/agent-jailed/sessions" "$local_home/.pi/agent/sessions"

          migrate_home="$TMPDIR/migrate-home"
          migrate_repo="$TMPDIR/migrate-repo"
          run_hook ${globalHook} "$migrate_home" "$migrate_repo"
          printf '%s\n' 'preserved-global-secret' > "$migrate_home/.pi/agent/auth.json"
          run_hook ${localHook} "$migrate_home" "$migrate_repo"
          test ! -e "$migrate_repo/.pi/agent-jailed/auth.json"
          test ! -L "$migrate_repo/.pi/agent-jailed/auth.json"
          grep -Fx 'preserved-global-secret' "$migrate_home/.pi/agent/auth.json"

          unrelated_home="$TMPDIR/unrelated-home"
          unrelated_repo="$TMPDIR/unrelated-repo"
          mkdir -p "$unrelated_repo/.pi/agent-jailed"
          ln -s "$TMPDIR/other-auth.json" "$unrelated_repo/.pi/agent-jailed/auth.json"
          run_hook ${localHook} "$unrelated_home" "$unrelated_repo"
          assert_link_target "$unrelated_repo/.pi/agent-jailed/auth.json" "$TMPDIR/other-auth.json"
          test ! -e "$unrelated_home/.pi/agent/auth.json"

          touch "$out"
        '';
    };
}
