run_outer_death() {
  outer_death_dir="$TMPDIR/outer-death"
  mkdir -p "$outer_death_dir/runtime"
  export TEST_DIR="$outer_death_dir"
  export XDG_RUNTIME_DIR="$outer_death_dir/runtime"
  previous_state_home="$XDG_STATE_HOME"
  export XDG_STATE_HOME="$outer_death_dir/state"
  export FAKE_BROKER_MODE=stubborn
  export FAKE_JAIL_MODE=outer-death
  export FAKE_JAIL_WAIT=1

  @SETSID@ @UNRELATED_WATCHER@ "$outer_death_dir" &
  unrelated_pid=$!
  outer_death_attempt=0
  while [ ! -e "$outer_death_dir/unrelated-pid" ] \
    && [ "$outer_death_attempt" -lt 100 ]; do
    sleep 0.02
    outer_death_attempt=$((outer_death_attempt + 1))
  done
  test -e "$outer_death_dir/unrelated-pid"
  unrelated_pid="$(cat "$outer_death_dir/unrelated-pid")"
  unrelated_identity="$(process_identity "$unrelated_pid")"
  process_matches_identity "$unrelated_pid" "$unrelated_identity"

  @OUTER_DEATH_WRAPPER@ >"$outer_death_dir/stdout" 2>"$outer_death_dir/stderr" &
  outer_pid=$!
  outer_identity="$(process_identity "$outer_pid")"
  test -n "$outer_identity"
  printf '%s %s\n' "$outer_pid" "$outer_identity" > "$outer_death_dir/outer-start-record"

  outer_death_attempt=0
  while { [ ! -e "$outer_death_dir/anchor-start-record" ] \
    || [ ! -e "$outer_death_dir/broker-pids" ] \
    || [ ! -e "$outer_death_dir/broker-parent-pid" ] \
    || [ ! -e "$outer_death_dir/broker-child-pid" ] \
    || [ ! -e "$outer_death_dir/stubborn-pid" ] \
    || [ ! -e "$outer_death_dir/jail-pid" ] \
    || [ ! -e "$outer_death_dir/jail-started" ]; } \
    && [ "$outer_death_attempt" -lt 100 ]; do
    process_matches_identity "$outer_pid" "$outer_identity"
    sleep 0.02
    outer_death_attempt=$((outer_death_attempt + 1))
  done
  test -e "$outer_death_dir/jail-started"

  read -r anchor_pid anchor_identity < "$outer_death_dir/anchor-start-record"
  read -r _recorded_anchor_pid broker_pid < "$outer_death_dir/broker-pids"
  manager_pid="$(cat "$outer_death_dir/broker-parent-pid")"
  manager_identity="$(cat "$outer_death_dir/broker-parent-identity")"
  broker_identity="$(cat "$outer_death_dir/broker-identity")"
  descendant_pid="$(cat "$outer_death_dir/stubborn-pid")"
  descendant_identity="$(process_identity "$descendant_pid")"
  jail_pid="$(cat "$outer_death_dir/jail-pid")"
  jail_identity="$(cat "$outer_death_dir/jail-identity")"
  printf '%s %s\n' "$manager_pid" "$manager_identity" > "$outer_death_dir/manager-start-record"
  printf '%s %s\n' "$broker_pid" "$broker_identity" > "$outer_death_dir/broker-start-record"
  printf '%s %s\n' "$descendant_pid" "$descendant_identity" \
    > "$outer_death_dir/descendant-start-record"
  printf '%s %s\n' "$jail_pid" "$jail_identity" > "$outer_death_dir/jail-start-record"

  for owned_record in \
    "$outer_death_dir/outer-start-record" \
    "$outer_death_dir/anchor-start-record" \
    "$outer_death_dir/manager-start-record" \
    "$outer_death_dir/broker-start-record" \
    "$outer_death_dir/descendant-start-record" \
    "$outer_death_dir/jail-start-record"; do
    read -r owned_pid owned_identity < "$owned_record"
    test -n "$owned_identity"
    process_matches_identity "$owned_pid" "$owned_identity"
  done
  runtime_dir="$(find "$outer_death_dir/runtime" -mindepth 1 -maxdepth 1 \
    -type d -name 'jailed-github-broker.*' -print -quit)"
  test -n "$runtime_dir"
  test -S "$runtime_dir/broker.sock"
  printf '%s\n' "$runtime_dir" > "$outer_death_dir/runtime-path"

  process_matches_identity "$outer_pid" "$outer_identity"
  kill -KILL "$outer_pid"
  set +e
  wait "$outer_pid" 2>/dev/null
  outer_status=$?
  set -e
  test "$outer_status" -eq 137

  outer_death_attempt=0
  while [ "$outer_death_attempt" -lt 150 ]; do
    outer_death_pending=0
    for owned_record in \
      "$outer_death_dir/anchor-start-record" \
      "$outer_death_dir/manager-start-record" \
      "$outer_death_dir/broker-start-record" \
      "$outer_death_dir/descendant-start-record" \
      "$outer_death_dir/jail-start-record"; do
      read -r owned_pid owned_identity < "$owned_record"
      if process_matches_identity "$owned_pid" "$owned_identity"; then
        outer_death_pending=1
      fi
    done
    if [ -e "$runtime_dir" ] || [ -e "$runtime_dir/broker.sock" ]; then
      outer_death_pending=1
    fi
    [ "$outer_death_pending" -eq 1 ] || break
    sleep 0.02
    outer_death_attempt=$((outer_death_attempt + 1))
  done

  outer_death_leak=0
  for owned_record in \
    "$outer_death_dir/anchor-start-record" \
    "$outer_death_dir/manager-start-record" \
    "$outer_death_dir/broker-start-record" \
    "$outer_death_dir/descendant-start-record" \
    "$outer_death_dir/jail-start-record"; do
    read -r owned_pid owned_identity < "$owned_record"
    if process_matches_identity "$owned_pid" "$owned_identity"; then
      outer_death_leak=1
      terminate_recorded_process "$owned_pid" "$owned_identity"
    fi
  done
  if [ -e "$runtime_dir" ] || [ -e "$runtime_dir/broker.sock" ]; then
    outer_death_leak=1
    rm -rf -- "$runtime_dir"
  fi

  process_matches_identity "$unrelated_pid" "$unrelated_identity"
  test ! -e "$outer_death_dir/unrelated-signal"
  audit_log="$XDG_STATE_HOME/pi/jailed-github-broker/audit.jsonl"
  test -f "$audit_log"
  grep -F '"operation":"repository.get"' "$audit_log" >/dev/null
  grep -F '"operation":"git.receivePack"' "$audit_log" >/dev/null
  test "$(stat -c %a "$audit_log")" = 600
  test -z "$(find "$outer_death_dir/runtime" -mindepth 1 -print -quit)"
  terminate_recorded_process "$unrelated_pid" "$unrelated_identity"
  export XDG_STATE_HOME="$previous_state_home"
  if [ "$outer_death_leak" -ne 0 ]; then
    echo "outer launcher death left owned processes or runtime state" >&2
    return 1
  fi
}

run_outer_death
