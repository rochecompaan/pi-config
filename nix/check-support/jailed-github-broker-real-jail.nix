{
  inputs,
  pkgs,
  self',
}:
let
  inherit (pkgs) lib;

  fakeGh = pkgs.writeShellApplication {
    name = "gh";
    text = ''
      set -euo pipefail

      : "$BROKER_TEST_PRIVATE" "$BROKER_TEST_BARE" "$FAKE_HOST_ENV_SENTINEL"
      test "$FAKE_HOST_ENV_SENTINEL" = host-environment-sentinel
      test "$GH_TOKEN" = host-gh-token-sentinel
      test "$GITHUB_TOKEN" = host-github-token-sentinel
      test "$GH_ENTERPRISE_TOKEN" = host-gh-enterprise-token-sentinel
      test "$GITHUB_ENTERPRISE_TOKEN" = host-github-enterprise-token-sentinel
      test "$GH_CONFIG_DIR" = "$HOME/.config/gh"
      test "$SSH_AUTH_SOCK" = "$BROKER_TEST_PRIVATE/agent.sock"
      test -f "$GH_CONFIG_DIR/config.yml"
      test -f "$HOME/.local/share/keyrings/github.keyring"
      test -S "$SSH_AUTH_SOCK"
      for variable in GH_HOST GH_REPO GH_DEBUG; do
        [[ ! -v $variable ]]
      done

      calls="$BROKER_TEST_PRIVATE/gh-calls"
      mkdir -p "$calls"
      call_number=1
      while ! mkdir "$calls/$call_number" 2>/dev/null; do
        call_number=$((call_number + 1))
        test "$call_number" -le 20
      done
      call="$calls/$call_number"
      printf '%s\n' "$@" > "$call/argv"
      for variable in \
        FAKE_HOST_ENV_SENTINEL GH_TOKEN GITHUB_TOKEN \
        GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_CONFIG_DIR \
        SSH_AUTH_SOCK HOME BROKER_TEST_PRIVATE BROKER_TEST_BARE
      do
        [[ -v $variable ]]
        printf '%s\n' "$variable" >> "$call/environment-names"
      done

      actual=("$@")
      case "''${actual[''${#actual[@]}-1]}" in
        /repos/alpha/demo)
          expected=(
            api --hostname github.com --method GET
            -H 'Accept: application/vnd.github+json'
            -H 'X-GitHub-Api-Version: 2022-11-28'
            /repos/alpha/demo
          )
          response='{"name":"demo","owner":{"login":"alpha"},"full_name":"alpha/demo","description":null,"private":true,"html_url":"https://github.com/alpha/demo","default_branch":"main"}'
          ;;
        /repos/alpha/demo/issues)
          expected=(
            api --hostname github.com --method POST
            -H 'Accept: application/vnd.github+json'
            -H 'X-GitHub-Api-Version: 2022-11-28'
            --input - /repos/alpha/demo/issues
          )
          ${pkgs.coreutils}/bin/cat > "$call/stdin"
          ${pkgs.gnugrep}/bin/grep -F AUDIT-BODY-SECRET-SENTINEL "$call/stdin" >/dev/null
          response='{"number":17,"title":"audit title","body":"AUDIT-BODY-SECRET-SENTINEL","state":"open","user":{"login":"jailed"},"assignees":[],"labels":[],"html_url":"https://github.com/alpha/demo/issues/17","created_at":"2026-07-30T00:00:00Z","updated_at":"2026-07-30T00:00:00Z"}'
          ;;
        *) exit 91 ;;
      esac
      test "''${#actual[@]}" -eq "''${#expected[@]}"
      for index in "''${!expected[@]}"; do
        test "''${actual[$index]}" = "''${expected[$index]}"
      done

      printf '%s\n' "$GH_TOKEN" RAW-GH-STDERR-SENTINEL >&2
      printf '%s\n' "$response"
    '';
  };

  fakeSsh = pkgs.writeShellApplication {
    name = "ssh";
    text = ''
      set -euo pipefail

      : "$BROKER_TEST_PRIVATE" "$BROKER_TEST_BARE" "$FAKE_HOST_ENV_SENTINEL"
      test "$FAKE_HOST_ENV_SENTINEL" = host-environment-sentinel
      test "$GH_TOKEN" = host-gh-token-sentinel
      test "$GITHUB_TOKEN" = host-github-token-sentinel
      test "$GH_ENTERPRISE_TOKEN" = host-gh-enterprise-token-sentinel
      test "$GITHUB_ENTERPRISE_TOKEN" = host-github-enterprise-token-sentinel
      test "$GH_CONFIG_DIR" = "$HOME/.config/gh"
      test "$SSH_AUTH_SOCK" = "$BROKER_TEST_PRIVATE/agent.sock"
      test -f "$HOME/.ssh/config"
      test -f "$HOME/.ssh/id_test"
      test -S "$SSH_AUTH_SOCK"
      for variable in GH_HOST GH_REPO GH_DEBUG; do
        [[ ! -v $variable ]]
      done

      calls="$BROKER_TEST_PRIVATE/ssh-calls"
      mkdir -p "$calls"
      call_number=1
      while ! mkdir "$calls/$call_number" 2>/dev/null; do
        call_number=$((call_number + 1))
        test "$call_number" -le 20
      done
      call="$calls/$call_number"
      printf '%s\n' "$@" > "$call/argv"
      for variable in \
        FAKE_HOST_ENV_SENTINEL GH_TOKEN GITHUB_TOKEN \
        GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_CONFIG_DIR \
        SSH_AUTH_SOCK HOME BROKER_TEST_PRIVATE BROKER_TEST_BARE
      do
        [[ -v $variable ]]
        printf '%s\n' "$variable" >> "$call/environment-names"
      done
      printf '%s\n' "$GH_TOKEN" RAW-SSH-STDERR-SENTINEL >&2

      test "$#" -eq 2
      test "$1" = git@github.com
      case "$2" in
        "git-upload-pack 'alpha/demo.git'")
          printf '%s\n' upload > "$call/service"
          ${pkgs.coreutils}/bin/tee "$call/stdin" | \
            ${pkgs.git}/bin/git-upload-pack "$BROKER_TEST_BARE"
          ;;
        "git-receive-pack 'alpha/demo.git'")
          printf '%s\n' receive > "$call/service"
          ${pkgs.coreutils}/bin/tee "$call/stdin" | \
            ${pkgs.git}/bin/git-receive-pack "$BROKER_TEST_BARE"
          ;;
        *)
          exit 90
          ;;
      esac
    '';
  };

  fakeHostTools = pkgs.symlinkJoin {
    name = "jailed-github-broker-real-jail-host-tools";
    paths = [
      fakeGh
      fakeSsh
    ];
  };

  fakeServer = import ../packages/jailed-github-broker.nix {
    inherit pkgs;
    hostGh = fakeHostTools;
    hostSsh = fakeHostTools;
  };

  jailedPiLib = import ../lib/mk-jailed-pi.nix {
    inherit inputs pkgs self';
    system = pkgs.system;
    githubBrokerServerPackage = fakeServer;
  };

  jailPayload = pkgs.writeShellApplication {
    name = "pi";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.git
      pkgs.jq
    ];
    text = builtins.readFile ./jailed-github-broker-real-jail-payload.sh;
  };

  fakeAgentConfig = pkgs.runCommand "jailed-github-broker-real-jail-agent-config" { } ''
    mkdir -p "$out"
  '';

  jailed = jailedPiLib.mkJailedPi {
    name = "jailed-github-broker-real-jail";
    piPackage = jailPayload;
    agentConfigPackage = fakeAgentConfig;
    defaultAgentDir = "$PWD/agent";
    authMode = "local";
    inheritGitIdentity = false;
    githubBroker = {
      enable = true;
      repository = "alpha/demo";
      capabilities = [
        "repository:read"
        "issues:write"
        "git:read"
        "git:write"
      ];
      limits = {
        initialFrameTimeoutSeconds = 3;
        operationTimeoutSeconds = 20;
        idleStreamTimeoutSeconds = 5;
      };
    };
    extraPkgs = [ ];
    runtimeClosurePkgs = [ ];
  };
