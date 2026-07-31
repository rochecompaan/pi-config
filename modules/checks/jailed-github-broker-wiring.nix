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
      inherit (pkgs) lib;
      brokerLib = import ../../nix/lib/jailed-github-broker.nix {
        inherit lib pkgs;
      };

      normalizedDefaults = brokerLib.normalize { };
      normalizedFrameCapMinusOne = brokerLib.normalize {
        limits.maxStreamFrameBytes = brokerLib.maxStreamFrameBytes - 1;
      };
      normalizedFrameCap = brokerLib.normalize {
        limits.maxStreamFrameBytes = brokerLib.maxStreamFrameBytes;
      };
      normalizedOverrides = brokerLib.normalize {
        enable = true;
        repository = "acme/demo";
        capabilities = [
          "repository:read"
          "git:read"
          "git:write"
        ];
        pushPolicy = {
          denyRefs = [ ];
          denyDeletes = true;
          maxRefUpdates = 3;
        };
        limits = {
          maxConcurrentRequests = 2;
          maxControlBytes = 4096;
          maxStreamFrameBytes = 2048;
          maxPushPrefixBytes = 8192;
          initialFrameTimeoutSeconds = 1;
          operationTimeoutSeconds = 30;
          idleStreamTimeoutSeconds = 4;
        };
      };
      rejects = value: !(builtins.tryEval (builtins.deepSeq (brokerLib.normalize value) true)).success;
      invalidConfigurations = [
        { enable = true; }
        {
          enable = true;
          repository = "acme/demo/extra";
        }
        {
          enable = true;
          repository = "-acme/demo";
        }
        {
          enable = true;
          repository = "acme/.";
        }
        { unknown = true; }
        { pushPolicy.unknown = true; }
        { limits.unknown = 1; }
        { capabilities = [ "unknown:read" ]; }
        { capabilities = [ "git:write" ]; }
        {
          capabilities = [
            "git:read"
            "git:read"
          ];
        }
        { pushPolicy.denyRefs = [ "main" ]; }
        {
          pushPolicy.denyRefs = [
            "refs/heads/topic"
            "refs/heads/topic"
          ];
        }
        { pushPolicy.maxRefUpdates = 0; }
        { limits.maxConcurrentRequests = 0; }
        { limits.maxControlBytes = 0; }
        { limits.maxStreamFrameBytes = 0; }
        { limits.maxStreamFrameBytes = brokerLib.maxStreamFrameBytes + 1; }
        { limits.maxPushPrefixBytes = 0; }
        { limits.initialFrameTimeoutSeconds = 0; }
        { limits.operationTimeoutSeconds = 0; }
        { limits.idleStreamTimeoutSeconds = 0; }
      ];

      fakePi = pkgs.writeShellApplication {
        name = "pi";
        text = "exit 0";
      };
      fakeAgentConfig = pkgs.runCommand "jailed-github-broker-wiring-agent-config" { } ''
        mkdir -p "$out"
      '';
      mkJailed =
        name: args:
        self'.lib.mkJailedPi (
          {
            inherit name;
            piPackage = fakePi;
            agentConfigPackage = fakeAgentConfig;
            authMode = "local";
            inheritGitIdentity = false;
            extraPkgs = [ ];
            runtimeClosurePkgs = [ ];
          }
          // args
        );
      disabledDefault = mkJailed "jailed-github-broker-disabled" { };
      disabledExplicit = mkJailed "jailed-github-broker-disabled" { githubBroker.enable = false; };
      enabledJailed = mkJailed "jailed-github-broker-enabled" {
        githubBroker = {
          enable = true;
          repository = "acme/demo";
          capabilities = [
            "git:read"
            "git:write"
          ];
          pushPolicy = {
            denyRefs = [ ];
            denyDeletes = true;
            maxRefUpdates = 2;
          };
          limits.operationTimeoutSeconds = 45;
        };
      };
      forbiddenCredentialJailed = builtins.tryEval (
        builtins.deepSeq (mkJailed "jailed-github-broker-forbidden-token" {
          githubBroker = {
            enable = true;
            repository = "acme/demo";
          };
          apiKeys.GH_TOKEN.fromEnv = true;
        }) true
      );

      homePkgs = import inputs.nixpkgs {
        inherit system;
        config.allowUnfreePredicate = package: lib.getName package == "1password-cli";
      };
      home = inputs.home-manager.lib.homeManagerConfiguration {
        pkgs = homePkgs;
        modules = [
          self.homeModules.pi
          self.homeModules."jailed-pi"
          {
            home.username = "jailed-github-broker-wiring";
            home.homeDirectory = "/home/jailed-github-broker-wiring";
            home.stateVersion = "25.11";
            programs.roche-pi = {
              enable = true;
              installNotionCli = false;
              jailed = {
                enable = true;
                packageName = "jailed-github-broker-home";
                githubBroker = {
                  enable = true;
                  repository = "octo-org/octo_repo";
                  capabilities = [ "issues:read" ];
                  pushPolicy.denyRefs = [ "refs/heads/release" ];
                  limits.maxConcurrentRequests = 3;
                };
              };
            };
          }
        ];
      };
      homeJailed = builtins.head (
        builtins.filter (
          package: lib.getName package == "jailed-github-broker-home"
        ) home.config.home.packages
      );

      generatedConfig = brokerLib.mkConfigFile normalizedOverrides;
      lifecycleConfig = brokerLib.mkConfigFile {
        enable = true;
        repository = "acme/demo";
      };
      brokerPackage = self'.packages."jailed-github-broker";
      brokerClientPackage = brokerPackage.client;
      brokerClientClosure = pkgs.closureInfo {
        rootPaths = [ brokerClientPackage ];
      };

      fakeUnrelatedWatcher = pkgs.writeShellApplication {
        name = "fake-unrelated-watcher";
        runtimeInputs = [ pkgs.coreutils ];
        text = ''
          test_dir="$1"
          trap 'printf "TERM\n" > "$test_dir/unrelated-signal"; exit 0' TERM
          printf '%s\n' "$$" > "$test_dir/unrelated-pid"
          while true; do sleep 1; done
        '';
      };

      fakeJailParentHandshake = pkgs.writeShellScript "fake-jail-parent-handshake" ''
        expected_parent_pid="$1"
        expected_parent_identity="$2"
        shift 2
        actual_parent_identity="$(${pkgs.gawk}/bin/awk '{ sub(/^.*\) /, ""); print $20 }' "/proc/$PPID/stat" 2>/dev/null || true)"
        if [ "$PPID" != "$expected_parent_pid" ] \
          || [ "$actual_parent_identity" != "$expected_parent_identity" ]; then
          exit 1
        fi
        exec "$@"
      '';

      fakeBroker = pkgs.writeShellApplication {
        name = "jailed-github-broker";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.python3
        ];
        text = ''
                    test_dir="''${TEST_DIR:?}"
                    mode="''${FAKE_BROKER_MODE:-normal}"
                    test "$1" = serve
                    shift
                    config=
                    socket=
                    ready=
                    audit_fd=
                    while [ "$#" -gt 0 ]; do
                      case "$1" in
                        --config) config="$2" ;;
                        --socket) socket="$2" ;;
                        --ready-file) ready="$2" ;;
                        --audit-fd) audit_fd="$2" ;;
                        *) exit 90 ;;
                      esac
                      shift 2
                    done
                    test -r "$config"
                    test "$audit_fd" = 3
                    test -f "/proc/$$/fd/$audit_fd"
                    read -r recorded_manager_pid recorded_manager_identity \
                      < "$(dirname "$socket")/manager.identity"
                    test "$recorded_manager_pid" = "$PPID"
                    actual_manager_identity="$(${pkgs.gawk}/bin/awk '{ sub(/^.*\) /, ""); print $20 }' "/proc/$PPID/stat")"
                    test "$recorded_manager_identity" = "$actual_manager_identity"
                    printf '%s\n' \
                      '{"operation":"repository.get","request_id":"9001","repository":"acme/demo","duration_ms":1,"exit_status":0,"refs":[],"stdin_bytes":2,"stdout_bytes":42,"stderr_bytes":0}' \
                      '{"operation":"git.receivePack","request_id":"9002","repository":"acme/demo","duration_ms":2,"exit_status":0,"refs":["refs/heads/feature"],"stdin_bytes":81,"stdout_bytes":42,"stderr_bytes":7}' \
                      >&3
                    printf '%s\n' RAW-BROKER-STDERR-SENTINEL >&2
                    if [ -n "''${GH_TOKEN:-}" ]; then
                      touch "$test_dir/broker-inherited-host-auth"
                    fi
                    anchor_pid="$(${pkgs.gawk}/bin/awk '{ sub(/^.*\) /, ""); print $4 }' "/proc/$$/stat")"
                    printf '%s\n' "$anchor_pid $$" > "$test_dir/broker-pids"
                    printf '%s\n' "$PPID" > "$test_dir/broker-parent-pid"
                    ${pkgs.gawk}/bin/awk '{ sub(/^.*\) /, ""); print $20 }' "/proc/$PPID/stat" \
                      > "$test_dir/broker-parent-identity"
                    ${pkgs.gawk}/bin/awk '{ sub(/^.*\) /, ""); print $20 }' "/proc/$$/stat" \
                      > "$test_dir/broker-identity"
                    stat -c '%u %a' "$(dirname "$socket")" > "$test_dir/runtime-directory-stat"

                    if [ "$mode" = exit-before-ready ]; then
                      exit 7
                    fi
                    if [ "$mode" = ready-before-socket ]; then
                      printf 'ready\n' > "$ready"
                      sleep 2
                    fi

                    python3 - "$socket" "$mode" "$test_dir" <<'PY' &
          import os
          import signal
          import socket
          import sys
          import time
          path, mode, test_dir = sys.argv[1:]
          sock = socket.socket(socket.AF_UNIX)
          sock.bind(path)
          os.chmod(path, 0o666 if mode == "bad-mode" else 0o600)
          sock.listen()
          if mode in ("stubborn", "anchor-lost-stubborn"):
              signal.signal(signal.SIGTERM, signal.SIG_IGN)
              with open(os.path.join(test_dir, "stubborn-pid"), "w", encoding="utf-8") as handle:
                  handle.write(str(os.getpid()))
          while True:
              time.sleep(1)
          PY
                    socket_pid=$!
                    printf '%s\n' "$socket_pid" > "$test_dir/broker-child-pid"
                    ${pkgs.gawk}/bin/awk '{ sub(/^.*\) /, ""); print $20 }' "/proc/$socket_pid/stat" \
                      > "$test_dir/broker-child-identity"
                    handle_broker_term() {
                      printf "TERM\n" >> "$test_dir/broker-signals"
                      if [ "$mode" = cleanup-signal ]; then
                        wrapper_pid="$(${pkgs.procps}/bin/ps -o ppid= -p "$PPID" | ${pkgs.coreutils}/bin/tr -d ' ')"
                        kill -HUP "$wrapper_pid"
                      fi
                      kill -TERM "$socket_pid" 2>/dev/null || true
                      wait "$socket_pid" 2>/dev/null || true
                      exit 0
                    }
                    trap handle_broker_term TERM
                    while [ ! -S "$socket" ]; do
                      kill -0 "$socket_pid"
                      sleep 0.01
                    done

                    if [ "$mode" != never-ready ]; then
                      printf 'ready\n' > "$ready"
                    fi
                    if [ "$mode" = exit-after-ready ]; then
                      kill "$socket_pid"
                      wait "$socket_pid" || true
                      exit 0
                    fi
                    if [ "$mode" = exit-after-jail-start ]; then
                      while [ ! -e "$test_dir/jail-started" ]; do
                        sleep 0.01
                      done
                      sleep 0.1
                      ${pkgs.util-linux}/bin/setsid ${fakeUnrelatedWatcher}/bin/fake-unrelated-watcher "$test_dir" &
                      while [ ! -e "$test_dir/unrelated-pid" ]; do
                        sleep 0.01
                      done
                      kill "$socket_pid"
                      wait "$socket_pid" || true
                      exit 23
                    fi
                    if [ "$mode" = anchor-lost-after-jail-start ] \
                      || [ "$mode" = anchor-lost-stubborn ]; then
                      while [ ! -e "$test_dir/jail-started" ]; do
                        sleep 0.01
                      done
                      ${pkgs.util-linux}/bin/setsid ${fakeUnrelatedWatcher}/bin/fake-unrelated-watcher "$test_dir" &
                      while [ ! -e "$test_dir/unrelated-pid" ]; do
                        sleep 0.01
                      done
                      kill -KILL "$anchor_pid"
                    fi
                    while true; do
                      wait "$socket_pid" || true
                    done
        '';
      };

      fakeJail = pkgs.writeShellApplication {
        name = "fake-jailed-pi";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.gawk
          pkgs.python3
        ];
        text = ''
          test_dir="''${TEST_DIR:?}"
          jail_fd_records=
          for jail_fd_number in 0 1 2 3 4 5 6 7 8 9 255; do
            jail_fd="/proc/$$/fd/$jail_fd_number"
            [ -e "$jail_fd" ] || continue
            printf -v jail_fd_record '%s %s' "$jail_fd_number" \
              "$(${pkgs.coreutils}/bin/readlink "$jail_fd" 2>/dev/null || true)"
            jail_fd_records="''${jail_fd_records}''${jail_fd_record}"$'\n'
          done
          printf '%s' "$jail_fd_records" > "$test_dir/jail-fds"
          env | sort > "$test_dir/jail-environment"
          printf '%s\n' "$*" > "$test_dir/jail-arguments"
          jail_mode="''${FAKE_JAIL_MODE:-responsive}"
          trap 'printf "TERM\n" > "$test_dir/jail-signal"; exit "''${FAKE_SIGNAL_STATUS:-143}"' TERM
          trap 'printf "HUP\n" > "$test_dir/jail-signal"; exit "''${FAKE_SIGNAL_STATUS:-129}"' HUP
          trap 'printf "INT\n" > "$test_dir/jail-signal"; exit "''${FAKE_SIGNAL_STATUS:-130}"' INT
          if [ "$jail_mode" = stubborn ]; then
            trap ':' HUP INT TERM
          fi
          if [ "$jail_mode" = outer-death ] && [ "''${FAKE_JAIL_PDEATH_ARMED:-0}" -eq 0 ]; then
            parent_pid="$PPID"
            parent_identity="$(${pkgs.gawk}/bin/awk '{ sub(/^.*\) /, ""); print $20 }' "/proc/$parent_pid/stat")"
            exec ${pkgs.coreutils}/bin/env FAKE_JAIL_PDEATH_ARMED=1 \
              ${pkgs.util-linux}/bin/setpriv --pdeathsig KILL ${fakeJailParentHandshake} \
              "$parent_pid" "$parent_identity" "$0" "$@"
          fi
          printf '%s\n' "$$" > "$test_dir/jail-pid"
          ${pkgs.gawk}/bin/awk '{ sub(/^.*\) /, ""); print $20 }' "/proc/$$/stat" \
            > "$test_dir/jail-identity"
          if [ "$jail_mode" = stdin-probe ]; then
            if IFS= read -r jail_stdin; then
              printf '%s\n' "$jail_stdin" > "$test_dir/jail-stdin"
              if [ "$jail_stdin" != stdin-preserved ]; then
                exit 74
              fi
              exit 0
            fi
            touch "$test_dir/jail-stdin-eof"
            exit 75
          fi
          if [ "$jail_mode" = immediate-exit ]; then
            jail_pid="$$"
            wrapper_pid="$PPID"
            python3 - "$jail_pid" "$wrapper_pid" "$test_dir/jail-zombie-ready" <<'PY' &
          import os
          import signal
          import sys
          import time
          jail_pid, wrapper_pid = map(int, sys.argv[1:3])
          ready_path = sys.argv[3]
          for _ in range(500):
              try:
                  with open(f"/proc/{jail_pid}/stat", encoding="utf-8") as handle:
                      state = handle.read().rsplit(") ", 1)[1].split()[0]
                  if state == "Z":
                      break
              except FileNotFoundError:
                  break
              time.sleep(0.01)
          with open(ready_path, "w", encoding="utf-8"):
              pass
          os.kill(wrapper_pid, signal.SIGCONT)
          PY
            kill -STOP "$wrapper_pid"
            exit "''${FAKE_JAIL_STATUS:-73}"
          fi
          if [ "$jail_mode" = signal-before-identity ]; then
            kill -TERM "$PPID"
          fi
          touch "$test_dir/jail-started"
          if [ "''${FAKE_JAIL_WAIT:-0}" = 1 ]; then
            while true; do sleep 0.05; done
          fi
          exit "''${FAKE_JAIL_STATUS:-0}"
        '';
      };

      mkLifecycleWrapper =
        name:
        pkgs.writeShellApplication {
          inherit name;
          runtimeInputs = brokerLib.lifecycleRuntimeInputs;
          text = brokerLib.mkLifecycleScript {
            brokerPackage = fakeBroker;
            configFile = lifecycleConfig;
            jailExecutable = lib.getExe fakeJail;
            readinessAttempts = 5;
            cleanupAttempts = 5;
          };
        };
      lifecycleWrapper = mkLifecycleWrapper "jailed-github-broker-lifecycle-test";
      shellKillGuard = pkgs.writeShellScript "jailed-github-broker-shell-kill-guard" ''
        for argument in "$@"; do
          case "$argument" in
            -[0-9]*)
              ${pkgs.coreutils}/bin/touch "$TEST_DIR/unsafe-negative-pgid-signal"
              exit 99
              ;;
          esac
        done
        exec ${pkgs.coreutils}/bin/kill "$@"
      '';
      guardedShellKillWrapper = pkgs.writeShellApplication {
        name = "jailed-github-broker-guarded-shell-kill-test";
        runtimeInputs = brokerLib.lifecycleRuntimeInputs;
        text = builtins.replaceStrings [ "${pkgs.coreutils}/bin/kill" ] [ "${shellKillGuard}" ] (
          brokerLib.mkLifecycleScript {
            brokerPackage = fakeBroker;
            configFile = lifecycleConfig;
            jailExecutable = lib.getExe fakeJail;
            readinessAttempts = 5;
            cleanupAttempts = 5;
          }
        );
      };
      fakePreSupervisorAnchor = pkgs.writeShellApplication {
        name = "jailed-github-broker-anchor-supervisor";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.python3
          pkgs.util-linux
        ];
        text = ''
          # shellcheck disable=SC2016
          exec ${pkgs.util-linux}/bin/setsid ${pkgs.runtimeShell} -c '
            runtime_directory="$4"
            while [ ! -e "$runtime_directory/pre-supervisor-release" ]; do
              ${pkgs.coreutils}/bin/sleep 0.01
            done
          ${pkgs.python3}/bin/python3 -c "import socket, sys; socket_handle = socket.socket(socket.AF_UNIX); socket_handle.bind(sys.argv[1]); socket_handle.listen(); socket_handle.close()" \
            "$runtime_directory/broker.sock"
          ${pkgs.coreutils}/bin/touch "''${TEST_DIR:?}/pre-supervisor-died"
            kill -KILL "$$"
          ' pre-supervisor-anchor "$@"
        '';
      };
      preSupervisorAnchorLossWrapper = pkgs.writeShellApplication {
        name = "jailed-github-broker-pre-supervisor-anchor-loss-test";
        runtimeInputs = brokerLib.lifecycleRuntimeInputs;
        text =
          builtins.replaceStrings
            [ "anchor_identity=\"$actual_identity\"\n      break" ]
            [
              "anchor_identity=\"$actual_identity\"\n      ${pkgs.coreutils}/bin/touch \"$broker_runtime_dir/pre-supervisor-release\"\n      break"
            ]
            (
              brokerLib.mkLifecycleScript {
                brokerPackage = fakeBroker;
                configFile = lifecycleConfig;
                jailExecutable = lib.getExe fakeJail;
                readinessAttempts = 5;
                cleanupAttempts = 5;
                anchorSupervisor = fakePreSupervisorAnchor;
              }
            );
      };
      fakePreIdentityAnchorFailure = pkgs.writeShellApplication {
        name = "jailed-github-broker-anchor-supervisor";
        text = ''
          exit 1
        '';
      };
      preIdentityAnchorFailureWrapper = pkgs.writeShellApplication {
        name = "jailed-github-broker-pre-identity-anchor-failure-test";
        runtimeInputs = brokerLib.lifecycleRuntimeInputs;
        text =
          builtins.replaceStrings
            [
              ''
                anchor_pid=$!
                anchor_was_started=1

                identity_attempt=0''
            ]
            [
              ''
                anchor_pid=$!
                anchor_was_started=1
                ${pkgs.python3}/bin/python3 -c "import socket, sys; socket_handle = socket.socket(socket.AF_UNIX); socket_handle.bind(sys.argv[1]); socket_handle.listen(); socket_handle.close()" \
                  "$broker_runtime_dir/broker.sock"
                test -z "$anchor_identity"
                test -z "$(process_record "$anchor_pid")"
                ${pkgs.coreutils}/bin/touch "$TEST_DIR/pre-identity-empty-proven"

                identity_attempt=0''
            ]
            (
              brokerLib.mkLifecycleScript {
                brokerPackage = fakeBroker;
                configFile = lifecycleConfig;
                jailExecutable = lib.getExe fakeJail;
                readinessAttempts = 5;
                cleanupAttempts = 5;
                anchorSupervisor = fakePreIdentityAnchorFailure;
              }
            );
      };
      outerDeathWrapper = pkgs.writeShellApplication {
        name = "jailed-github-broker-outer-death-test";
        runtimeInputs = brokerLib.lifecycleRuntimeInputs;
        text =
          builtins.replaceStrings
            [
              ''
                anchor_pid=$!
                anchor_was_started=1

                identity_attempt=0''
            ]
            [
              ''
                anchor_pid=$!
                anchor_was_started=1
                anchor_test_record="$(process_record "$anchor_pid")"
                read -r _anchor_test_state _anchor_test_pgid _anchor_test_session anchor_test_identity \
                  <<< "$anchor_test_record"
                printf '%s %s\n' "$anchor_pid" "$anchor_test_identity" > "$TEST_DIR/anchor-start-record"

                identity_attempt=0''
            ]
            (
              brokerLib.mkLifecycleScript {
                brokerPackage = fakeBroker;
                configFile = lifecycleConfig;
                jailExecutable = lib.getExe fakeJail;
                readinessAttempts = 5;
                cleanupAttempts = 5;
              }
            );
      };
      outerDeathCase = pkgs.writeText "jailed-github-broker-outer-death-case.sh" (
        builtins.replaceStrings
          [
            "@SETSID@"
            "@UNRELATED_WATCHER@"
            "@OUTER_DEATH_WRAPPER@"
          ]
          [
            "${pkgs.util-linux}/bin/setsid"
            "${fakeUnrelatedWatcher}/bin/fake-unrelated-watcher"
            "${outerDeathWrapper}/bin/jailed-github-broker-outer-death-test"
          ]
          (builtins.readFile ../../nix/check-support/jailed-github-broker-outer-death-case.sh)
      );
      immediateExitWrapper = pkgs.writeShellApplication {
        name = "jailed-github-broker-immediate-exit-test";
        runtimeInputs = brokerLib.lifecycleRuntimeInputs;
        text =
          builtins.replaceStrings
            [
              ''
                jail_pid=$!
                # A signal can interrupt this loop''
            ]
            [
              ''
                jail_pid=$!
                immediate_gate_attempt=0
                while [ ! -e "$TEST_DIR/jail-zombie-ready" ] && [ "$immediate_gate_attempt" -lt 500 ]; do
                  ${pkgs.coreutils}/bin/sleep 0.01
                  immediate_gate_attempt=$((immediate_gate_attempt + 1))
                done
                test -e "$TEST_DIR/jail-zombie-ready"
                # A signal can interrupt this loop''
            ]
            (
              brokerLib.mkLifecycleScript {
                brokerPackage = fakeBroker;
                configFile = lifecycleConfig;
                jailExecutable = lib.getExe fakeJail;
                readinessAttempts = 5;
                cleanupAttempts = 5;
              }
            );
      };
      stopNotificationLossWrapper = pkgs.writeShellApplication {
        name = "jailed-github-broker-stop-notification-loss-test";
        runtimeInputs = brokerLib.lifecycleRuntimeInputs;
        text =
          builtins.replaceStrings
            [ ''printf 'stop\n' > "$anchor_stop_file.tmp"'' ]
            [
              ''
                ${pkgs.coreutils}/bin/touch "$TEST_DIR/anchor-stop-injected"
                        ${pkgs.coreutils}/bin/kill -KILL "$anchor_pid" 2>/dev/null || true
                        printf 'stop\n' > "$anchor_stop_file.tmp"''
            ]
            (
              brokerLib.mkLifecycleScript {
                brokerPackage = fakeBroker;
                configFile = lifecycleConfig;
                jailExecutable = lib.getExe fakeJail;
                readinessAttempts = 5;
                cleanupAttempts = 5;
              }
            );
      };
      forcedIdentityTimeoutWrapper = pkgs.writeShellApplication {
        name = "jailed-github-broker-forced-identity-timeout-test";
        runtimeInputs = brokerLib.lifecycleRuntimeInputs;
        text =
          builtins.replaceStrings
            [
              ''
                jail_pid=$!
                # A signal can interrupt this loop''
              ''while [ -z "$jail_identity" ] && [ "$identity_attempt" -lt 5 ]; do''
            ]
            [
              ''
                jail_pid=$!
                forced_timeout_gate_attempt=0
                while [ ! -e "$TEST_DIR/jail-pid" ] \
                  && [ "$forced_timeout_gate_attempt" -lt 500 ]; do
                  ${pkgs.coreutils}/bin/sleep 0.01
                  forced_timeout_gate_attempt=$((forced_timeout_gate_attempt + 1))
                done
                test -e "$TEST_DIR/jail-pid"
                # A signal can interrupt this loop''
              ''while [ -z "$jail_identity" ] && [ "$identity_attempt" -lt 0 ]; do''
            ]
            (
              brokerLib.mkLifecycleScript {
                brokerPackage = fakeBroker;
                configFile = lifecycleConfig;
                jailExecutable = lib.getExe fakeJail;
                readinessAttempts = 5;
                cleanupAttempts = 5;
              }
            );
      };
      staleGroupAuthorityWrapper = pkgs.writeShellApplication {
        name = "jailed-github-broker-stale-group-authority-test";
        runtimeInputs = brokerLib.lifecycleRuntimeInputs;
        text =
          builtins.replaceStrings
            [
              ''export ${brokerLib.hostSocketEnvironment}="$broker_socket"''
              "${pkgs.coreutils}/bin/kill"
            ]
            [
              ''
                # shellcheck disable=SC2034
                manager_identity=stale-manager-identity
                broker_identity=stale-broker-identity
                export ${brokerLib.hostSocketEnvironment}="$broker_socket"''
              "${shellKillGuard}"
            ]
            (
              brokerLib.mkLifecycleScript {
                brokerPackage = fakeBroker;
                configFile = lifecycleConfig;
                jailExecutable = lib.getExe fakeJail;
                readinessAttempts = 5;
                cleanupAttempts = 5;
              }
            );
      };
    in
    {
      checks."jailed-github-broker-wiring" =
        assert normalizedDefaults == brokerLib.defaults;
        assert normalizedFrameCapMinusOne.limits.maxStreamFrameBytes == brokerLib.maxStreamFrameBytes - 1;
        assert normalizedFrameCap.limits.maxStreamFrameBytes == brokerLib.maxStreamFrameBytes;
        assert normalizedOverrides.pushPolicy.denyRefs == [ ];
        assert normalizedOverrides.pushPolicy.denyDeletes;
        assert normalizedOverrides.pushPolicy.maxRefUpdates == 3;
        assert normalizedOverrides.limits.maxConcurrentRequests == 2;
        assert normalizedOverrides.limits.maxControlBytes == 4096;
        assert normalizedOverrides.limits.maxStreamFrameBytes == 2048;
        assert normalizedOverrides.limits.maxPushPrefixBytes == 8192;
        assert normalizedOverrides.limits.initialFrameTimeoutSeconds == 1;
        assert normalizedOverrides.limits.operationTimeoutSeconds == 30;
        assert normalizedOverrides.limits.idleStreamTimeoutSeconds == 4;
        assert lib.all rejects invalidConfigurations;
        assert disabledDefault == disabledExplicit;
        assert !forbiddenCredentialJailed.success;
        assert home.config.programs.roche-pi.jailed.githubBroker.repository == "octo-org/octo_repo";
        assert
          home.config.programs.roche-pi.jailed.githubBroker.pushPolicy.denyRefs == [ "refs/heads/release" ];
        assert home.config.programs.roche-pi.jailed.githubBroker.limits.maxConcurrentRequests == 3;
        pkgs.runCommand "jailed-github-broker-wiring-check"
          {
            realJailProof = self'.checks."jailed-github-broker-real-jail";
            nativeBuildInputs = [
              pkgs.coreutils
              pkgs.gnugrep
              pkgs.jq
              pkgs.binutils
              pkgs.procps
            ];
          }
          ''
            set -eu

            export XDG_STATE_HOME="$TMPDIR/host-state"
            mkdir -p "$XDG_STATE_HOME"
            test -e "$realJailProof"

            launcher_for() {
              find "$1/bin" -maxdepth 1 -type f -print -quit
            }
            sandbox_for() {
              sed -n 's|.*--default-signal=HUP,INT,TERM \(/nix/store/[^ ]*-sandbox/bin/[^ ]*\) .*|\1|p' "$1"
            }
            assert_omits() {
              if grep -F -- "$2" "$1" >/dev/null; then
                echo "unexpected generated authority: $2" >&2
                exit 1
              fi
            }
            process_is_live() {
              kill -0 "$1" 2>/dev/null && state="$(ps -o stat= -p "$1" 2>/dev/null)" && [ "''${state#Z}" = "$state" ]
            }
            process_identity() {
              awk '{ sub(/^.*\) /, ""); print $20 }' "/proc/$1/stat" 2>/dev/null || true
            }
            process_matches_identity() {
              actual_identity="$(process_identity "$1")"
              [ -n "$actual_identity" ] && [ "$actual_identity" = "$2" ] && process_is_live "$1"
            }
            bounded_wait_wrapper() {
              waited_pid="$1"
              waited_identity="$2"
              waited_attempt=0
              while [ "$waited_attempt" -lt 100 ] \
                && process_matches_identity "$waited_pid" "$waited_identity"; do
                sleep 0.02
                waited_attempt=$((waited_attempt + 1))
              done
              if process_matches_identity "$waited_pid" "$waited_identity"; then
                kill -TERM "$waited_pid" 2>/dev/null || true
                waited_attempt=0
                while [ "$waited_attempt" -lt 20 ] \
                  && process_matches_identity "$waited_pid" "$waited_identity"; do
                  sleep 0.02
                  waited_attempt=$((waited_attempt + 1))
                done
                if process_matches_identity "$waited_pid" "$waited_identity"; then
                  kill -KILL "$waited_pid" 2>/dev/null || true
                fi
                wait "$waited_pid" 2>/dev/null || true
                return 124
              fi
              set +e
              wait "$waited_pid"
              wrapper_wait_status=$?
              set -e
            }
            terminate_recorded_process() {
              recorded_pid="$1"
              recorded_identity="$2"
              if process_matches_identity "$recorded_pid" "$recorded_identity"; then
                kill -TERM "$recorded_pid" 2>/dev/null || true
              fi
              recorded_attempt=0
              while [ "$recorded_attempt" -lt 20 ] \
                && process_matches_identity "$recorded_pid" "$recorded_identity"; do
                sleep 0.02
                recorded_attempt=$((recorded_attempt + 1))
              done
              if process_matches_identity "$recorded_pid" "$recorded_identity"; then
                kill -KILL "$recorded_pid" 2>/dev/null || true
              fi
              recorded_attempt=0
              while [ "$recorded_attempt" -lt 20 ] \
                && process_matches_identity "$recorded_pid" "$recorded_identity"; do
                sleep 0.02
                recorded_attempt=$((recorded_attempt + 1))
              done
            }

            # Prove the explicit absence/stale-process assertion shape rejects
            # a poisoned fixture instead of being exempted from errexit by !.
            printf '%s\n' poisoned-absence-sentinel > "$TMPDIR/poisoned-absence"
            poisoned_assertion_status=0
            (
              if grep -F poisoned-absence-sentinel "$TMPDIR/poisoned-absence" >/dev/null; then
                exit 1
              fi
            ) || poisoned_assertion_status=$?
            test "$poisoned_assertion_status" -eq 1
            self_identity="$(process_identity "$$")"
            poisoned_assertion_status=0
            (
              if process_matches_identity "$$" "$self_identity"; then
                exit 1
              fi
            ) || poisoned_assertion_status=$?
            test "$poisoned_assertion_status" -eq 1

            default_launcher="$(launcher_for ${disabledDefault})"
            explicit_launcher="$(launcher_for ${disabledExplicit})"
            cmp "$default_launcher" "$explicit_launcher"
            grep -F 'exec /nix/store/' "$default_launcher" >/dev/null
            for forbidden in JAILED_GITHUB_BROKER GIT_SSH_COMMAND ' serve --config '; do
              assert_omits "$default_launcher" "$forbidden"
            done

            enabled_launcher="$(launcher_for ${enabledJailed})"
            enabled_sandbox="$(sandbox_for "$enabled_launcher")"
            test -x "$enabled_sandbox"
            grep -F -- '--config' "$enabled_launcher" >/dev/null
            grep -F -- 'jailed-github-broker-anchor-supervisor' "$enabled_launcher" >/dev/null
            grep -F -- '${brokerPackage}/bin/jailed-github-broker serve' "$enabled_launcher" >/dev/null
            grep -F -- '--audit-fd 3' "$enabled_launcher" >/dev/null
            assert_omits "$enabled_launcher" 'signal_broker_group'
            assert_omits "$enabled_launcher" 'broker_group_authority_live'
            assert_omits "$enabled_launcher" '-"$broker_pgid"'
            grep -F -- '--clearenv' "$enabled_sandbox" >/dev/null
            grep -F -- '--bind "$JAILED_GITHUB_BROKER_HOST_SOCKET" /run/jailed-github-broker/broker.sock' "$enabled_sandbox" >/dev/null
            grep -F -- '--setenv JAILED_GITHUB_BROKER_SOCKET /run/jailed-github-broker/broker.sock' "$enabled_sandbox" >/dev/null
            grep -F -- '--setenv JAILED_GITHUB_BROKER_REPOSITORY acme/demo' "$enabled_sandbox" >/dev/null
            grep -F -- '--setenv GIT_SSH_COMMAND ${brokerClientPackage}/bin/jailed-git-ssh' "$enabled_sandbox" >/dev/null
            grep -F -- '${brokerClientPackage}/bin' "$enabled_sandbox" >/dev/null
            jail_path="$(sed -n 's|.* --setenv PATH \([^ ]*\) --setenv LANG .*|\1|p' "$enabled_sandbox")"
            test -n "$jail_path"
            test "$(PATH="$jail_path" command -v gh)" = '${brokerClientPackage}/bin/gh'
            test -x ${brokerClientPackage}/bin/gh
            test ! -e ${brokerClientPackage}/bin/jailed-github-broker
            test -x ${brokerPackage}/bin/jailed-github-broker
            if grep -Fx -- '${pkgs.gh}' ${brokerClientClosure}/store-paths \
              || grep -Fx -- '${pkgs.openssh}' ${brokerClientClosure}/store-paths; then
              echo "jail client closure contains a host tool output" >&2
              exit 1
            fi
            if strings ${brokerClientPackage}/bin/gh | grep -F \
              -e '${pkgs.gh}/bin/gh' -e '${pkgs.openssh}/bin/ssh' \
              -e '/usr/bin/gh' -e '/usr/bin/ssh'; then
              echo "jail client embeds a host tool path" >&2
              exit 1
            fi
            for generated in "$enabled_launcher" "$enabled_sandbox"; do
              for forbidden in GH_TOKEN GITHUB_TOKEN GH_CONFIG_DIR SSH_AUTH_SOCK '$HOME/.config/gh' '$HOME/.ssh' '/etc/ssh'; do
                assert_omits "$generated" "$forbidden"
              done
            done

            home_launcher="$(launcher_for ${homeJailed})"
            home_sandbox="$(sandbox_for "$home_launcher")"
            test -x "$home_sandbox"
            grep -F -- '--setenv JAILED_GITHUB_BROKER_REPOSITORY octo-org/octo_repo' "$home_sandbox" >/dev/null

            jq -e '
              keys == ["capabilities", "enable", "limits", "pushPolicy", "repository"] and
              .enable == true and .repository == "acme/demo" and
              .capabilities == ["repository:read", "git:read", "git:write"] and
              .pushPolicy == {"denyDeletes":true,"denyRefs":[],"maxRefUpdates":3} and
              .limits == {
                "idleStreamTimeoutSeconds":4,
                "initialFrameTimeoutSeconds":1,
                "maxConcurrentRequests":2,
                "maxControlBytes":4096,
                "maxPushPrefixBytes":8192,
                "maxStreamFrameBytes":2048,
                "operationTimeoutSeconds":30
              }
            ' ${generatedConfig} >/dev/null
            if grep -Ei 'token|credential|password|executable|socket|configDir|ssh' ${generatedConfig}; then
              echo "generated broker JSON contains secret or host/client authority" >&2
              exit 1
            fi

            run_success() {
              case_dir="$TMPDIR/$1"
              mkdir -p "$case_dir/runtime"
              export TEST_DIR="$case_dir"
              export XDG_RUNTIME_DIR="$case_dir/runtime"
              export FAKE_BROKER_MODE="$2"
              export FAKE_JAIL_STATUS=37
              export GH_TOKEN='host-secret-preserved'
              export SSH_AUTH_SOCK="$case_dir/host-agent.sock"
              set +e
              ${lifecycleWrapper}/bin/jailed-github-broker-lifecycle-test alpha 'two words' >"$case_dir/stdout" 2>"$case_dir/stderr"
              status=$?
              set -e
              test "$status" -eq 37
              grep -Fx "$(id -u) 700" "$case_dir/runtime-directory-stat" >/dev/null
              grep -Fx 'alpha two words' "$case_dir/jail-arguments" >/dev/null
              grep -Fx 'TERM' "$case_dir/broker-signals" >/dev/null
              test -e "$case_dir/broker-inherited-host-auth"
              test "$GH_TOKEN" = host-secret-preserved
              test "$SSH_AUTH_SOCK" = "$case_dir/host-agent.sock"
              test -z "$(find "$case_dir/runtime" -mindepth 1 -print -quit)"
              audit_log="$XDG_STATE_HOME/pi/jailed-github-broker/audit.jsonl"
              test -f "$audit_log"
              test "$(stat -c %a "$XDG_STATE_HOME/pi/jailed-github-broker")" = 700
              test "$(stat -c %a "$audit_log")" = 600
              grep -F '"operation":"repository.get"' "$audit_log" >/dev/null
              grep -F '"operation":"git.receivePack"' "$audit_log" >/dev/null
              if grep -F RAW-BROKER-STDERR-SENTINEL "$audit_log" >/dev/null; then
                echo "raw broker stderr reached the audit log" >&2
                exit 1
              fi
              if grep -F "$audit_log" "$case_dir/jail-fds" >/dev/null; then
                echo "jail inherited the host audit path" >&2
                exit 1
              fi
              if grep -E '^3 ' "$case_dir/jail-fds" >/dev/null; then
                echo "jail inherited the host audit descriptor" >&2
                exit 1
              fi
              if [ "$2" != stubborn ]; then
                test ! -s "$case_dir/stderr"
              fi
              if [ -f "$case_dir/stubborn-pid" ]; then
                stubborn_pid="$(cat "$case_dir/stubborn-pid")"
                attempt=0
                while [ "$attempt" -lt 20 ] && process_is_live "$stubborn_pid"; do
                  sleep 0.05
                  attempt=$((attempt + 1))
                done
                if process_is_live "$stubborn_pid"; then
                  echo "stubborn broker descendant survived cleanup" >&2
                  exit 1
                fi
              fi
            }
            run_success normal normal
            run_success stubborn stubborn

            run_failure() {
              case_dir="$TMPDIR/$1"
              mkdir -p "$case_dir/runtime"
              export TEST_DIR="$case_dir"
              export XDG_RUNTIME_DIR="$case_dir/runtime"
              export FAKE_BROKER_MODE="$2"
              export FAKE_JAIL_STATUS=0
              export GH_TOKEN='failure-secret'
              if ${lifecycleWrapper}/bin/jailed-github-broker-lifecycle-test >"$case_dir/stdout" 2>"$case_dir/stderr"; then
                echo "expected lifecycle failure for $2" >&2
                exit 1
              fi
              test ! -e "$case_dir/jail-started"
              test -z "$(find "$case_dir/runtime" -mindepth 1 -print -quit)"
              if grep -F 'failure-secret' "$case_dir/stderr"; then
                echo "failure stderr disclosed a secret sentinel" >&2
                exit 1
              fi
              if grep -F "$case_dir" "$case_dir/stderr"; then
                echo "failure stderr disclosed a state path" >&2
                exit 1
              fi
            }
            run_failure bad-mode bad-mode
            run_failure ordering ready-before-socket
            run_failure dead exit-after-ready
            run_failure timeout never-ready

            audit_failure_dir="$TMPDIR/audit-setup-failure"
            mkdir -p "$audit_failure_dir/runtime"
            : > "$audit_failure_dir/not-a-directory"
            export TEST_DIR="$audit_failure_dir"
            export XDG_RUNTIME_DIR="$audit_failure_dir/runtime"
            saved_state_home="$XDG_STATE_HOME"
            export XDG_STATE_HOME="$audit_failure_dir/not-a-directory"
            export GH_TOKEN=audit-setup-secret-sentinel
            set +e
            ${lifecycleWrapper}/bin/jailed-github-broker-lifecycle-test \
              >"$audit_failure_dir/stdout" 2>"$audit_failure_dir/stderr"
            audit_failure_status=$?
            set -e
            export XDG_STATE_HOME="$saved_state_home"
            test "$audit_failure_status" -eq 1
            printf '%s\n' 'jailed GitHub broker: audit setup failed' \
              > "$audit_failure_dir/expected-stderr"
            cmp "$audit_failure_dir/expected-stderr" "$audit_failure_dir/stderr"
            test ! -e "$audit_failure_dir/jail-started"
            test -z "$(find "$audit_failure_dir/runtime" -mindepth 1 -print -quit)"

            run_broker_loss() {
              broker_loss_dir="$TMPDIR/$1"
              mkdir -p "$broker_loss_dir/runtime"
              export TEST_DIR="$broker_loss_dir"
              export XDG_RUNTIME_DIR="$broker_loss_dir/runtime"
              export FAKE_BROKER_MODE="$2"
              export FAKE_JAIL_WAIT=1
              set +e
              timeout 5 ${lifecycleWrapper}/bin/jailed-github-broker-lifecycle-test \
                >"$broker_loss_dir/stdout" 2>"$broker_loss_dir/stderr"
              broker_loss_status=$?
              set -e
              test "$broker_loss_status" -ne 0
              test "$broker_loss_status" -ne 124
              grep -F 'broker exited unexpectedly while jail was running' "$broker_loss_dir/stderr" >/dev/null
              grep -Fx TERM "$broker_loss_dir/jail-signal" >/dev/null
              unrelated_pid="$(cat "$broker_loss_dir/unrelated-pid")"
              unrelated_identity="$(process_identity "$unrelated_pid")"
              process_matches_identity "$unrelated_pid" "$unrelated_identity"
              test ! -e "$broker_loss_dir/unrelated-signal"
              if process_matches_identity "$unrelated_pid" "$unrelated_identity"; then
                kill -TERM "$unrelated_pid"
              fi
              attempt=0
              while [ "$attempt" -lt 20 ] \
                && process_matches_identity "$unrelated_pid" "$unrelated_identity"; do
                sleep 0.05
                attempt=$((attempt + 1))
              done
              if process_matches_identity "$unrelated_pid" "$unrelated_identity"; then
                echo "unrelated watcher survived requested test teardown" >&2
                exit 1
              fi
              test -z "$(find "$broker_loss_dir/runtime" -mindepth 1 -print -quit)"
            }
            cat > "$TMPDIR/trace-anchor-kill.bash" <<'SH'
            kill() {
              if [ "$0" = anchor ]; then
                printf '%s\n' "$*" >> "$TEST_DIR/anchor-direct-kill"
              fi
              command kill "$@"
            }
            SH
            export BASH_ENV="$TMPDIR/trace-anchor-kill.bash"
            run_broker_loss broker-child-stale-state exit-after-jail-start
            unset BASH_ENV
            test ! -e "$TMPDIR/broker-child-stale-state/anchor-direct-kill"
            run_anchor_loss() {
              anchor_loss_dir="$TMPDIR/anchor-only-loss"
              mkdir -p "$anchor_loss_dir/runtime"
              export TEST_DIR="$anchor_loss_dir"
              export XDG_RUNTIME_DIR="$anchor_loss_dir/runtime"
              export FAKE_BROKER_MODE=anchor-lost-stubborn
              export FAKE_JAIL_WAIT=1
              set +e
              timeout -k 1 5 ${guardedShellKillWrapper}/bin/jailed-github-broker-guarded-shell-kill-test \
                >"$anchor_loss_dir/stdout" 2>"$anchor_loss_dir/stderr"
              anchor_loss_status=$?
              set -e
              test "$anchor_loss_status" -ne 0
              test "$anchor_loss_status" -ne 124
              test "$anchor_loss_status" -ne 137
              grep -Fx TERM "$anchor_loss_dir/jail-signal" >/dev/null

              read -r _anchor_pid recorded_broker_pid < "$anchor_loss_dir/broker-pids"
              recorded_broker_identity="$(cat "$anchor_loss_dir/broker-identity")"
              recorded_child_pid="$(cat "$anchor_loss_dir/broker-child-pid")"
              recorded_child_identity="$(cat "$anchor_loss_dir/broker-child-identity")"
              stubborn_pid="$(cat "$anchor_loss_dir/stubborn-pid")"
              stubborn_identity="$(process_identity "$stubborn_pid")"
              anchor_loss_leak=0
              if process_matches_identity "$recorded_broker_pid" "$recorded_broker_identity"; then
                anchor_loss_leak=1
              fi
              if process_matches_identity "$recorded_child_pid" "$recorded_child_identity"; then
                anchor_loss_leak=1
              fi
              if process_matches_identity "$stubborn_pid" "$stubborn_identity"; then
                anchor_loss_leak=1
              fi

              unrelated_pid="$(cat "$anchor_loss_dir/unrelated-pid")"
              unrelated_identity="$(process_identity "$unrelated_pid")"
              process_matches_identity "$unrelated_pid" "$unrelated_identity"
              test ! -e "$anchor_loss_dir/unrelated-signal"

              terminate_recorded_process "$recorded_broker_pid" "$recorded_broker_identity"
              terminate_recorded_process "$recorded_child_pid" "$recorded_child_identity"
              terminate_recorded_process "$stubborn_pid" "$stubborn_identity"
              terminate_recorded_process "$unrelated_pid" "$unrelated_identity"
              test "$anchor_loss_leak" -eq 0
              test ! -e "$anchor_loss_dir/unsafe-negative-pgid-signal"
              test -z "$(find "$anchor_loss_dir/runtime" -mindepth 1 -print -quit)"
            }
            run_anchor_loss

            pre_supervisor_loss_dir="$TMPDIR/pre-supervisor-anchor-loss"
            mkdir -p "$pre_supervisor_loss_dir/runtime"
            export TEST_DIR="$pre_supervisor_loss_dir"
            export XDG_RUNTIME_DIR="$pre_supervisor_loss_dir/runtime"
            export FAKE_BROKER_MODE=normal
            export FAKE_JAIL_MODE=responsive
            export FAKE_JAIL_WAIT=0
            set +e
            timeout -k 1 5 ${preSupervisorAnchorLossWrapper}/bin/jailed-github-broker-pre-supervisor-anchor-loss-test \
              >"$pre_supervisor_loss_dir/stdout" 2>"$pre_supervisor_loss_dir/stderr"
            pre_supervisor_loss_status=$?
            set -e
            test "$pre_supervisor_loss_status" -eq 1
            test -e "$pre_supervisor_loss_dir/pre-supervisor-died"
            test ! -e "$pre_supervisor_loss_dir/jail-started"
            test ! -e "$pre_supervisor_loss_dir/jail-pid"
            test ! -e "$pre_supervisor_loss_dir/broker-pids"
            test ! -e "$pre_supervisor_loss_dir/broker-parent-pid"
            test ! -e "$pre_supervisor_loss_dir/broker-child-pid"
            test ! -e "$pre_supervisor_loss_dir/stubborn-pid"
            test -z "$(find "$pre_supervisor_loss_dir/runtime" -mindepth 1 -print -quit)"

            pre_identity_failure_dir="$TMPDIR/pre-identity-anchor-failure"
            mkdir -p "$pre_identity_failure_dir/runtime"
            export TEST_DIR="$pre_identity_failure_dir"
            export XDG_RUNTIME_DIR="$pre_identity_failure_dir/runtime"
            export FAKE_BROKER_MODE=normal
            export FAKE_JAIL_MODE=responsive
            export FAKE_JAIL_WAIT=0
            set +e
            timeout -k 1 5 ${preIdentityAnchorFailureWrapper}/bin/jailed-github-broker-pre-identity-anchor-failure-test \
              >"$pre_identity_failure_dir/stdout" 2>"$pre_identity_failure_dir/stderr"
            pre_identity_failure_status=$?
            set -e
            test "$pre_identity_failure_status" -eq 1
            test -e "$pre_identity_failure_dir/pre-identity-empty-proven"
            test ! -e "$pre_identity_failure_dir/jail-started"
            test ! -e "$pre_identity_failure_dir/jail-pid"
            test ! -e "$pre_identity_failure_dir/broker-pids"
            test ! -e "$pre_identity_failure_dir/broker-parent-pid"
            test ! -e "$pre_identity_failure_dir/broker-child-pid"
            test ! -e "$pre_identity_failure_dir/stubborn-pid"
            test -z "$(find "$pre_identity_failure_dir/runtime" -mindepth 1 -print -quit)"

            stale_authority_dir="$TMPDIR/stale-group-authority"
            mkdir -p "$stale_authority_dir/runtime"
            export TEST_DIR="$stale_authority_dir"
            export XDG_RUNTIME_DIR="$stale_authority_dir/runtime"
            export FAKE_BROKER_MODE=stubborn
            export FAKE_JAIL_MODE=responsive
            export FAKE_JAIL_WAIT=1
            ${pkgs.util-linux}/bin/setsid \
              ${fakeUnrelatedWatcher}/bin/fake-unrelated-watcher "$stale_authority_dir" &
            stale_unrelated_pid=$!
            while [ ! -e "$stale_authority_dir/unrelated-pid" ]; do sleep 0.01; done
            stale_unrelated_pid="$(cat "$stale_authority_dir/unrelated-pid")"
            stale_unrelated_identity="$(process_identity "$stale_unrelated_pid")"
            set +e
            timeout -k 1 5 ${staleGroupAuthorityWrapper}/bin/jailed-github-broker-stale-group-authority-test \
              >"$stale_authority_dir/stdout" 2>"$stale_authority_dir/stderr"
            stale_authority_status=$?
            set -e
            test "$stale_authority_status" -ne 0
            test "$stale_authority_status" -ne 124
            test ! -e "$stale_authority_dir/unsafe-negative-pgid-signal"
            process_matches_identity "$stale_unrelated_pid" "$stale_unrelated_identity"
            test ! -e "$stale_authority_dir/unrelated-signal"
            stale_broker_pid="$(sed -n 's/^[0-9][0-9]* //p' "$stale_authority_dir/broker-pids")"
            stale_broker_identity="$(cat "$stale_authority_dir/broker-identity")"
            stale_child_pid="$(cat "$stale_authority_dir/broker-child-pid")"
            stale_child_identity="$(cat "$stale_authority_dir/broker-child-identity")"
            if process_matches_identity "$stale_broker_pid" "$stale_broker_identity"; then
              echo "stale broker identity remained live" >&2
              exit 1
            fi
            if process_matches_identity "$stale_child_pid" "$stale_child_identity"; then
              echo "stale child identity remained live" >&2
              exit 1
            fi
            test -z "$(find "$stale_authority_dir/runtime" -mindepth 1 -print -quit)"
            terminate_recorded_process "$stale_unrelated_pid" "$stale_unrelated_identity"

            # Kept in a focused shell fixture because this identity-rich fault
            # case is independent from the declarative wiring assertions.
            source ${outerDeathCase}

            stop_loss_dir="$TMPDIR/stop-notification-anchor-loss"
            mkdir -p "$stop_loss_dir/runtime"
            export TEST_DIR="$stop_loss_dir"
            export XDG_RUNTIME_DIR="$stop_loss_dir/runtime"
            export FAKE_BROKER_MODE=normal
            export FAKE_JAIL_MODE=responsive
            export FAKE_JAIL_WAIT=0
            export FAKE_JAIL_STATUS=37
            set +e
            timeout -k 1 5 ${stopNotificationLossWrapper}/bin/jailed-github-broker-stop-notification-loss-test \
              >"$stop_loss_dir/stdout" 2>"$stop_loss_dir/stderr"
            stop_loss_status=$?
            set -e
            stop_loss_residue=0
            if [ -n "$(find "$stop_loss_dir/runtime" -mindepth 1 -print -quit)" ]; then
              stop_loss_residue=1
            fi
            rm -rf "$stop_loss_dir/runtime"/*
            test "$stop_loss_status" -eq 37
            test "$stop_loss_residue" -eq 0
            test -e "$stop_loss_dir/anchor-stop-injected"

            stdin_dir="$TMPDIR/jail-stdin"
            mkdir -p "$stdin_dir/runtime"
            export TEST_DIR="$stdin_dir"
            export XDG_RUNTIME_DIR="$stdin_dir/runtime"
            export FAKE_BROKER_MODE=normal
            export FAKE_JAIL_MODE=stdin-probe
            export FAKE_JAIL_WAIT=0
            printf 'stdin-preserved\n' > "$stdin_dir/input"
            set +e
            timeout -k 1 5 ${lifecycleWrapper}/bin/jailed-github-broker-lifecycle-test \
              <"$stdin_dir/input" >"$stdin_dir/stdout" 2>"$stdin_dir/stderr"
            stdin_status=$?
            set -e
            if [ "$stdin_status" -ne 0 ]; then
              echo "expected preserved jail stdin, got status $stdin_status" >&2
              exit 1
            fi
            grep -Fx stdin-preserved "$stdin_dir/jail-stdin" >/dev/null
            test ! -e "$stdin_dir/jail-stdin-eof"
            test -z "$(find "$stdin_dir/runtime" -mindepth 1 -print -quit)"

            immediate_dir="$TMPDIR/immediate-jail-exit"
            mkdir -p "$immediate_dir/runtime"
            export TEST_DIR="$immediate_dir"
            export XDG_RUNTIME_DIR="$immediate_dir/runtime"
            export FAKE_BROKER_MODE=normal
            export FAKE_JAIL_MODE=immediate-exit
            export FAKE_JAIL_STATUS=73
            set +e
            timeout -k 1 5 ${immediateExitWrapper}/bin/jailed-github-broker-immediate-exit-test \
              >"$immediate_dir/stdout" 2>"$immediate_dir/stderr"
            immediate_status=$?
            set -e
            test "$immediate_status" -eq 73
            test -z "$(find "$immediate_dir/runtime" -mindepth 1 -print -quit)"

            identity_timeout_dir="$TMPDIR/forced-jail-identity-timeout"
            mkdir -p "$identity_timeout_dir/runtime"
            export TEST_DIR="$identity_timeout_dir"
            export XDG_RUNTIME_DIR="$identity_timeout_dir/runtime"
            export FAKE_BROKER_MODE=normal
            export FAKE_JAIL_MODE=responsive
            export FAKE_JAIL_WAIT=1
            set +e
            timeout -k 1 5 ${forcedIdentityTimeoutWrapper}/bin/jailed-github-broker-forced-identity-timeout-test \
              >"$identity_timeout_dir/stdout" 2>"$identity_timeout_dir/stderr"
            identity_timeout_status=$?
            set -e
            test "$identity_timeout_status" -eq 1
            identity_timeout_pid="$(cat "$identity_timeout_dir/jail-pid")"
            identity_timeout_identity="$(cat "$identity_timeout_dir/jail-identity")"
            identity_timeout_leak=0
            if process_matches_identity "$identity_timeout_pid" "$identity_timeout_identity"; then
              identity_timeout_leak=1
            fi
            terminate_recorded_process "$identity_timeout_pid" "$identity_timeout_identity"
            test "$identity_timeout_leak" -eq 0
            grep -Fx TERM "$identity_timeout_dir/jail-signal" >/dev/null
            test -z "$(find "$identity_timeout_dir/runtime" -mindepth 1 -print -quit)"

            run_signal_case() {
              signal_case_dir="$TMPDIR/$1"
              mkdir -p "$signal_case_dir/runtime"
              export TEST_DIR="$signal_case_dir"
              export XDG_RUNTIME_DIR="$signal_case_dir/runtime"
              export FAKE_BROKER_MODE="$2"
              export FAKE_JAIL_MODE="$3"
              export FAKE_JAIL_WAIT=1
              export FAKE_SIGNAL_STATUS="$4"
              ${lifecycleWrapper}/bin/jailed-github-broker-lifecycle-test \
                >"$signal_case_dir/stdout" 2>"$signal_case_dir/stderr" &
              wrapper_pid=$!
              wrapper_identity="$(process_identity "$wrapper_pid")"
              test -n "$wrapper_identity"
              if [ "$3" != signal-before-identity ]; then
                attempt=0
                while [ ! -e "$signal_case_dir/jail-started" ] && [ "$attempt" -lt 100 ]; do
                  process_matches_identity "$wrapper_pid" "$wrapper_identity"
                  sleep 0.02
                  attempt=$((attempt + 1))
                done
                test -e "$signal_case_dir/jail-started"
                process_matches_identity "$wrapper_pid" "$wrapper_identity"
                kill -TERM "$wrapper_pid"
              fi
              if ! bounded_wait_wrapper "$wrapper_pid" "$wrapper_identity"; then
                echo "lifecycle wrapper did not exit before deadline in $1" >&2
                exit 1
              fi
              test "$wrapper_wait_status" -eq "$5"
              jail_pid="$(cat "$signal_case_dir/jail-pid")"
              jail_identity="$(process_identity "$jail_pid")"
              if [ -n "$jail_identity" ]; then
                if process_matches_identity "$jail_pid" "$jail_identity"; then
                  echo "signalled jail identity remained live" >&2
                  exit 1
                fi
              fi
              grep -Fx TERM "$signal_case_dir/broker-signals" >/dev/null
              test -z "$(find "$signal_case_dir/runtime" -mindepth 1 -print -quit)"
            }
            run_signal_case signal normal responsive 42 42
            grep -Fx TERM "$TMPDIR/signal/jail-signal" >/dev/null
            run_signal_case stubborn-jail normal stubborn 42 137
            run_signal_case pre-identity-signal normal signal-before-identity 143 143
            run_signal_case signal-during-cleanup cleanup-signal responsive 42 42
            grep -Fx TERM "$TMPDIR/signal-during-cleanup/jail-signal" >/dev/null

            touch "$out"
          '';
    };
}
