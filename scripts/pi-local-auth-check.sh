#!/usr/bin/env bash
set -eu

: "${PI_LOCAL_AUTH_BIN:?Set PI_LOCAL_AUTH_BIN to the pi-local-auth executable path}"

# shellcheck disable=SC2016
auth_line='export PI_CODING_AGENT_AUTH_FILE="$PWD/.pi/local-agent/auth.json"'
# shellcheck disable=SC2016
legacy_dir_line='export PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"'
# shellcheck disable=SC2016
legacy_session_line='export PI_CODING_AGENT_SESSION_DIR="$HOME/.pi/agent/sessions"'

# The script must not depend on global Pi settings.
HOME=$(mktemp -d)
export HOME

new_case() {
  local case_dir
  case_dir=$(mktemp -d)
  cd "$case_dir"
}

assert_line_count() {
  local pattern=$1
  local expected=$2
  [ "$(grep -c -- "$pattern" .envrc)" -eq "$expected" ]
}

# A fresh project gets a private, empty auth file and one .envrc export.
new_case
"$PI_LOCAL_AUTH_BIN"
test -f .pi/local-agent/auth.json
[ "$(cat .pi/local-agent/auth.json)" = '{}' ]
[ "$(stat -c %a .pi/local-agent/auth.json)" = 600 ]
[ "$(stat -c %a .pi/local-agent)" = 700 ]
grep -Fx "$auth_line" .envrc
[ ! -e .pi/local-agent/settings.json ]
assert_line_count 'PI_CODING_AGENT_DIR=' 0
assert_line_count 'PI_CODING_AGENT_SESSION_DIR=' 0

# Running again changes nothing.
cp .envrc envrc.before
cp .pi/local-agent/auth.json auth.before
"$PI_LOCAL_AUTH_BIN"
cmp envrc.before .envrc
cmp auth.before .pi/local-agent/auth.json

# Existing credentials are kept byte for byte.
new_case
mkdir -p .pi/local-agent
printf '%s\n' '{"openai-codex":{"type":"oauth"}}' > .pi/local-agent/auth.json
cp .pi/local-agent/auth.json auth.expected
"$PI_LOCAL_AUTH_BIN"
cmp auth.expected .pi/local-agent/auth.json
grep -Fx "$auth_line" .envrc

# A legacy setup is migrated: the lines the old script wrote are removed and
# unrelated lines keep their order.
new_case
mkdir -p .pi/local-agent
printf '%s\n' '{}' > .pi/local-agent/auth.json
printf '%s\n' '{"stale":true}' > .pi/local-agent/settings.json
cat > .envrc <<EOF
use flake
$legacy_dir_line
export OPENAI_API_KEY=\$(op read "op://Private/key/credential")
$legacy_session_line
EOF
"$PI_LOCAL_AUTH_BIN"
cat > envrc.expected <<EOF
use flake
export OPENAI_API_KEY=\$(op read "op://Private/key/credential")
$auth_line
EOF
cmp envrc.expected .envrc

# Migration keeps the .envrc mode, and a symlinked .envrc stays a symlink.
new_case
printf '%s\n' 'use flake' "$legacy_dir_line" > envrc.target
chmod 640 envrc.target
ln -s envrc.target .envrc
"$PI_LOCAL_AUTH_BIN"
[ -L .envrc ]
[ "$(stat -c %a envrc.target)" = 640 ]
printf '%s\n' 'use flake' "$auth_line" > envrc.expected
cmp envrc.expected envrc.target

# The export starts on its own line when .envrc lacks a final newline.
new_case
printf '%s' 'use flake' > .envrc
"$PI_LOCAL_AUTH_BIN"
printf '%s\n' 'use flake' "$auth_line" > envrc.expected
cmp envrc.expected .envrc