in
{
  inherit fakeHostTools fakeServer jailed;

  check =
    pkgs.runCommand "jailed-github-broker-real-jail-check"
      {
        nativeBuildInputs = [
          pkgs.coreutils
          pkgs.diffutils
          pkgs.findutils
          pkgs.gawk
          pkgs.git
          pkgs.gnugrep
          pkgs.procps
        ];
      }
      ''
        set -euo pipefail

        fail() {
          printf 'real-jail check failed: %s\n' "$1" >&2
          exit 1
        }
        assert_same() {
          cmp -s "$1" "$2" || fail "$3"
        }
        process_is_live() {
          kill -0 "$1" 2>/dev/null || return 1
          state="$(ps -o stat= -p "$1" 2>/dev/null)" || return 1
          case "$state" in
            Z*) return 1 ;;
            *) return 0 ;;
          esac
        }
        process_identity() {
          awk '{ sub(/^.*\) /, ""); print $20 }' "/proc/$1/stat" 2>/dev/null || true
        }
        process_matches_identity() {
          actual_identity="$(process_identity "$1")"
          [ -n "$actual_identity" ] \
            && [ "$actual_identity" = "$2" ] \
            && process_is_live "$1"
        }

        agent_socket=""
        agent_listener_pid=""
        agent_listener_identity=""
        stop_agent_listener() {
          if [ -n "$agent_listener_pid" ] \
            && [ -n "$agent_listener_identity" ] \
            && process_matches_identity "$agent_listener_pid" "$agent_listener_identity"; then
            kill "$agent_listener_pid" 2>/dev/null || true
            cleanup_attempt=0
            while [ "$cleanup_attempt" -lt 50 ] \
              && process_matches_identity "$agent_listener_pid" "$agent_listener_identity"; do
              sleep 0.02
              cleanup_attempt=$((cleanup_attempt + 1))
            done
            if process_matches_identity "$agent_listener_pid" "$agent_listener_identity"; then
              kill -KILL "$agent_listener_pid" 2>/dev/null || true
            fi
          fi
          if [ -n "$agent_listener_pid" ]; then
            wait "$agent_listener_pid" 2>/dev/null || true
          fi
          if [ -n "$agent_socket" ]; then
            rm -f "$agent_socket"
          fi
          agent_listener_pid=""
          agent_listener_identity=""
        }
        cleanup_agent_listener() {
          cleanup_status=$?
          trap - EXIT HUP INT TERM
          stop_agent_listener
          exit "$cleanup_status"
        }
        trap cleanup_agent_listener EXIT
        trap 'exit 129' HUP
        trap 'exit 130' INT
        trap 'exit 143' TERM

        host_private="$TMPDIR/host-private"
        host_runtime="$TMPDIR/host-runtime"
        host_home="$TMPDIR/host-home"
        workspace="$TMPDIR/jail-workspace"
        bare="$host_private/repository.git"
        mkdir -p \
          "$host_private/host-poison" "$host_runtime" "$workspace/agent" \
          "$host_home/.config/gh" "$host_home/.local/share/keyrings" "$host_home/.ssh"
        printf '%s\n' config-sentinel > "$host_home/.config/gh/config.yml"
        printf '%s\n' keyring-sentinel > "$host_home/.local/share/keyrings/github.keyring"
        printf '%s\n' ssh-config-sentinel > "$host_home/.ssh/config"
        printf '%s\n' ssh-key-sentinel > "$host_home/.ssh/id_test"
        printf '%s\n' agent-sentinel > "$host_private/agent-secret"

        agent_socket="$host_private/agent.sock"
        ${pkgs.python3}/bin/python3 - "$agent_socket" <<'PY' &
        import signal
        import socket
        import sys

        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(sys.argv[1])
        listener.listen()
        signal.alarm(90)
        while True:
            signal.pause()
        PY
        agent_listener_pid=$!
        agent_listener_identity="$(process_identity "$agent_listener_pid")"
        if [ -z "$agent_listener_identity" ]; then
          wait "$agent_listener_pid" 2>/dev/null || true
          fail "SSH agent listener did not start"
        fi
        listener_attempt=0
        while [ "$listener_attempt" -lt 100 ] \
          && process_matches_identity "$agent_listener_pid" "$agent_listener_identity" \
          && [ ! -S "$agent_socket" ]; do
          sleep 0.02
          listener_attempt=$((listener_attempt + 1))
        done
        process_matches_identity "$agent_listener_pid" "$agent_listener_identity" || \
          fail "SSH agent listener exited during startup"
        test -S "$agent_socket" || fail "SSH_AUTH_SOCK is not a host Unix socket"

        cat > "$host_private/host-poison/gh" <<'SH'
        #!/bin/sh
        touch "$BROKER_TEST_PRIVATE/host-poison-invoked"
        exit 99
        SH
        cp "$host_private/host-poison/gh" "$host_private/host-poison/ssh"
        chmod +x "$host_private/host-poison/gh" "$host_private/host-poison/ssh"

        git init -q --bare "$bare"
        git init -q "$TMPDIR/seed"
        git -C "$TMPDIR/seed" config user.name 'Host Seed'
        git -C "$TMPDIR/seed" config user.email host-seed@example.invalid
        printf '%s\n' base > "$TMPDIR/seed/base.txt"
        git -C "$TMPDIR/seed" add base.txt
        git -C "$TMPDIR/seed" commit -q -m base
        git -C "$TMPDIR/seed" branch -M main
        git -C "$TMPDIR/seed" remote add origin "$bare"
        git -C "$TMPDIR/seed" push -q origin main
        git --git-dir="$bare" symbolic-ref HEAD refs/heads/main
        initial_main="$(git --git-dir="$bare" rev-parse refs/heads/main)"
        audit_log="$host_home/.local/state/pi/jailed-github-broker/audit.jsonl"

        set +e
        (
          cd "$workspace"
          HOME="$host_home" \
          XDG_RUNTIME_DIR="$host_runtime" \
          PI_CODING_AGENT_DIR="$workspace/agent" \
          LANG=C.UTF-8 \
          GH_TOKEN=host-gh-token-sentinel \
          GITHUB_TOKEN=host-github-token-sentinel \
          GH_ENTERPRISE_TOKEN=host-gh-enterprise-token-sentinel \
          GITHUB_ENTERPRISE_TOKEN=host-github-enterprise-token-sentinel \
          GH_CONFIG_DIR="$host_home/.config/gh" \
          SSH_AUTH_SOCK="$agent_socket" \
          FAKE_HOST_ENV_SENTINEL=host-environment-sentinel \
          BROKER_TEST_PRIVATE="$host_private" \
          BROKER_TEST_BARE="$bare" \
          PATH="$host_private/host-poison" \
            ${pkgs.coreutils}/bin/timeout --signal=TERM --kill-after=5 60 \
              ${lib.getExe jailed} \
                "$host_private" "$host_runtime" "$bare" \
                ${fakeHostTools} ${fakeServer} \
                "$host_home/.config/gh/config.yml" \
                "$host_home/.local/share/keyrings/github.keyring" \
                "$host_home/.ssh/config" "$host_home/.ssh/id_test" \
                "$agent_socket" "$audit_log" \
              > jail.stdout 2> jail.stderr
        )
        jail_status=$?
        set -e
        if grep -F \
          -e host-gh-token-sentinel \
          -e host-github-token-sentinel \
          -e host-gh-enterprise-token-sentinel \
          -e host-github-enterprise-token-sentinel \
          -e host-environment-sentinel \
          -e config-sentinel \
          -e keyring-sentinel \
          -e ssh-config-sentinel \
          -e ssh-key-sentinel \
          -e agent-sentinel \
          "$workspace/jail.stdout" "$workspace/jail.stderr" >/dev/null; then
          fail "host secret or environment sentinel reached jail output"
        fi
        if [ "$jail_status" -ne 0 ]; then
          printf 'real jail exited with status %s\n' "$jail_status" >&2
          cat "$workspace/jail.stderr" >&2
          exit 1
        fi
        test -e "$workspace/real-jail-success" || fail "jail payload did not finish"
        process_matches_identity "$agent_listener_pid" "$agent_listener_identity" || \
          fail "SSH agent listener did not remain live"
        test -S "$agent_socket" || fail "host SSH_AUTH_SOCK stopped being a Unix socket"
        test ! -e "$host_private/host-poison-invoked" || fail "broker used host PATH lookup"
        test -z "$(find "$host_runtime" -mindepth 1 -print -quit)" || fail "broker runtime was not cleaned"
        test -f "$audit_log" || fail "durable audit log was not created"
        test "$(stat -c %a "$(dirname "$audit_log")")" = 700 || fail "audit directory mode is not 0700"
        test "$(stat -c %a "$audit_log")" = 600 || fail "audit file mode is not 0600"
        ${pkgs.python3}/bin/python3 - "$audit_log" <<'PY'
        import json
        import pathlib
        import sys

        path = pathlib.Path(sys.argv[1])
        lines = path.read_text(encoding="utf-8").splitlines()
        if len(lines) != 7:
            raise SystemExit(f"expected 7 whole audit records, got {len(lines)}")
        records = [json.loads(line) for line in lines]
        required = {
            "operation", "request_id", "repository", "duration_ms",
            "exit_status", "refs", "stdin_bytes", "stdout_bytes", "stderr_bytes",
        }
        for record in records:
            if set(record) != required or record["repository"] != "alpha/demo":
                raise SystemExit(f"invalid audit record: {record!r}")
            if not isinstance(record["request_id"], str) or not isinstance(record["refs"], list):
                raise SystemExit(f"invalid audit field types: {record!r}")
        operations = {record["operation"] for record in records}
        if not {"repository.get", "issues.create", "git.uploadPack", "git.receivePack"} <= operations:
            raise SystemExit(f"missing audited operations: {operations!r}")
        if not any("refs/heads/feature/task-10" in record["refs"] for record in records):
            raise SystemExit("validated feature ref was not audited")
        forbidden = [
            "AUDIT-BODY-SECRET-SENTINEL", "PACK-AUDIT-SECRET-SENTINEL",
            "host-gh-token-sentinel", "host-environment-sentinel",
            "RAW-GH-STDERR-SENTINEL", "RAW-SSH-STDERR-SENTINEL",
            "git-upload-pack", "git-receive-pack", "git@github.com",
        ]
        text = path.read_text(encoding="utf-8")
        leaked = [sentinel for sentinel in forbidden if sentinel in text]
        if leaked:
            raise SystemExit(f"audit leaked forbidden values: {leaked!r}")
        PY

        cat > "$TMPDIR/expected-gh.argv" <<'EOF'
        api
        --hostname
        github.com
        --method
        GET
        -H
        Accept: application/vnd.github+json
        -H
        X-GitHub-Api-Version: 2022-11-28
        /repos/alpha/demo
        EOF
        cat > "$TMPDIR/expected-issue-create.argv" <<'EOF'
        api
        --hostname
        github.com
        --method
        POST
        -H
        Accept: application/vnd.github+json
        -H
        X-GitHub-Api-Version: 2022-11-28
        --input
        -
        /repos/alpha/demo/issues
        EOF
        cat > "$TMPDIR/expected-upload.argv" <<'EOF'
        git@github.com
        git-upload-pack 'alpha/demo.git'
        EOF
        cat > "$TMPDIR/expected-receive.argv" <<'EOF'
        git@github.com
        git-receive-pack 'alpha/demo.git'
        EOF
        cat > "$TMPDIR/expected-environment-names" <<'EOF'
        FAKE_HOST_ENV_SENTINEL
        GH_TOKEN
        GITHUB_TOKEN
        GH_ENTERPRISE_TOKEN
        GITHUB_ENTERPRISE_TOKEN
        GH_CONFIG_DIR
        SSH_AUTH_SOCK
        HOME
        BROKER_TEST_PRIVATE
        BROKER_TEST_BARE
        EOF

        for call in 1 2; do
          assert_same "$TMPDIR/expected-gh.argv" "$host_private/gh-calls/$call/argv" \
            "host gh argv was not fixed"
          assert_same "$TMPDIR/expected-environment-names" \
            "$host_private/gh-calls/$call/environment-names" \
            "host gh environment was not inherited"
        done
        assert_same "$TMPDIR/expected-issue-create.argv" "$host_private/gh-calls/3/argv" \
          "host issue-create argv was not fixed"
        assert_same "$TMPDIR/expected-environment-names" \
          "$host_private/gh-calls/3/environment-names" \
          "host issue-create environment was not inherited"
        test ! -e "$host_private/gh-calls/4" || fail "a rejected gh request reached host authority"

        for call in 1 2; do
          assert_same "$TMPDIR/expected-upload.argv" "$host_private/ssh-calls/$call/argv" \
            "host upload-pack argv was not fixed"
          grep -Fx upload "$host_private/ssh-calls/$call/service" > /dev/null
        done
        for call in 3 4; do
          assert_same "$TMPDIR/expected-receive.argv" "$host_private/ssh-calls/$call/argv" \
            "host receive-pack argv was not fixed"
          grep -Fx receive "$host_private/ssh-calls/$call/service" > /dev/null
        done
        test ! -e "$host_private/ssh-calls/5" || fail "a rejected SSH request reached host authority"
        for call in 1 2 3 4; do
          assert_same "$TMPDIR/expected-environment-names" \
            "$host_private/ssh-calls/$call/environment-names" \
            "host SSH environment was not inherited"
        done
        test -s "$host_private/ssh-calls/3/stdin" || fail "feature update did not reach receive-pack"
        test ! -s "$host_private/ssh-calls/4/stdin" || fail "denied main update bytes reached receive-pack"

        feature="$(git --git-dir="$bare" rev-parse refs/heads/feature/task-10)"
        final_main="$(git --git-dir="$bare" rev-parse refs/heads/main)"
        test "$feature" != "$initial_main" || fail "feature branch was not updated"
        test "$final_main" = "$initial_main" || fail "main branch changed despite policy"
        git --git-dir="$bare" fsck --strict --no-dangling > /dev/null 2>&1

        stop_agent_listener
        test ! -S "$agent_socket" || fail "SSH agent listener socket was not cleaned"
        touch "$out"
      '';
}
