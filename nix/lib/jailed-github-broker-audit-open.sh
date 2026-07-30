# Sourced by the trusted outer lifecycle so descriptor 3 remains open across
# the anchor/manager/broker chain. Failures return without printing host paths.
if [ -n "${XDG_STATE_HOME:-}" ]; then
  broker_audit_state_base="$XDG_STATE_HOME"
elif [ -n "${HOME:-}" ]; then
  broker_audit_state_base="$HOME/.local/state"
else
  return 1
fi
case "$broker_audit_state_base" in
  /*) ;;
  *) return 1 ;;
esac

broker_audit_directory="$broker_audit_state_base/pi/jailed-github-broker"
broker_audit_log="$broker_audit_directory/audit.jsonl"
broker_audit_uid="$(id -u 2>/dev/null)" || return 1
if ! mkdir -p -- "$broker_audit_directory" 2>/dev/null \
  || ! chmod 700 -- "$broker_audit_directory" 2>/dev/null \
  || [ "$(stat -c %u -- "$broker_audit_directory" 2>/dev/null)" != "$broker_audit_uid" ] \
  || [ "$(stat -c %a -- "$broker_audit_directory" 2>/dev/null)" != 700 ] \
  || [ -L "$broker_audit_log" ]; then
  return 1
fi
if ! { exec 3>>"$broker_audit_log"; } 2>/dev/null \
  || ! chmod 600 -- "$broker_audit_log" 2>/dev/null \
  || [ ! -f "$broker_audit_log" ] \
  || [ -L "$broker_audit_log" ] \
  || [ "$(stat -c %u -- "$broker_audit_log" 2>/dev/null)" != "$broker_audit_uid" ] \
  || [ "$(stat -c %a -- "$broker_audit_log" 2>/dev/null)" != 600 ]; then
  exec 3>&-
  return 1
fi
unset broker_audit_state_base broker_audit_directory broker_audit_log broker_audit_uid
