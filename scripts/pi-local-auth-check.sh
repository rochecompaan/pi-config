#!/usr/bin/env bash
set -eu

: "${PI_LOCAL_AUTH_BIN:?Set PI_LOCAL_AUTH_BIN to the pi-local-auth executable path}"

make_global_home() {
  local home_dir
  home_dir=$(mktemp -d)
  mkdir -p "$home_dir/.pi/agent"
  cat > "$home_dir/.pi/agent/settings.json" <<'EOF'
{
  "globalMarker": "from-home",
  "defaultModel": "global-model",
  "nested": { "preserved": { "value": 42 } },
  "packages": ["global-package"],
  "voice": { "enabled": true, "localModel": "parakeet-v3" },
  "sessionDir": "global-session",
  "extensions": ["global-extension"],
  "skills": ["global-skill"],
  "prompts": ["global-prompt"],
  "themes": ["global-theme"]
}
EOF
  printf '%s\n' "$home_dir"
}

assert_routing_overrides() {
  local file=$1
  jq -e '
    .sessionDir == "~/.pi/agent/sessions" and
    .extensions == ["~/.pi/agent/extensions"] and
    .skills == ["~/.pi/agent/skills"] and
    .prompts == ["~/.pi/agent/prompts"] and
    .themes == ["~/.pi/agent/themes"]
  ' "$file"
}

assert_no_temp_settings() {
  local temp
  for temp in .pi/local-agent/.settings.json.tmp.* .pi/local-agent/.settings-source.tmp.*; do
    [ ! -e "$temp" ] || return 1
  done
}

global_home=$(make_global_home)
export HOME="$global_home"

workdir=$(mktemp -d)
cd "$workdir"
"$PI_LOCAL_AUTH_BIN"

test -f .pi/local-agent/settings.json
jq -e '
  .globalMarker == "from-home" and
  .defaultModel == "global-model" and
  .nested.preserved.value == 42 and
  .packages == ["global-package"] and
  .voice.enabled == true and
  .voice.localModel == "parakeet-v3"
' .pi/local-agent/settings.json
assert_routing_overrides .pi/local-agent/settings.json
grep -Fx 'export PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"' .envrc
grep -Fx 'export PI_CODING_AGENT_SESSION_DIR="$HOME/.pi/agent/sessions"' .envrc

case_existing_settings=$(mktemp -d)
cd "$case_existing_settings"
mkdir -p .pi/local-agent
printf '%s\n' '{"custom":true}' > .pi/local-agent/settings.json
"$PI_LOCAL_AUTH_BIN"
jq -e '.globalMarker == "from-home" and (.custom | not)' .pi/local-agent/settings.json
assert_routing_overrides .pi/local-agent/settings.json

case_existing_symlink=$(mktemp -d)
cd "$case_existing_symlink"
mkdir -p .pi/local-agent
printf '%s\n' '{"stale":true}' > stale-settings.json
ln -s "$case_existing_symlink/stale-settings.json" .pi/local-agent/settings.json
"$PI_LOCAL_AUTH_BIN"
[ ! -L .pi/local-agent/settings.json ]
jq -e '.globalMarker == "from-home" and (.stale | not)' .pi/local-agent/settings.json
grep -Fx '{"stale":true}' stale-settings.json

updated_global=$(mktemp "$HOME/.pi/agent/.settings.json.tmp.XXXXXX")
jq '.globalMarker = "updated-home" | .nested.preserved.value = 84' \
  "$HOME/.pi/agent/settings.json" > "$updated_global"
mv "$updated_global" "$HOME/.pi/agent/settings.json"
cd "$workdir"
"$PI_LOCAL_AUTH_BIN"
jq -e '.globalMarker == "updated-home" and .nested.preserved.value == 84' \
  .pi/local-agent/settings.json

case_auth=$(mktemp -d)
cd "$case_auth"
mkdir -p .pi/local-agent
printf '%s\n' 'project-auth-contents' > .pi/local-agent/auth.json
cp .pi/local-agent/auth.json auth.expected
"$PI_LOCAL_AUTH_BIN"
cmp auth.expected .pi/local-agent/auth.json

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
cp .pi/local-agent/settings.json settings.expected
"$PI_LOCAL_AUTH_BIN"
cmp settings.expected .pi/local-agent/settings.json
[ "$(grep -c 'PI_CODING_AGENT_DIR=' .envrc)" -eq 1 ]
[ "$(grep -c 'PI_CODING_AGENT_SESSION_DIR=' .envrc)" -eq 1 ]

invalid_home=$(mktemp -d)
mkdir -p "$invalid_home/.pi/agent"
printf '%s\n' '{invalid' > "$invalid_home/.pi/agent/settings.json"
case_invalid=$(mktemp -d)
cd "$case_invalid"
mkdir -p .pi/local-agent
printf '%s\n' '{"sentinel":"settings"}' > .pi/local-agent/settings.json
printf '%s\n' 'KEEP=invalid' > .envrc
cp .pi/local-agent/settings.json settings.before
cp .envrc envrc.before
set +e
HOME="$invalid_home" "$PI_LOCAL_AUTH_BIN" > command.stdout 2> command.stderr
invalid_status=$?
set -e
[ "$invalid_status" -ne 0 ]
grep -F 'pi-local-auth: invalid global settings:' command.stderr
cmp settings.before .pi/local-agent/settings.json
cmp envrc.before .envrc
assert_no_temp_settings

