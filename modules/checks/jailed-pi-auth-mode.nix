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

      realPi = inputs.llm-agents.packages.${system}.pi;

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
            if ! test -L "$path"; then
              echo "expected $path to be a symlink to $expected" >&2
              exit 1
            fi
            actual="$(readlink "$path")"
            if [ "$actual" != "$expected" ]; then
              echo "expected $path -> $expected, got $actual" >&2
              exit 1
            fi
          }

          assert_resource_links() {
            agent_dir="$1"
            test_home="$2"
            for resource in \
              AGENTS.md \
              claude-bridge.json \
              mcp.json \
              agents \
              extensions \
              multi-model-planning-teams \
              node_modules \
              skills \
              themes
            do
              assert_link_target "$agent_dir/$resource" "${self'.packages.pi-config}/$resource"
            done
            assert_link_target "$agent_dir/sessions" "$test_home/.pi/agent/sessions"
          }

          assert_runtime_resources_and_sessions() {
            test_home="$1"
            test_repo="$2"
            agent_dir="$3"
            assert_link_target \
              "$test_repo/.pi/claude-bridge.json" \
              "${self'.packages.pi-config}/claude-bridge.json"
            (
              export HOME="$test_home"
              export PI_CODING_AGENT_DIR="$agent_dir"
              export PI_OFFLINE=1
              cd "$test_repo"

              printf '%s\n' '{"id":"commands","type":"get_commands"}' \
                | ${pkgs.coreutils}/bin/timeout 30 ${pkgs.lib.getExe realPi} \
                    --mode rpc --no-session --provider __invalid__ --approve \
                    > commands.log 2>/dev/null || true
              commands_response="$(${pkgs.jq}/bin/jq -c \
                'select(.id == "commands" and .success == true)' \
                commands.log | tail -n 1)"
              test -n "$commands_response"
              printf '%s\n' "$commands_response" \
                | ${pkgs.jq}/bin/jq -e 'any(.data.commands[]; .name == "answer")'
              printf '%s\n' "$commands_response" \
                | ${pkgs.jq}/bin/jq -e 'any(.data.commands[]; .name == "review")'

              printf '%s\n' '{"id":"state","type":"get_state"}' \
                | ${pkgs.coreutils}/bin/timeout 30 ${pkgs.lib.getExe realPi} \
                    --mode rpc --provider __invalid__ --approve \
                    > state.log 2>/dev/null || true
              state_response="$(${pkgs.jq}/bin/jq -c \
                'select(.id == "state" and .success == true)' \
                state.log | tail -n 1)"
              if [ -z "$state_response" ]; then
                echo "expected jailed Pi RPC state response" >&2
                cat state.log >&2
                exit 1
              fi
              session_file="$(printf '%s\n' "$state_response" \
                | ${pkgs.jq}/bin/jq -r '.data.sessionFile')"
              resolved_session_file="$(${pkgs.coreutils}/bin/realpath -m "$session_file")"
              case "$resolved_session_file" in
                "$test_home/.pi/agent/sessions/"*) ;;
                *)
                  echo "expected jailed Pi session to resolve under global session directory" >&2
                  printf 'session: %s\nresolved: %s\n' \
                    "$session_file" "$resolved_session_file" >&2
                  exit 1
                  ;;
              esac
            )
          }

          global_home="$TMPDIR/global-home"
          global_repo="$TMPDIR/global-repo"
          run_hook ${globalHook} "$global_home" "$global_repo"
          global_agent="$global_repo/.pi/agent-jailed"
          global_auth="$global_home/.pi/agent/auth.json"
          assert_link_target "$global_agent/auth.json" "$global_auth"
          if [ -e "$global_agent/settings.json" ] || [ -L "$global_agent/settings.json" ]; then
            echo "expected project Pi hook to leave $global_agent/settings.json unmanaged" >&2
            exit 1
          fi
          assert_resource_links "$global_agent" "$global_home"
          assert_runtime_resources_and_sessions "$global_home" "$global_repo" "$global_agent"

          printf '%s\n' 'global-secret' > "$global_auth"
          printf '%s\n' 'synced-global-settings' > "$global_agent/settings.json"
          run_hook ${globalHook} "$global_home" "$global_repo"
          grep -Fx 'global-secret' "$global_auth"
          grep -Fx 'synced-global-settings' "$global_agent/settings.json"
          test ! -L "$global_agent/settings.json"
          assert_resource_links "$global_agent" "$global_home"

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
          printf '%s\n' 'synced-local-settings' > "$local_repo/.pi/agent-jailed/settings.json"
          run_hook ${localHook} "$local_home" "$local_repo"
          grep -Fx 'repo-secret' "$local_repo/.pi/agent-jailed/auth.json"
          grep -Fx 'synced-local-settings' "$local_repo/.pi/agent-jailed/settings.json"
          test ! -L "$local_repo/.pi/agent-jailed/settings.json"
          test ! -e "$local_home/.pi/agent/auth.json"
          assert_resource_links "$local_repo/.pi/agent-jailed" "$local_home"

          fresh_local_home="$TMPDIR/fresh-local-home"
          fresh_local_repo="$TMPDIR/fresh-local-repo"
          run_hook ${localHook} "$fresh_local_home" "$fresh_local_repo"
          fresh_local_agent="$fresh_local_repo/.pi/agent-jailed"
          test ! -e "$fresh_local_agent/auth.json"
          test ! -L "$fresh_local_agent/auth.json"
          test ! -e "$fresh_local_agent/settings.json"
          test ! -L "$fresh_local_agent/settings.json"
          assert_resource_links "$fresh_local_agent" "$fresh_local_home"

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
