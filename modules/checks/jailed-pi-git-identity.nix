{ ... }:
{
  perSystem =
    { pkgs, ... }:
    let
      gitIdentityLib = import ../../nix/lib/jailed-pi-git-identity.nix {
        inherit (pkgs) lib;
        inherit pkgs;
      };

      mkProbe =
        name: args:
        pkgs.writeShellApplication {
          inherit name;
          excludeShellChecks = [ "SC2016" ];
          text = ''
            isolated_home="$1"

            ${gitIdentityLib.mkSetupScript args}

            export HOME="$isolated_home"
            export GIT_CONFIG_NOSYSTEM=1
            unset GIT_CONFIG_GLOBAL
            cd "$isolated_home"

            resolved_name="$(${pkgs.git}/bin/git config --get user.name 2>/dev/null || true)"
            resolved_email="$(${pkgs.git}/bin/git config --get user.email 2>/dev/null || true)"

            printf 'name=%s\n' "''${resolved_name:-<unset>}"
            printf 'email=%s\n' "''${resolved_email:-<unset>}"
            printf 'count=%s\n' "''${GIT_CONFIG_COUNT-<unset>}"
          '';
        };

      inheritedProbe = mkProbe "jailed-pi-git-identity-inherited-probe" {
        inheritGitIdentity = true;
        gitUserName = null;
        gitUserEmail = null;
      };

      disabledProbe = mkProbe "jailed-pi-git-identity-disabled-probe" {
        inheritGitIdentity = false;
        gitUserName = null;
        gitUserEmail = null;
      };

      explicitProbe = mkProbe "jailed-pi-git-identity-explicit-probe" {
        inheritGitIdentity = true;
        gitUserName = ''Explicit "Name" $HOME'';
        gitUserEmail = "explicit+test@example.com";
      };

      inheritedProbeExe = pkgs.lib.getExe inheritedProbe;
      disabledProbeExe = pkgs.lib.getExe disabledProbe;
      explicitProbeExe = pkgs.lib.getExe explicitProbe;
    in
    {
      checks."jailed-pi-git-identity" =
        pkgs.runCommand "jailed-pi-git-identity-check"
          {
            nativeBuildInputs = [ pkgs.git ];
          }
          ''
            set -eu

            assert_probe() {
              probe="$1"
              source_home="$2"
              source_repo="$3"
              expected_name="$4"
              expected_email="$5"
              expected_count="$6"
              isolated_home="$TMPDIR/isolated-home-$7"
              mkdir -p "$isolated_home"

              actual="$(
                export HOME="$source_home"
                export GIT_CONFIG_NOSYSTEM=1
                cd "$source_repo"
                "$probe" "$isolated_home"
              )"

              expected="$(printf 'name=%s\nemail=%s\ncount=%s' \
                "$expected_name" "$expected_email" "$expected_count")"

              if [ "$actual" != "$expected" ]; then
                echo "unexpected probe output" >&2
                printf 'expected:\n%s\nactual:\n%s\n' "$expected" "$actual" >&2
                exit 1
              fi
            }

            global_home="$TMPDIR/global-home"
            global_repo="$TMPDIR/global-repo"
            mkdir -p "$global_home" "$global_repo"
            git -C "$global_repo" init -q
            git config --file "$global_home/.gitconfig" user.name "Global Name"
            git config --file "$global_home/.gitconfig" user.email "global@example.com"
            assert_probe ${inheritedProbeExe} "$global_home" "$global_repo" \
              "Global Name" "global@example.com" "2" "global"

            local_repo="$TMPDIR/local-repo"
            mkdir -p "$local_repo"
            git -C "$local_repo" init -q
            local_name='Repo "Name" $HOME'
            git -C "$local_repo" config user.name "$local_name"
            git -C "$local_repo" config user.email "repo+test@example.com"
            assert_probe ${inheritedProbeExe} "$global_home" "$local_repo" \
              "$local_name" "repo+test@example.com" "2" "local"

            conditional_home="$TMPDIR/conditional-home"
            conditional_repo="$TMPDIR/conditional-repo"
            mkdir -p "$conditional_home" "$conditional_repo"
            git -C "$conditional_repo" init -q
            cat > "$conditional_home/.gitconfig" <<EOF
            [user]
              name = Global Fallback
              email = fallback@example.com
            [includeIf "gitdir:$conditional_repo/"]
              path = $conditional_home/repository-identity.gitconfig
            EOF
            cat > "$conditional_home/repository-identity.gitconfig" <<'EOF'
            [user]
              name = Conditional Name
              email = conditional@example.com
            EOF
            assert_probe ${inheritedProbeExe} "$conditional_home" "$conditional_repo" \
              "Conditional Name" "conditional@example.com" "2" "conditional"

            assert_probe ${disabledProbeExe} "$global_home" "$global_repo" \
              "<unset>" "<unset>" "<unset>" "disabled"

            partial_home="$TMPDIR/partial-home"
            partial_repo="$TMPDIR/partial-repo"
            mkdir -p "$partial_home" "$partial_repo"
            git -C "$partial_repo" init -q
            git config --file "$partial_home/.gitconfig" user.name "Name Only"
            assert_probe ${inheritedProbeExe} "$partial_home" "$partial_repo" \
              "<unset>" "<unset>" "<unset>" "partial"

            broken_home="$TMPDIR/broken-home"
            broken_repo="$TMPDIR/broken-repo"
            broken_config="$TMPDIR/broken-config"
            mkdir -p "$broken_home" "$broken_repo" "$broken_config"
            git -C "$broken_repo" init -q
            (
              export GIT_CONFIG_GLOBAL="$broken_config"
              assert_probe ${inheritedProbeExe} "$broken_home" "$broken_repo" \
                "<unset>" "<unset>" "<unset>" "broken"
            )

            assert_probe ${explicitProbeExe} "$partial_home" "$partial_repo" \
              'Explicit "Name" $HOME' "explicit+test@example.com" "2" "explicit"

            touch "$out"
          '';
    };
}