missing_home=$(mktemp -d)
case_missing=$(mktemp -d)
cd "$case_missing"
mkdir -p .pi/local-agent
printf '%s\n' '{"sentinel":"settings"}' > .pi/local-agent/settings.json
printf '%s\n' 'KEEP=missing' > .envrc
cp .pi/local-agent/settings.json settings.before
cp .envrc envrc.before
set +e
HOME="$missing_home" "$PI_LOCAL_AUTH_BIN" > command.stdout 2> command.stderr
missing_status=$?
set -e
[ "$missing_status" -ne 0 ]
grep -F 'pi-local-auth: global settings not found or unreadable:' command.stderr
cmp settings.before .pi/local-agent/settings.json
cmp envrc.before .envrc
assert_no_temp_settings

assert_rejected_global_content() {
  local label=$1
  local content=$2
  local rejected_home
  local case_dir
  local command_status

  rejected_home=$(mktemp -d)
  mkdir -p "$rejected_home/.pi/agent"
  printf '%s' "$content" > "$rejected_home/.pi/agent/settings.json"

  case_dir=$(mktemp -d)
  cd "$case_dir"
  mkdir -p .pi/local-agent
  printf '%s\n' '{"sentinel":"settings"}' > .pi/local-agent/settings.json
  printf '%s\n' "KEEP=$label" > .envrc
  cp .pi/local-agent/settings.json settings.before
  cp .envrc envrc.before

  set +e
  HOME="$rejected_home" "$PI_LOCAL_AUTH_BIN" > command.stdout 2> command.stderr
  command_status=$?
  set -e

  [ "$command_status" -ne 0 ]
  grep -F 'pi-local-auth: invalid global settings:' command.stderr
  cmp settings.before .pi/local-agent/settings.json
  cmp envrc.before .envrc
  assert_no_temp_settings
}

assert_rejected_global_content empty ''
assert_rejected_global_content multiple $'{"one":1}\n{"two":2}\n'
assert_rejected_global_content non-object '[]'
assert_rejected_global_content nan '{"bad":NaN}'
assert_rejected_global_content infinity '{"bad":Infinity}'
assert_rejected_global_content plus-number '{"bad":+1}'
assert_rejected_global_content leading-zero '{"bad":01}'
assert_rejected_global_content leading-decimal '{"bad":.5}'

case_settings_directory=$(mktemp -d)
cd "$case_settings_directory"
mkdir -p .pi/local-agent/settings.json
printf '%s\n' 'keep-directory-content' > .pi/local-agent/settings.json/keep
printf '%s\n' 'KEEP=directory' > .envrc
cp .envrc envrc.before
set +e
"$PI_LOCAL_AUTH_BIN" > command.stdout 2> command.stderr
directory_status=$?
set -e
[ "$directory_status" -ne 0 ]
grep -F 'pi-local-auth: could not replace local settings:' command.stderr
test -d .pi/local-agent/settings.json
grep -Fx 'keep-directory-content' .pi/local-agent/settings.json/keep
cmp envrc.before .envrc
assert_no_temp_settings

case_settings_symlink_directory=$(mktemp -d)
cd "$case_settings_symlink_directory"
mkdir -p .pi/local-agent settings-target
printf '%s\n' 'keep-target-content' > settings-target/keep
ln -s "$case_settings_symlink_directory/settings-target" .pi/local-agent/settings.json
"$PI_LOCAL_AUTH_BIN"
[ ! -L .pi/local-agent/settings.json ]
test -f .pi/local-agent/settings.json
jq -e '.globalMarker == "updated-home"' .pi/local-agent/settings.json
assert_routing_overrides .pi/local-agent/settings.json
grep -Fx 'keep-target-content' settings-target/keep
grep -Fx 'export PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"' .envrc

case_python_shadow=$(mktemp -d)
cd "$case_python_shadow"
cat > json.py <<'PY'
from pathlib import Path

Path("json-imported").write_text("yes")
raise RuntimeError("project json.py imported")
PY
"$PI_LOCAL_AUTH_BIN"
[ ! -e json-imported ]
jq -e '.globalMarker == "updated-home"' .pi/local-agent/settings.json

case_agent_dir_symlink=$(mktemp -d)
cd "$case_agent_dir_symlink"
mkdir -p .pi
ln -s "$HOME/.pi/agent" .pi/local-agent
cp "$HOME/.pi/agent/settings.json" global-settings.before
printf '%s\n' 'KEEP=agent-dir-symlink' > .envrc
cp .envrc envrc.before
set +e
"$PI_LOCAL_AUTH_BIN" > command.stdout 2> command.stderr
agent_dir_symlink_status=$?
set -e
[ "$agent_dir_symlink_status" -ne 0 ]
grep -F 'pi-local-auth: local agent directory resolves outside the project:' command.stderr
cmp global-settings.before "$HOME/.pi/agent/settings.json"
cmp envrc.before .envrc
[ -L .pi/local-agent ]

case_pi_dir_symlink=$(mktemp -d)
pi_dir_target=$(mktemp -d)
cd "$case_pi_dir_symlink"
ln -s "$pi_dir_target" .pi
cp "$HOME/.pi/agent/settings.json" global-settings.before
printf '%s\n' 'KEEP=pi-dir-symlink' > .envrc
cp .envrc envrc.before
set +e
"$PI_LOCAL_AUTH_BIN" > command.stdout 2> command.stderr
pi_dir_symlink_status=$?
set -e
[ "$pi_dir_symlink_status" -ne 0 ]
grep -F 'pi-local-auth: local agent directory resolves outside the project:' command.stderr
cmp global-settings.before "$HOME/.pi/agent/settings.json"
cmp envrc.before .envrc
[ -L .pi ]

if [ -n "${out:-}" ]; then
  touch "$out"
fi
