#!/usr/bin/env bash
set -eu

: "${PI_LOCAL_AUTH_BIN:?Set PI_LOCAL_AUTH_BIN to the pi-local-auth executable path}"

workdir=$(mktemp -d)
cd "$workdir"

"$PI_LOCAL_AUTH_BIN"

test -f .pi/local-agent/settings.json
jq -e '.sessionDir == "~/.pi/agent/sessions"' .pi/local-agent/settings.json
jq -e '.extensions == ["~/.pi/agent/extensions"]' .pi/local-agent/settings.json
jq -e '.skills == ["~/.pi/agent/skills"]' .pi/local-agent/settings.json
jq -e '.prompts == ["~/.pi/agent/prompts"]' .pi/local-agent/settings.json
jq -e '.themes == ["~/.pi/agent/themes"]' .pi/local-agent/settings.json

grep -Fx 'export PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"' .envrc
grep -Fx 'export PI_CODING_AGENT_SESSION_DIR="$HOME/.pi/agent/sessions"' .envrc

case_existing_dir=$(mktemp -d)
cd "$case_existing_dir"
printf '%s\n' 'export PI_CODING_AGENT_DIR="custom"' > .envrc
"$PI_LOCAL_AUTH_BIN"
grep -Fx 'export PI_CODING_AGENT_DIR="custom"' .envrc
grep -Fx 'export PI_CODING_AGENT_SESSION_DIR="$HOME/.pi/agent/sessions"' .envrc
[ "$(grep -c 'PI_CODING_AGENT_DIR=' .envrc)" -eq 1 ]

case_existing_session=$(mktemp -d)
cd "$case_existing_session"
printf '%s\n' 'PI_CODING_AGENT_SESSION_DIR=custom-session' > .envrc
"$PI_LOCAL_AUTH_BIN"
grep -Fx 'PI_CODING_AGENT_SESSION_DIR=custom-session' .envrc
grep -Fx 'export PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"' .envrc
[ "$(grep -c 'PI_CODING_AGENT_SESSION_DIR=' .envrc)" -eq 1 ]

case_idempotent=$(mktemp -d)
cd "$case_idempotent"
"$PI_LOCAL_AUTH_BIN"
"$PI_LOCAL_AUTH_BIN"
[ "$(grep -c 'PI_CODING_AGENT_DIR=' .envrc)" -eq 1 ]
[ "$(grep -c 'PI_CODING_AGENT_SESSION_DIR=' .envrc)" -eq 1 ]

case_existing_settings=$(mktemp -d)
cd "$case_existing_settings"
mkdir -p .pi/local-agent
printf '%s\n' '{"custom":true}' > .pi/local-agent/settings.json
"$PI_LOCAL_AUTH_BIN"
grep -Fx '{"custom":true}' .pi/local-agent/settings.json

if [ -n "${out:-}" ]; then
  touch "$out"
fi
