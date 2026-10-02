#!/usr/bin/env bash
set -eu

local_agent_dir=".pi/local-agent"
auth_file="$local_agent_dir/auth.json"
envrc_file=".envrc"
# shellcheck disable=SC2016
auth_line='export PI_CODING_AGENT_AUTH_FILE="$PWD/.pi/local-agent/auth.json"'
# Lines written by earlier versions, which moved the whole agent directory.
# shellcheck disable=SC2016
legacy_dir_line='export PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"'
# shellcheck disable=SC2016
legacy_session_line='export PI_CODING_AGENT_SESSION_DIR="$HOME/.pi/agent/sessions"'
envrc_tmp=""

cleanup_envrc_tmp() {
  if [ -n "$envrc_tmp" ]; then
    rm -f -- "$envrc_tmp"
  fi
}

reject_unreadable_envrc() {
  printf 'pi-local-auth: could not read %s\n' "$envrc_file" >&2
  exit 1
}

# grep exits 1 when nothing matches; a higher status means it could not read.
envrc_contains() {
  local status=0
  grep -q "$@" -- "$envrc_file" || status=$?
  if [ "$status" -gt 1 ]; then
    reject_unreadable_envrc
  fi
  [ "$status" -eq 0 ]
}

reject_outside_project() {
  printf 'pi-local-auth: local agent directory resolves outside the project: %s\n' \
    "$local_agent_dir" >&2
  exit 1
}

if [ -L ".pi" ] || [ -L "$local_agent_dir" ]; then
  reject_outside_project
fi

if [ ! -d "$local_agent_dir" ]; then
  mkdir -p .pi
  mkdir -m 700 "$local_agent_dir"
fi
project_dir=$(pwd -P)
resolved_local_agent_dir=$(cd "$local_agent_dir" && pwd -P)
if [ "$resolved_local_agent_dir" != "$project_dir/$local_agent_dir" ]; then
  reject_outside_project
fi

# Pi reads and writes through a symlink, which could expose another project's
# or the global credentials. Point PI_CODING_AGENT_AUTH_FILE at a shared file
# instead.
if [ -L "$auth_file" ]; then
  printf 'pi-local-auth: auth file is a symlink: %s\n' "$auth_file" >&2
  exit 1
fi

if [ ! -e "$auth_file" ]; then
  (umask 077 && printf '%s' '{}' > "$auth_file")
fi

if [ ! -e "$envrc_file" ]; then
  : > "$envrc_file"
fi

has_legacy_lines=false
if envrc_contains -Fx -e "$legacy_dir_line" -e "$legacy_session_line"; then
  has_legacy_lines=true
fi
has_auth_line=false
if envrc_contains -e '^[[:space:]]*\(export[[:space:]]\+\)\?PI_CODING_AGENT_AUTH_FILE='; then
  has_auth_line=true
fi

if [ "$has_legacy_lines" = true ] || [ "$has_auth_line" = false ]; then
  envrc_target=$(realpath -- "$envrc_file")
  if [ ! -w "$envrc_target" ]; then
    printf 'pi-local-auth: could not write %s\n' "$envrc_file" >&2
    exit 1
  fi
  # Build the new file beside the resolved target and rename it once, so a
  # failure leaves either the old or the new contents.
  trap cleanup_envrc_tmp EXIT HUP INT TERM
  envrc_tmp=$(mktemp "$(dirname -- "$envrc_target")/.envrc.tmp.XXXXXX")
  filter_status=0
  grep -vFx -e "$legacy_dir_line" -e "$legacy_session_line" -- "$envrc_target" \
    > "$envrc_tmp" || filter_status=$?
  if [ "$filter_status" -gt 1 ]; then
    reject_unreadable_envrc
  fi
  if [ "$has_auth_line" = false ]; then
    if [ -n "$(tail -c 1 -- "$envrc_tmp")" ]; then
      printf '\n' >> "$envrc_tmp"
    fi
    printf '%s\n' "$auth_line" >> "$envrc_tmp"
  fi
  chmod --reference="$envrc_target" -- "$envrc_tmp"
  mv -f -- "$envrc_tmp" "$envrc_target"
  envrc_tmp=""
fi

if envrc_contains -e '^[[:space:]]*\(export[[:space:]]\+\)\?PI_CODING_AGENT_DIR='; then
  printf '%s\n' \
    'pi-local-auth: warning: .envrc still sets PI_CODING_AGENT_DIR, so Pi will not use global settings' >&2
fi