# An unreadable .envrc stops the script before it writes anything.
if [ "$(id -u)" -ne 0 ]; then
  new_case
  printf '%s\n' "$legacy_dir_line" > .envrc
  chmod 200 .envrc
  set +e
  "$PI_LOCAL_AUTH_BIN" > command.stdout 2> command.stderr
  unreadable_status=$?
  set -e
  chmod 600 .envrc
  [ "$unreadable_status" -ne 0 ]
  grep -F 'pi-local-auth: could not read .envrc' command.stderr
  printf '%s\n' "$legacy_dir_line" > envrc.expected
  cmp envrc.expected .envrc

  # A read-only .envrc is left unchanged rather than half migrated.
  for content in 'use flake' "$legacy_dir_line"; do
    new_case
    printf '%s\n' "$content" > .envrc
    chmod 400 .envrc
    cp .envrc envrc.before
    set +e
    "$PI_LOCAL_AUTH_BIN" > command.stdout 2> command.stderr
    read_only_status=$?
    set -e
    [ "$read_only_status" -ne 0 ]
    grep -F 'pi-local-auth: could not write .envrc' command.stderr
    cmp envrc.before .envrc
    [ "$(stat -c %a .envrc)" = 400 ]
  done
fi

# A custom auth file assignment is kept and not duplicated.
new_case
# shellcheck disable=SC2016
printf '%s\n' 'export PI_CODING_AGENT_AUTH_FILE="$HOME/.pi/profiles/work/auth.json"' > .envrc
cp .envrc envrc.before
"$PI_LOCAL_AUTH_BIN"
cmp envrc.before .envrc

# A custom agent directory is kept, with a warning that it still moves all
# Pi settings away from the global agent directory.
new_case
printf '%s\n' 'export PI_CODING_AGENT_DIR="custom"' > .envrc
"$PI_LOCAL_AUTH_BIN" 2> command.stderr
grep -Fx 'export PI_CODING_AGENT_DIR="custom"' .envrc
grep -Fx "$auth_line" .envrc
grep -F 'pi-local-auth: warning: .envrc still sets PI_CODING_AGENT_DIR' command.stderr

# An auth file symlink is rejected: Pi would read and write its target.
for target in "$HOME/global-auth.json" "$HOME/missing-auth.json"; do
  new_case
  printf '%s\n' '{"openai":{"type":"api_key","key":"sk-global"}}' > "$HOME/global-auth.json"
  mkdir -p .pi/local-agent
  ln -s "$target" .pi/local-agent/auth.json
  printf '%s\n' 'KEEP=auth-symlink' > .envrc
  cp .envrc envrc.before
  set +e
  "$PI_LOCAL_AUTH_BIN" > command.stdout 2> command.stderr
  auth_symlink_status=$?
  set -e
  [ "$auth_symlink_status" -ne 0 ]
  grep -F 'pi-local-auth: auth file is a symlink: .pi/local-agent/auth.json' command.stderr
  cmp envrc.before .envrc
  [ ! -e "$HOME/missing-auth.json" ]
done

assert_rejected_symlink() {
  local status
  printf '%s\n' 'KEEP=symlink' > .envrc
  cp .envrc envrc.before
  set +e
  "$PI_LOCAL_AUTH_BIN" > command.stdout 2> command.stderr
  status=$?
  set -e
  [ "$status" -ne 0 ]
  grep -F 'pi-local-auth: local agent directory resolves outside the project:' command.stderr
  cmp envrc.before .envrc
}

# Symlinked .pi or .pi/local-agent directories are rejected without writes.
new_case
agent_dir_target=$(mktemp -d)
mkdir -p .pi
ln -s "$agent_dir_target" .pi/local-agent
assert_rejected_symlink
[ ! -e "$agent_dir_target/auth.json" ]

new_case
pi_dir_target=$(mktemp -d)
ln -s "$pi_dir_target" .pi
assert_rejected_symlink
[ ! -e "$pi_dir_target/local-agent" ]

if [ -n "${out:-}" ]; then
  touch "$out"
fi
