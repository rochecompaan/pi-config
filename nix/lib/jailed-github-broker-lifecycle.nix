{ lib, pkgs }:
let
  hostSocketEnvironment = "JAILED_GITHUB_BROKER_HOST_SOCKET";

  lifecycleRuntimeInputs = with pkgs; [
    coreutils
    gawk
    procps
    util-linux
  ];

  brokerProcessStartRecord = pkgs.writeShellScript "jailed-github-broker-process-start-record" ''
    ${pkgs.gawk}/bin/awk '{ sub(/^.*\) /, ""); print $1, $20 }' "/proc/$1/stat" 2>/dev/null || true
  '';

  brokerParentHandshake = pkgs.writeShellScript "jailed-github-broker-parent-handshake" ''
    expected_parent_pid="$1"
    expected_parent_identity="$2"
    shift 2
    parent_record="$(${brokerProcessStartRecord} "$PPID")"
    read -r parent_state actual_parent_identity <<< "$parent_record"
    if [ "$PPID" != "$expected_parent_pid" ] \
      || [ "$parent_state" = Z ] \
      || [ "$actual_parent_identity" != "$expected_parent_identity" ]; then
      exit 1
    fi
    exec "$@"
  '';

  brokerAnchorSupervisor = pkgs.runCommandCC "jailed-github-broker-anchor-supervisor" { } ''
    mkdir -p "$out/bin"
    "$CC" -std=c11 -O2 -Wall -Wextra -Werror \
      ${./jailed-github-broker-anchor.c} \
      -o "$out/bin/jailed-github-broker-anchor-supervisor"
  '';

  mkLifecycleScript =
    {
      brokerPackage,
      configFile,
      jailExecutable,
      readinessAttempts ? 200,
      cleanupAttempts ? 20,
      anchorSupervisor ? brokerAnchorSupervisor,
    }:
    assert pkgs.stdenv.hostPlatform.system == "x86_64-linux";
    ''
      anchor_pid=
      anchor_identity=
      anchor_pgid=
      anchor_session=
      anchor_was_started=0
      manager_pid=
      manager_identity=
      broker_pid=
      broker_identity=
      broker_pgid=
      jail_pid=
      jail_identity=
      broker_runtime_dir=
      broker_cleanup_state=not-started
      signal_handling=0
      pending_signal=
      pending_signal_status=

      process_record() {
        record_pid="$1"
        ${pkgs.gawk}/bin/awk '{ sub(/^.*\) /, ""); print $1, $3, $4, $20 }' \
          "/proc/$record_pid/stat" 2>/dev/null || true
      }

      process_matches() {
        match_pid="$1"
        match_identity="$2"
        match_pgid="$3"
        match_session="$4"
        match_record="$(process_record "$match_pid")"
        [ -n "$match_record" ] || return 1
        read -r match_state actual_pgid actual_session actual_identity <<< "$match_record"
        [ "$match_state" != Z ] \
          && [ "$actual_pgid" = "$match_pgid" ] \
          && [ "$actual_session" = "$match_session" ] \
          && [ "$actual_identity" = "$match_identity" ]
      }

      process_matches_start_identity() {
        start_match_record="$(process_record "$1")"
        [ -n "$start_match_record" ] || return 1
        read -r start_match_state _start_match_pgid _start_match_session actual_identity \
          <<< "$start_match_record"
        [ "$start_match_state" != Z ] && [ "$actual_identity" = "$2" ]
      }

      anchor_matches_identity() {
        [ -n "$anchor_pid" ] \
          && process_matches "$anchor_pid" "$anchor_identity" "$anchor_pgid" "$anchor_session"
      }

      broker_matches_identity() {
        [ -n "$broker_pid" ] \
          && [ -n "$broker_identity" ] \
          && [ -n "$broker_pgid" ] \
          && [ -n "$anchor_session" ] \
          && process_matches "$broker_pid" "$broker_identity" "$broker_pgid" "$anchor_session"
      }

      broker_process_alive() {
        [ ! -e "$broker_status_file" ] && broker_matches_identity
      }

      jail_process_alive() {
        [ -n "$jail_pid" ] \
          && [ -n "$jail_identity" ] \
          && process_matches_start_identity "$jail_pid" "$jail_identity"
      }

      notify_anchor_stop() {
        [ -n "$broker_runtime_dir" ] || return 1
        if ! {
          printf 'stop\n' > "$anchor_stop_file.tmp" \
            && ${pkgs.coreutils}/bin/mv -f -- "$anchor_stop_file.tmp" "$anchor_stop_file"
        } 2>/dev/null; then
          return 1
        fi
      }

      stop_jail() {
        stop_signal="$1"
        if jail_process_alive; then
          ${pkgs.coreutils}/bin/kill -s "$stop_signal" "$jail_pid" 2>/dev/null || true
        fi
      }

      anchor_job_is_running() {
        anchor_job_pids="$(jobs -pr)"
        while IFS= read -r anchor_job_pid; do
          [ "$anchor_job_pid" = "$anchor_pid" ] && return 0
        done <<< "$anchor_job_pids"
        return 1
      }

      cleanup_broker() {
        case "$broker_cleanup_state" in
          complete|in-progress) return ;;
        esac
        broker_cleanup_state=in-progress
        # Cleanup owns finalization. Additional handled signals are ignored,
        # and every fallible notification/identity operation is bounded.
        trap ':' HUP INT TERM
        supervisor_cleanup_attempts=$(( ${toString cleanupAttempts} * 3 + 20 ))
        anchor_cleanup_complete=0

        # A regular atomic marker requests cleanup without granting the shell
        # process-group authority. The private C supervisor owns bounded
        # TERM/KILL delivery and removes the runtime directory when finished.
        if [ "$anchor_was_started" -eq 1 ]; then
          notify_anchor_stop || true
        fi

        if [ -n "$anchor_pid" ] && [ -n "$anchor_identity" ]; then
          cleanup_attempt=0
          while [ "$cleanup_attempt" -lt "$supervisor_cleanup_attempts" ] \
            && process_matches_start_identity "$anchor_pid" "$anchor_identity"; do
            ${pkgs.coreutils}/bin/sleep 0.05
            cleanup_attempt=$((cleanup_attempt + 1))
          done
          if process_matches_start_identity "$anchor_pid" "$anchor_identity"; then
            ${pkgs.coreutils}/bin/kill -TERM "$anchor_pid" 2>/dev/null || true
            cleanup_attempt=0
            while [ "$cleanup_attempt" -lt "$supervisor_cleanup_attempts" ] \
              && process_matches_start_identity "$anchor_pid" "$anchor_identity"; do
              ${pkgs.coreutils}/bin/sleep 0.05
              cleanup_attempt=$((cleanup_attempt + 1))
            done
          fi
          if ! process_matches_start_identity "$anchor_pid" "$anchor_identity"; then
            wait "$anchor_pid" 2>/dev/null || true
            anchor_pid=
            anchor_cleanup_complete=1
          fi
        elif [ -n "$anchor_pid" ]; then
          cleanup_attempt=0
          while [ "$cleanup_attempt" -lt "$supervisor_cleanup_attempts" ] \
            && anchor_job_is_running; do
            ${pkgs.coreutils}/bin/sleep 0.05
            cleanup_attempt=$((cleanup_attempt + 1))
          done
          if ! anchor_job_is_running; then
            wait "$anchor_pid" 2>/dev/null || true
            anchor_pid=
            anchor_cleanup_complete=1
          fi
        fi

        if [ -n "$broker_runtime_dir" ]; then
          cleanup_attempt=0
          while [ "$cleanup_attempt" -lt "$supervisor_cleanup_attempts" ] \
            && [ -e "$broker_runtime_dir" ]; do
            ${pkgs.coreutils}/bin/sleep 0.05
            cleanup_attempt=$((cleanup_attempt + 1))
          done
          if [ ! -e "$broker_runtime_dir" ]; then
            broker_runtime_dir=
          elif [ "$anchor_was_started" -eq 0 ] || [ "$anchor_cleanup_complete" -eq 1 ]; then
            # Before A starts, no C process can own this directory. Once A is
            # identity-proven absent/reaped or its exact job is reaped, S has
            # had its complete bounded cleanup budget and only residue remains.
            ${pkgs.coreutils}/bin/rm -rf -- "$broker_runtime_dir" 2>/dev/null || true
            broker_runtime_dir=
          fi
        fi
        broker_cleanup_state=complete
      }

      reap_direct_jail() {
        [ -n "$jail_pid" ] || return 1
        set +e
        wait "$jail_pid"
        reaped_jail_status=$?
        set -e
        jail_pid=
        jail_identity=
      }

      reap_jail_if_gone() {
        [ -n "$jail_pid" ] && ! jail_process_alive || return 1
        reap_direct_jail
      }

      stop_and_reap_jail() {
        stop_signal="$1"
        stop_jail "$stop_signal"
        jail_cleanup_attempt=0
        while [ "$jail_cleanup_attempt" -lt ${toString cleanupAttempts} ] && jail_process_alive; do
          ${pkgs.coreutils}/bin/sleep 0.05
          jail_cleanup_attempt=$((jail_cleanup_attempt + 1))
        done
        if jail_process_alive; then
          stop_jail KILL
          jail_cleanup_attempt=0
          while [ "$jail_cleanup_attempt" -lt ${toString cleanupAttempts} ] && jail_process_alive; do
            ${pkgs.coreutils}/bin/sleep 0.05
            jail_cleanup_attempt=$((jail_cleanup_attempt + 1))
          done
        fi
        reap_jail_if_gone
      }

      # Invoked through signal traps. Signals before the bounded startup
      # handshake are recorded and handled only after a jail identity exists.
      # shellcheck disable=SC2329
      handle_signal() {
        forwarded_signal="$1"
        forwarded_status="$2"
        if [ "$broker_cleanup_state" != not-started ] || [ "$signal_handling" -eq 1 ]; then
          return
        fi
        if [ -z "$jail_identity" ]; then
          pending_signal="$forwarded_signal"
          pending_signal_status="$forwarded_status"
          return
        fi
        signal_handling=1
        trap ':' HUP INT TERM
        if stop_and_reap_jail "$forwarded_signal"; then
          signal_status="$reaped_jail_status"
        else
          signal_status="$forwarded_status"
        fi
        cleanup_broker
        trap - EXIT
        exit "$signal_status"
      }

      trap cleanup_broker EXIT
      trap 'handle_signal HUP 129' HUP
      trap 'handle_signal INT 130' INT
      trap 'handle_signal TERM 143' TERM

      broker_runtime_base=/tmp
      if [ -n "''${XDG_RUNTIME_DIR:-}" ] && [ -d "$XDG_RUNTIME_DIR" ] \
        && [ "$(${pkgs.coreutils}/bin/stat -c %u -- "$XDG_RUNTIME_DIR")" = "$(${pkgs.coreutils}/bin/id -u)" ]; then
        broker_runtime_base="$XDG_RUNTIME_DIR"
      fi

      umask 077
      broker_runtime_dir="$(${pkgs.coreutils}/bin/mktemp -d -p "$broker_runtime_base" jailed-github-broker.XXXXXXXXXX)" || {
        echo "jailed GitHub broker: private runtime directory creation failed" >&2
        exit 1
      }
      if [ "$(${pkgs.coreutils}/bin/stat -c %u -- "$broker_runtime_dir")" != "$(${pkgs.coreutils}/bin/id -u)" ] \
        || [ "$(${pkgs.coreutils}/bin/stat -c %a -- "$broker_runtime_dir")" != 700 ]; then
        echo "jailed GitHub broker: private runtime directory verification failed" >&2
        exit 1
      fi

      broker_socket="$broker_runtime_dir/broker.sock"
      broker_ready="$broker_runtime_dir/ready"
      broker_pid_file="$broker_runtime_dir/broker.pid"
      broker_status_file="$broker_runtime_dir/broker.status"
      anchor_stop_file="$broker_runtime_dir/anchor.stop"
      manager_identity_file="$broker_runtime_dir/manager.identity"

      # Source the focused setup so its append descriptor remains owned by this
      # shell and can be inherited only through the trusted broker chain.
      # shellcheck disable=SC1091
      if ! . ${./jailed-github-broker-audit-open.sh} 2>/dev/null; then
        echo "jailed GitHub broker: audit setup failed" >&2
        exit 1
      fi

      outer_pid="$$"
      outer_record="$(process_record "$outer_pid")"
      read -r outer_state _outer_pgid _outer_session outer_identity <<< "$outer_record"
      if [ -z "$outer_identity" ] || [ "$outer_state" = Z ]; then
        echo "jailed GitHub broker: outer launcher identity unavailable" >&2
        exit 1
      fi

      # The compiled anchor installs its parent-death handler before arming
      # PR_SET_PDEATHSIG, verifies the exact outer start identity, creates a
      # private session, and owns bounded group cleanup plus runtime removal.
      # shellcheck disable=SC2016
      ${anchorSupervisor}/bin/jailed-github-broker-anchor-supervisor \
        "$outer_pid" "$outer_identity" "$anchor_stop_file" "$broker_runtime_dir" \
        "$manager_identity_file" ${toString cleanupAttempts} ${pkgs.runtimeShell} -c '
        status_file="$1"
        pid_file="$2"
        stop_file="$3"
        shift 3
        child_pid=
        child_identity=
        # Private direct-parent S owns group delivery. Manager M launches the
        # broker with a kernel parent-death signal, and its handshake verifies
        # the exact start identity of M after setpriv establishes that contract.
        trap ':' HUP INT TERM
        parent_pid="$$"
        parent_record="$(${brokerProcessStartRecord} "$$")"
        read -r parent_state parent_identity <<< "$parent_record"
        if [ -z "$parent_identity" ] || [ "$parent_state" = Z ]; then
          exit 1
        fi
        ${pkgs.util-linux}/bin/setpriv --pdeathsig TERM ${brokerParentHandshake} \
          "$parent_pid" "$parent_identity" "$@" &
        child_pid=$!
        child_record="$(${brokerProcessStartRecord} "$child_pid")"
        read -r child_state child_identity <<< "$child_record"
        if [ -z "$child_identity" ] || [ "$child_state" = Z ]; then
          exit 1
        fi
        printf "%s\n" "$child_pid" > "$pid_file"
        child_record="$(${brokerProcessStartRecord} "$child_pid")"
        read -r child_state actual_child_identity <<< "$child_record"
        if [ "$actual_child_identity" = "$child_identity" ]; then
          wait "$child_pid"
          child_status=$?
        else
          child_status=1
        fi
        # Definitive identity-verified reap (or detected identity loss)
        # invalidates the numeric PID before any later stop-file decision.
        child_pid=
        child_identity=
        printf "%s\n" "$child_status" > "$status_file.tmp"
        ${pkgs.coreutils}/bin/mv "$status_file.tmp" "$status_file"
        # Polling a regular marker cannot block on peer loss or receive
        # SIGPIPE. Outer cleanup writes it atomically and remains responsible
        # for bounded termination if this anchor disappears first.
        while [ ! -e "$stop_file" ]; do
          ${pkgs.coreutils}/bin/sleep 0.05
        done
      ' anchor "$broker_status_file" "$broker_pid_file" "$anchor_stop_file" \
        ${brokerPackage}/bin/jailed-github-broker serve \
        --config ${lib.escapeShellArg configFile} \
        --socket "$broker_socket" \
        --ready-file "$broker_ready" \
        --audit-fd 3 \
        >"$broker_runtime_dir/stdout" 2>"$broker_runtime_dir/stderr" &
      anchor_pid=$!
      anchor_was_started=1

      identity_attempt=0
      while true; do
        anchor_record="$(process_record "$anchor_pid")"
        if [ -n "$anchor_record" ]; then
          read -r anchor_state actual_pgid actual_session actual_identity <<< "$anchor_record"
          anchor_identity="$actual_identity"
          if [ "$anchor_state" != Z ] \
            && [ "$actual_pgid" = "$anchor_pid" ] \
            && [ "$actual_session" = "$anchor_pid" ]; then
            anchor_pgid="$actual_pgid"
            anchor_session="$actual_session"
            anchor_identity="$actual_identity"
            break
          fi
        fi
        if [ "$identity_attempt" -ge ${toString readinessAttempts} ]; then
          echo "jailed GitHub broker: supervisor identity unavailable" >&2
          exit 1
        fi
        identity_attempt=$((identity_attempt + 1))
        ${pkgs.coreutils}/bin/sleep 0.05
      done

      identity_attempt=0
      while [ ! -e "$manager_identity_file" ] || [ ! -e "$broker_pid_file" ]; do
        if ! anchor_matches_identity; then
          echo "jailed GitHub broker: supervisor exited before broker start" >&2
          exit 1
        fi
        if [ "$identity_attempt" -ge ${toString readinessAttempts} ]; then
          echo "jailed GitHub broker: broker identity unavailable" >&2
          exit 1
        fi
        identity_attempt=$((identity_attempt + 1))
        ${pkgs.coreutils}/bin/sleep 0.05
      done
      read -r manager_pid manager_identity < "$manager_identity_file"
      case "$manager_pid:$manager_identity" in
        *[!0-9:]*|:|*:)
          echo "jailed GitHub broker: manager identity invalid" >&2
          exit 1
          ;;
      esac
      if ! process_matches "$manager_pid" "$manager_identity" "$manager_pid" "$anchor_session"; then
        echo "jailed GitHub broker: manager ownership verification failed" >&2
        exit 1
      fi
      broker_pid="$(${pkgs.coreutils}/bin/cat "$broker_pid_file")"
      broker_record="$(process_record "$broker_pid")"
      if [ -z "$broker_record" ]; then
        echo "jailed GitHub broker: broker exited before identity capture" >&2
        exit 1
      fi
      read -r broker_state actual_pgid actual_session broker_identity <<< "$broker_record"
      if [ "$broker_state" = Z ] \
        || [ -z "$actual_pgid" ] \
        || [ "$actual_pgid" != "$manager_pid" ] \
        || [ "$actual_session" != "$anchor_session" ]; then
        echo "jailed GitHub broker: broker process ownership verification failed" >&2
        exit 1
      fi
      broker_pgid="$actual_pgid"

      readiness_attempt=0
      while [ ! -e "$broker_ready" ]; do
        if ! anchor_matches_identity; then
          echo "jailed GitHub broker: supervisor exited before readiness" >&2
          exit 1
        fi
        if ! broker_process_alive; then
          echo "jailed GitHub broker: broker exited before readiness" >&2
          exit 1
        fi
        if [ "$readiness_attempt" -ge ${toString readinessAttempts} ]; then
          echo "jailed GitHub broker: readiness timed out" >&2
          exit 1
        fi
        readiness_attempt=$((readiness_attempt + 1))
        ${pkgs.coreutils}/bin/sleep 0.05
      done

      if ! anchor_matches_identity; then
        echo "jailed GitHub broker: supervisor exited after readiness" >&2
        exit 1
      fi
      if ! broker_process_alive; then
        echo "jailed GitHub broker: broker exited after readiness" >&2
        exit 1
      fi
      if [ ! -S "$broker_socket" ]; then
        echo "jailed GitHub broker: socket creation failed" >&2
        exit 1
      fi
      if [ "$(${pkgs.coreutils}/bin/stat -c %u -- "$broker_socket")" != "$(${pkgs.coreutils}/bin/id -u)" ] \
        || [ "$(${pkgs.coreutils}/bin/stat -c %a -- "$broker_socket")" != 600 ]; then
        echo "jailed GitHub broker: socket permission verification failed" >&2
        exit 1
      fi

      # The broker retains its inherited append descriptor through the
      # anchor/manager chain. Closing this outer copy prevents jail inheritance.
      exec 3>&-
      export ${hostSocketEnvironment}="$broker_socket"
      ${pkgs.coreutils}/bin/env --default-signal=HUP,INT,TERM ${jailExecutable} "$@" 3>&- &
      jail_pid=$!
      # A signal can interrupt this loop, but its trap only records the signal
      # until this identity handshake has either completed or timed out.
      identity_attempt=0
      startup_jail_status=
      while [ -z "$jail_identity" ] && [ "$identity_attempt" -lt ${toString readinessAttempts} ]; do
        jail_record="$(process_record "$jail_pid")"
        if [ -n "$jail_record" ]; then
          read -r jail_state _jail_pgid _jail_session actual_jail_identity <<< "$jail_record"
          if [ "$jail_state" != Z ] && [ -n "$actual_jail_identity" ]; then
            jail_identity="$actual_jail_identity"
            break
          fi
        fi
        if [ -z "$jail_record" ] || [ "$jail_state" = Z ]; then
          reap_direct_jail
          startup_jail_status="$reaped_jail_status"
          break
        fi
        identity_attempt=$((identity_attempt + 1))
        ${pkgs.coreutils}/bin/sleep 0.05
      done
      if [ -n "$startup_jail_status" ]; then
        unset ${hostSocketEnvironment}
        cleanup_broker
        trap - EXIT
        exit "$startup_jail_status"
      fi
      if [ -z "$jail_identity" ]; then
        # Recheck once at the deadline. A gone/zombie direct child is reaped
        # with its exact status; a live child gains identity-bound TERM/KILL
        # authority before broker cleanup begins.
        jail_record="$(process_record "$jail_pid")"
        if [ -z "$jail_record" ]; then
          reap_direct_jail
          startup_jail_status="$reaped_jail_status"
        else
          read -r jail_state _jail_pgid _jail_session actual_jail_identity <<< "$jail_record"
          if [ "$jail_state" = Z ]; then
            reap_direct_jail
            startup_jail_status="$reaped_jail_status"
          else
            jail_identity="$actual_jail_identity"
          fi
        fi
        if [ -n "$startup_jail_status" ]; then
          unset ${hostSocketEnvironment}
          cleanup_broker
          trap - EXIT
          exit "$startup_jail_status"
        fi
        echo "jailed GitHub broker: jail identity unavailable" >&2
        timeout_signal="''${pending_signal:-TERM}"
        stop_and_reap_jail "$timeout_signal" || true
        unset ${hostSocketEnvironment}
        cleanup_broker
        trap - EXIT
        exit 1
      fi
      if [ -n "$pending_signal" ]; then
        handle_signal "$pending_signal" "$pending_signal_status"
      fi

      broker_failed=0
      broker_failure_message=
      while jail_process_alive; do
        if ! anchor_matches_identity; then
          broker_failed=1
          broker_failure_message="jailed GitHub broker: supervisor exited unexpectedly while jail was running"
          break
        fi
        if ! broker_process_alive; then
          broker_failed=1
          broker_failure_message="jailed GitHub broker: broker exited unexpectedly while jail was running"
          break
        fi
        ${pkgs.coreutils}/bin/sleep 0.05
      done

      if [ "$broker_failed" -eq 1 ]; then
        echo "$broker_failure_message" >&2
        stop_and_reap_jail TERM || true
        unset ${hostSocketEnvironment}
        cleanup_broker
        trap - EXIT
        exit 1
      fi

      reap_jail_if_gone || {
        echo "jailed GitHub broker: jail did not exit cleanly" >&2
        unset ${hostSocketEnvironment}
        cleanup_broker
        trap - EXIT
        exit 1
      }
      jail_status="$reaped_jail_status"
      unset ${hostSocketEnvironment}

      cleanup_broker
      trap - EXIT
      exit "$jail_status"
    '';
in
{
  inherit hostSocketEnvironment lifecycleRuntimeInputs mkLifecycleScript;
}
