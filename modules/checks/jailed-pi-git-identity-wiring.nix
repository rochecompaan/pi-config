{ ... }:
{
  perSystem =
    { pkgs, self', ... }:
    let
      fakePi = pkgs.writeShellApplication {
        name = "pi";
        text = ''
          exit 0
        '';
      };

      fakeAgentConfig = pkgs.runCommand "jailed-pi-git-identity-test-config" { } ''
        mkdir -p "$out"
      '';

      mkTestJailed =
        name: args:
        self'.lib.mkJailedPi (
          {
            inherit name;
            piPackage = fakePi;
            agentConfigPackage = fakeAgentConfig;
            authMode = "local";
            extraPkgs = [ ];
            runtimeClosurePkgs = [ ];
          }
          // args
        );

      defaultJailed = mkTestJailed "jailed-pi-git-default-test" { };
      disabledJailed = mkTestJailed "jailed-pi-git-disabled-test" {
        inheritGitIdentity = false;
      };
      explicitJailed = mkTestJailed "jailed-pi-git-explicit-test" {
        gitUserName = "Explicit Wiring Name";
        gitUserEmail = "explicit-wiring@example.com";
      };
    in
    {
      checks."jailed-pi-git-identity-wiring" =
        pkgs.runCommand "jailed-pi-git-identity-wiring-check" { }
          ''
            set -eu

            launcher_for() {
              package="$1"
              find "$package/bin" -maxdepth 1 -type f -print -quit
            }

            sandbox_launcher_for() {
              launcher="$(launcher_for "$1")"
              sed -n 's|^exec \(/nix/store/[^ ]*-sandbox/bin/[^ ]*\) .*|\1|p' "$launcher"
            }

            assert_contains() {
              file="$1"
              needle="$2"
              grep -F -- "$needle" "$file" >/dev/null || {
                echo "expected $file to contain: $needle" >&2
                exit 1
              }
            }

            assert_omits() {
              file="$1"
              needle="$2"
              if grep -F -- "$needle" "$file" >/dev/null; then
                echo "expected $file to omit: $needle" >&2
                exit 1
              fi
            }

            default_launcher="$(launcher_for ${defaultJailed})"
            disabled_launcher="$(launcher_for ${disabledJailed})"
            explicit_launcher="$(launcher_for ${explicitJailed})"

            assert_contains "$default_launcher" "config --includes --get user.name"
            assert_contains "$default_launcher" "config --includes --get user.email"
            assert_omits "$disabled_launcher" "config --includes --get user.name"
            assert_omits "$disabled_launcher" "GIT_CONFIG_VALUE_0="
            assert_omits "$explicit_launcher" "config --includes --get user.name"
            assert_contains "$explicit_launcher" "Explicit Wiring Name"
            assert_contains "$explicit_launcher" "explicit-wiring@example.com"

            for package in ${defaultJailed} ${disabledJailed} ${explicitJailed}; do
              sandbox_launcher="$(sandbox_launcher_for "$package")"
              test -n "$sandbox_launcher"
              for variable in \
                GIT_CONFIG_COUNT \
                GIT_CONFIG_KEY_0 \
                GIT_CONFIG_VALUE_0 \
                GIT_CONFIG_KEY_1 \
                GIT_CONFIG_VALUE_1
              do
                assert_contains "$sandbox_launcher" "$variable"
              done
              assert_omits "$sandbox_launcher" '$HOME/.gitconfig'
              assert_omits "$sandbox_launcher" '$HOME/.config/git'
            done

            touch "$out"
          '';
    };
}
