{ ... }:
{
  perSystem =
    { pkgs, ... }:
    let
      fakeGh = pkgs.writeShellApplication {
        name = "gh";
        text = ''
          set -eu
          : "$BROKER_TEST_DIR"
          : "$FAKE_SECRET"

          mode="$(${pkgs.coreutils}/bin/cat "$BROKER_TEST_DIR/gh-mode")"
          printf '%s\n' "$@" > "$BROKER_TEST_DIR/gh-$mode.argv"
          printf '%s\n' environment-inherited > "$BROKER_TEST_DIR/gh-$mode.env"
          printf '%s\n' "$FAKE_SECRET" 'RAW-HOST-DIAGNOSTIC gh' >&2

          case "$mode" in
            normal)
              printf '%s\n' '{"name":"demo","owner":{"login":"acme"},"full_name":"acme/demo","description":null,"private":false,"html_url":"https://github.com/acme/demo","default_branch":"main"}'
              ;;
            cancel)
              ${pkgs.coreutils}/bin/sleep 300 &
              child=$!
              printf '%s\n' "$child" > "$BROKER_TEST_DIR/gh-cancel-child.pid"
              wait "$child"
              ;;
            *)
              exit 90
              ;;
          esac
        '';
      };

      fakeSsh = pkgs.writeShellApplication {
        name = "ssh";
        text = ''
          set -eu
          : "$BROKER_TEST_DIR"
          : "$FAKE_SECRET"

          mode="$(${pkgs.coreutils}/bin/cat "$BROKER_TEST_DIR/ssh-mode")"
          printf '%s\n' "$@" > "$BROKER_TEST_DIR/ssh-$mode.argv"
          printf '%s\n' environment-inherited > "$BROKER_TEST_DIR/ssh-$mode.env"
          : > "$BROKER_TEST_DIR/ssh-$mode.stdin"
          printf '%s\n' "$FAKE_SECRET" 'RAW-HOST-DIAGNOSTIC ssh' >&2
          # shellcheck disable=SC2016
          BROKER_TEST_DIR="$BROKER_TEST_DIR" mode="$mode" ${pkgs.util-linux}/bin/setsid ${pkgs.runtimeShell} -c '
            ${pkgs.coreutils}/bin/cat > "$BROKER_TEST_DIR/ssh-$mode.stdin"
            : > "$BROKER_TEST_DIR/ssh-$mode.stdin-complete"
          ' <&0 &
          stdin_reader=$!
          ${pkgs.coreutils}/bin/cat "$BROKER_TEST_DIR/advertisement.bin"
          wait "$stdin_reader"
          if [ "$mode" = allowed ]; then
            printf '%s' receive-result
          fi
        '';
      };

      testBroker = import ../../nix/packages/jailed-github-broker.nix {
        inherit pkgs;
        hostGh = fakeGh;
        hostSsh = fakeSsh;
      };
    in
    {
      checks."jailed-github-broker" =
        pkgs.runCommand "jailed-github-broker-check"
          {
            nativeBuildInputs = [
              pkgs.coreutils
              pkgs.diffutils
              pkgs.gnugrep
              pkgs.procps
              pkgs.python3
            ];
          }
          ''
            set -eu

            fail() {
              echo "$1" >&2
              exit 1
            }

            wait_for_file() {
              path="$1"
              attempts=0
              while [ ! -e "$path" ]; do
                attempts=$((attempts + 1))
                if [ "$attempts" -ge 200 ]; then
                  fail "timed out waiting for expected file"
                fi
                ${pkgs.coreutils}/bin/sleep 0.05
              done
            }

            process_is_live() {
              pid="$1"
              state="$(${pkgs.procps}/bin/ps -o stat= -p "$pid" 2>/dev/null || true)"
              case "$state" in
                ""|*Z*) return 1 ;;
                *) return 0 ;;
              esac
            }

            wait_for_process_exit() {
              pid="$1"
              description="$2"
              attempts=0
              while process_is_live "$pid"; do
                attempts=$((attempts + 1))
                if [ "$attempts" -ge 200 ]; then
                  echo "$description did not exit before deadline; sending KILL" >&2
                  kill -KILL "$pid" 2>/dev/null || true
                  attempts=0
                  while process_is_live "$pid"; do
                    attempts=$((attempts + 1))
                    if [ "$attempts" -ge 200 ]; then
                      echo "$description remained alive after KILL; unable to reap it" >&2
                      return 124
                    fi
                    ${pkgs.coreutils}/bin/sleep 0.05
                  done
                  wait "$pid" 2>/dev/null || true
                  return 124
                fi
                ${pkgs.coreutils}/bin/sleep 0.05
              done
              wait "$pid"
            }

            process_identity() {
              ${pkgs.gawk}/bin/awk '{ sub(/^.*\) /, ""); print $20 }' "/proc/$1/stat" 2>/dev/null || true
            }

            process_matches_identity() {
              pid="$1"
              expected_identity="$2"
              actual_identity="$(process_identity "$pid")"
              [ -n "$actual_identity" ] && [ "$actual_identity" = "$expected_identity" ] && process_is_live "$pid"
            }

            wait_for_process_gone() {
              pid="$1"
              expected_identity="$2"
              attempts=0
              while process_matches_identity "$pid" "$expected_identity"; do
                attempts=$((attempts + 1))
                if [ "$attempts" -ge 200 ]; then
                  if process_matches_identity "$pid" "$expected_identity"; then
                    kill -TERM "$pid" 2>/dev/null || true
                  else
                    return 0
                  fi
                  attempts=0
                  while process_matches_identity "$pid" "$expected_identity"; do
                    attempts=$((attempts + 1))
                    if [ "$attempts" -ge 200 ]; then
                      if process_matches_identity "$pid" "$expected_identity"; then
                        kill -KILL "$pid" 2>/dev/null || true
                      else
                        return 0
                      fi
                      attempts=0
                      while process_matches_identity "$pid" "$expected_identity"; do
                        attempts=$((attempts + 1))
                        if [ "$attempts" -ge 200 ]; then
                          fail "cancelled host descendant remained alive after TERM/KILL"
                        fi
                        ${pkgs.coreutils}/bin/sleep 0.05
                      done
                      fail "cancelled host descendant remained alive past its deadline"
                    fi
                    ${pkgs.coreutils}/bin/sleep 0.05
                  done
                  fail "cancelled host descendant remained alive past its deadline"
                fi
                ${pkgs.coreutils}/bin/sleep 0.05
              done
            }

            assert_same() {
              expected="$1"
              actual="$2"
              ${pkgs.diffutils}/bin/cmp -s "$expected" "$actual" || fail "packaged broker produced unexpected bytes"
            }

            assert_clean() {
              file="$1"
              if ${pkgs.gnugrep}/bin/grep -Fq -- "$FAKE_SECRET" "$file"; then
                fail "fake host environment leaked to client-visible output"
              fi
              if ${pkgs.gnugrep}/bin/grep -Fq -- RAW-HOST-DIAGNOSTIC "$file"; then
                fail "raw fake host diagnostic leaked to client-visible output"
              fi
            }

            test_dir="$TMPDIR/broker-test"
            mkdir -p "$test_dir/logs" "$test_dir/poison/bin"
            FAKE_SECRET="$(${pkgs.coreutils}/bin/od -An -N16 -tx1 /dev/urandom | ${pkgs.coreutils}/bin/tr -d '[:space:]')"
            export BROKER_TEST_DIR="$test_dir"
            export FAKE_SECRET

            cat > "$test_dir/poison/bin/gh" <<'SH'
            #!${pkgs.runtimeShell}
            : > "$BROKER_TEST_DIR/hostile-path-invoked"
            exit 99
            SH
            cp "$test_dir/poison/bin/gh" "$test_dir/poison/bin/ssh"
            chmod +x "$test_dir/poison/bin/gh" "$test_dir/poison/bin/ssh"

            cat > "$test_dir/config.json" <<'JSON'
            {
              "enable": true,
              "repository": "acme/demo",
              "capabilities": ["repository:read", "git:read", "git:write"],
              "limits": {
                "maxConcurrentRequests": 4,
                "maxControlBytes": 1048576,
                "maxStreamFrameBytes": 65536,
                "maxPushPrefixBytes": 1048576,
                "initialFrameTimeoutSeconds": 5,
                "operationTimeoutSeconds": 30,
                "idleStreamTimeoutSeconds": 30
              }
            }
            JSON

            cat > "$test_dir/generate.py" <<'PY'
            import pathlib
            import sys

            directory = pathlib.Path(sys.argv[1])
            old = b"1" * 40
            new = b"2" * 40

            def packet(payload):
                return f"{len(payload) + 4:04x}".encode() + payload

            advertisement = packet(old + b" refs/heads/main\0report-status delete-refs push-options\n") + b"0000"
            denied = packet(old + b" " + new + b" refs/heads/main\0report-status") + b"0000PACK-denied"
            allowed = (
                packet(old + b" " + new + b" refs/heads/feature\0report-status push-options")
                + b"0000"
                + packet(b"ci.skip")
                + b"0000PACK-feature-data"
            )
            (directory / "advertisement.bin").write_bytes(advertisement)
            (directory / "denied.request").write_bytes(denied)
            (directory / "allowed.request").write_bytes(allowed)
            (directory / "allowed.expected-output").write_bytes(advertisement + b"receive-result")
            PY
            ${pkgs.python3}/bin/python "$test_dir/generate.py" "$test_dir"

            socket="$test_dir/broker.sock"
            ready="$test_dir/broker.ready"
            server=${testBroker}/bin/jailed-github-broker
            client_gh=${testBroker.client}/bin/gh
            client_ssh=${testBroker.client}/bin/jailed-git-ssh

            exec 3>> "$test_dir/audit.jsonl"
            PATH="$test_dir/poison/bin" "$server" serve \
              --config "$test_dir/config.json" \
              --socket "$socket" \
              --ready-file "$ready" \
              --audit-fd 3 \
              2> "$test_dir/logs/server.log" &
            server_pid=$!
            exec 3>&-
            cleanup_server() {
              primary_status=$?
              trap - EXIT
              kill -TERM "$server_pid" 2>/dev/null || true
              if wait_for_process_exit "$server_pid" "server exit cleanup"; then
                :
              else
                cleanup_status=$?
                if [ "$cleanup_status" -eq 124 ]; then
                  echo "server exit cleanup exceeded deadline while preserving primary failure" >&2
                fi
              fi
              exit "$primary_status"
            }
            trap cleanup_server EXIT
            wait_for_file "$ready"

            export JAILED_GITHUB_BROKER_SOCKET="$socket"
            export JAILED_GITHUB_BROKER_REPOSITORY=acme/demo

            printf '%s\n' normal > "$test_dir/gh-mode"
            "$client_gh" repo view > "$test_dir/logs/repo.out" 2> "$test_dir/logs/repo.err"
            ${pkgs.gnugrep}/bin/grep -Fq -- '"nameWithOwner":"acme/demo"' "$test_dir/logs/repo.out" || \
              fail "repository response was not bound to configured repository"
            test ! -s "$test_dir/logs/repo.err" || fail "successful gh request emitted a client diagnostic"
            ${pkgs.gnugrep}/bin/grep -Fxq environment-inherited "$test_dir/gh-normal.env" || \
              fail "fake gh did not inherit the broker host environment"

            cat > "$test_dir/expected-gh.argv" <<'EOF'
            api
            --hostname
            github.com
            --method
            GET
            -H
            Accept: application/vnd.github+json
            -H
            X-GitHub-Api-Version: 2022-11-28
            /repos/acme/demo
            EOF
            assert_same "$test_dir/expected-gh.argv" "$test_dir/gh-normal.argv"
            cp "$test_dir/gh-normal.argv" "$test_dir/gh-before-denial.argv"

            if "$client_gh" issue list > "$test_dir/logs/capability.out" 2> "$test_dir/logs/capability.err"; then
              fail "request without its capability was accepted"
            fi
            test ! -s "$test_dir/logs/capability.out" || fail "capability denial emitted stdout"
            printf '%s\n' 'gh: broker request failed' > "$test_dir/expected-capability.err"
            assert_same "$test_dir/expected-capability.err" "$test_dir/logs/capability.err"
            assert_same "$test_dir/gh-before-denial.argv" "$test_dir/gh-normal.argv"

            JAILED_GITHUB_BROKER_SOCKET="$test_dir/missing.sock" \
              "$client_gh" auth status > "$test_dir/logs/unsupported.out" 2> "$test_dir/logs/unsupported.err" && \
              fail "unsupported gh command was accepted"
            test ! -s "$test_dir/logs/unsupported.out" || fail "unsupported command emitted stdout"
            printf '%s\n' 'gh: unsupported or invalid command' > "$test_dir/expected-unsupported.err"
            assert_same "$test_dir/expected-unsupported.err" "$test_dir/logs/unsupported.err"
            assert_same "$test_dir/gh-before-denial.argv" "$test_dir/gh-normal.argv"

            printf '%s\n' denied > "$test_dir/ssh-mode"
            if "$client_ssh" git@github.com "git-receive-pack 'acme/demo.git'" \
              < "$test_dir/denied.request" \
              > "$test_dir/logs/denied.out" \
              2> "$test_dir/logs/denied.err"; then
              fail "default main-branch push denial was not enforced"
            fi
            wait_for_file "$test_dir/ssh-denied.stdin-complete"
            test ! -s "$test_dir/ssh-denied.stdin" || fail "denied receive-pack request bytes reached host ssh"
            assert_same "$test_dir/advertisement.bin" "$test_dir/logs/denied.out"
            ${pkgs.gnugrep}/bin/grep -Fxq environment-inherited "$test_dir/ssh-denied.env" || \
              fail "fake ssh did not inherit the broker host environment"

            cat > "$test_dir/expected-ssh.argv" <<'EOF'
            git@github.com
            git-receive-pack 'acme/demo.git'
            EOF
            assert_same "$test_dir/expected-ssh.argv" "$test_dir/ssh-denied.argv"

            printf '%s\n' allowed > "$test_dir/ssh-mode"
            "$client_ssh" git@github.com "git-receive-pack 'acme/demo.git'" \
              < "$test_dir/allowed.request" \
              > "$test_dir/logs/allowed.out" \
              2> "$test_dir/logs/allowed.err"
            assert_same "$test_dir/allowed.request" "$test_dir/ssh-allowed.stdin"
            assert_same "$test_dir/allowed.expected-output" "$test_dir/logs/allowed.out"
            printf '%s\n' 'ssh transport diagnostic' > "$test_dir/expected-allowed.err"
            assert_same "$test_dir/expected-allowed.err" "$test_dir/logs/allowed.err"
            assert_same "$test_dir/expected-ssh.argv" "$test_dir/ssh-allowed.argv"

            printf '%s\n' cancel > "$test_dir/gh-mode"
            "$client_gh" repo view > "$test_dir/logs/cancel.out" 2> "$test_dir/logs/cancel.err" &
            cancel_client_pid=$!
            wait_for_file "$test_dir/gh-cancel-child.pid"
            cancel_child_pid="$(${pkgs.coreutils}/bin/cat "$test_dir/gh-cancel-child.pid")"
            [ -n "$cancel_child_pid" ] || fail "cancelled host descendant reported an invalid PID"
            case "$cancel_child_pid" in
              *[!0-9]*) fail "cancelled host descendant reported an invalid PID" ;;
            esac
            cancel_child_identity="$(process_identity "$cancel_child_pid")"
            [ -n "$cancel_child_identity" ] || fail "cancelled host descendant identity was unavailable"
            kill -TERM "$cancel_client_pid"
            if wait_for_process_exit "$cancel_client_pid" "cancelled client"; then
              :
            else
              cancel_status=$?
              [ "$cancel_status" -eq 124 ] && fail "cancelled client did not exit before deadline"
            fi
            wait_for_process_gone "$cancel_child_pid" "$cancel_child_identity"

            test ! -e "$test_dir/hostile-path-invoked" || fail "broker looked up a host tool through PATH"
            for log in "$test_dir"/logs/* "$test_dir/audit.jsonl"; do
              assert_clean "$log"
            done
            ${pkgs.gnugrep}/bin/grep -F '"operation":"repository.get"' "$test_dir/audit.jsonl" >/dev/null || \
              fail "accepted API request was not audited"
            ${pkgs.gnugrep}/bin/grep -F '"operation":"git.receivePack"' "$test_dir/audit.jsonl" >/dev/null || \
              fail "accepted Git request was not audited"
            test ! -s "$test_dir/logs/server.log" || fail "broker stderr was confused with audit output"

            kill -TERM "$server_pid"
            wait_for_process_exit "$server_pid" "server shutdown"
            trap - EXIT
            test ! -e "$ready" || fail "broker left its ready file after shutdown"
            test ! -e "$socket" || fail "broker left its socket after shutdown"

            touch "$out"
          '';
    };
}
