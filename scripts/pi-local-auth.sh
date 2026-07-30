#!/usr/bin/env bash
set -eu

local_agent_dir=".pi/local-agent"
settings_file="$local_agent_dir/settings.json"
global_settings_file="$HOME/.pi/agent/settings.json"
envrc_file=".envrc"
settings_source_tmp=""
settings_tmp=""

cleanup_settings_tmp() {
  if [ -n "$settings_source_tmp" ]; then
    rm -f -- "$settings_source_tmp"
  fi
  if [ -n "$settings_tmp" ]; then
    rm -f -- "$settings_tmp"
  fi
}

if [ ! -r "$global_settings_file" ]; then
  printf 'pi-local-auth: global settings not found or unreadable: %s\n' \
    "$global_settings_file" >&2
  exit 1
fi

if [ -L ".pi" ] || [ -L "$local_agent_dir" ]; then
  printf 'pi-local-auth: local agent directory resolves outside the project: %s\n' \
    "$local_agent_dir" >&2
  exit 1
fi

mkdir -p "$local_agent_dir"
project_dir=$(pwd -P)
resolved_local_agent_dir=$(cd "$local_agent_dir" && pwd -P)
if [ "$resolved_local_agent_dir" != "$project_dir/$local_agent_dir" ]; then
  printf 'pi-local-auth: local agent directory resolves outside the project: %s\n' \
    "$local_agent_dir" >&2
  exit 1
fi

trap cleanup_settings_tmp EXIT HUP INT TERM
settings_source_tmp=$(mktemp "$local_agent_dir/.settings-source.tmp.XXXXXX")

if ! cp -- "$global_settings_file" "$settings_source_tmp"; then
  printf 'pi-local-auth: global settings not found or unreadable: %s\n' \
    "$global_settings_file" >&2
  exit 1
fi

if ! python3 -I - "$settings_source_tmp" <<'PY'
import json
import sys


def reject_constant(value):
    raise ValueError(f"non-standard JSON constant: {value}")


try:
    with open(sys.argv[1], encoding="utf-8") as settings_file:
        settings = json.load(settings_file, parse_constant=reject_constant)
except (OSError, UnicodeError, ValueError):
    raise SystemExit(1)

if not isinstance(settings, dict):
    raise SystemExit(1)
PY
then
  printf 'pi-local-auth: invalid global settings: %s\n' "$global_settings_file" >&2
  exit 1
fi

settings_tmp=$(mktemp "$local_agent_dir/.settings.json.tmp.XXXXXX")

if ! jq --slurp '
  if length != 1 or (.[0] | type) != "object" then
    error("settings must contain exactly one JSON object")
  else
    .[0] + {
      sessionDir: "~/.pi/agent/sessions",
      extensions: ["~/.pi/agent/extensions"],
      skills: ["~/.pi/agent/skills"],
      prompts: ["~/.pi/agent/prompts"],
      themes: ["~/.pi/agent/themes"]
    }
  end
' "$settings_source_tmp" > "$settings_tmp"; then
  printf 'pi-local-auth: invalid global settings: %s\n' "$global_settings_file" >&2
  exit 1
fi

if ! mv -fT -- "$settings_tmp" "$settings_file"; then
  printf 'pi-local-auth: could not replace local settings: %s\n' "$settings_file" >&2
  exit 1
fi
settings_tmp=""
rm -f -- "$settings_source_tmp"
settings_source_tmp=""
trap - EXIT HUP INT TERM

touch "$envrc_file"

if ! grep -q '^[[:space:]]*\(export[[:space:]]\+\)\?PI_CODING_AGENT_DIR=' "$envrc_file"; then
  # shellcheck disable=SC2016
  printf '%s\n' 'export PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"' >> "$envrc_file"
fi

if ! grep -q '^[[:space:]]*\(export[[:space:]]\+\)\?PI_CODING_AGENT_SESSION_DIR=' "$envrc_file"; then
  # shellcheck disable=SC2016
  printf '%s\n' 'export PI_CODING_AGENT_SESSION_DIR="$HOME/.pi/agent/sessions"' >> "$envrc_file"
fi
