set -euo pipefail

fail() {
  printf 'real-jail assertion failed: %s\n' "$1" >&2
  exit 1
}
reject() {
  if "$@" > /dev/null 2>&1; then
    fail "rejected command succeeded"
  fi
}

host_private="$1"
host_runtime="$2"
host_bare="$3"
fake_host_tools="$4"
fake_server="$5"
gh_config_sentinel="$6"
keyring_sentinel="$7"
ssh_config_sentinel="$8"
ssh_key_sentinel="$9"
agent_socket="${10}"
host_audit_log="${11}"

for variable in \
  GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN \
  SSH_AUTH_SOCK GH_CONFIG_DIR FAKE_HOST_ENV_SENTINEL BROKER_TEST_PRIVATE \
  BROKER_TEST_BARE
do
  if [[ -v $variable ]]; then
    fail "host environment variable is present"
  fi
done

assert_hidden() {
  test ! -e "$1" || fail "$2 is visible"
}
assert_hidden "$host_private" "host private directory"
assert_hidden "$host_runtime" "host runtime directory"
assert_hidden "$host_bare" "host bare repository"
assert_hidden "$fake_host_tools" "fake host tools"
assert_hidden "$fake_server" "fake broker server"
assert_hidden "$gh_config_sentinel" "host gh config"
assert_hidden "$keyring_sentinel" "host keyring"
assert_hidden "$ssh_config_sentinel" "host SSH config"
assert_hidden "$ssh_key_sentinel" "host SSH key"
assert_hidden "$agent_socket" "host SSH agent socket"
assert_hidden "$host_audit_log" "host audit log"
test ! -S "$agent_socket" || fail "host SSH agent socket is available"
for jail_fd in "/proc/$$/fd/"*; do
  jail_fd_target="$(readlink "$jail_fd" 2>/dev/null || true)"
  test "$jail_fd_target" != "$host_audit_log" || fail "host audit FD is inherited"
done
test ! -e /proc/$$/fd/3 || fail "host audit descriptor 3 is inherited"

test "$JAILED_GITHUB_BROKER_SOCKET" = /run/jailed-github-broker/broker.sock || \
  fail "broker socket path is not stable"
test -S "$JAILED_GITHUB_BROKER_SOCKET" || fail "broker socket is unavailable"
test "$JAILED_GITHUB_BROKER_REPOSITORY" = alpha/demo || fail "repository is not pinned"
client_gh="$(command -v gh)"
client_ssh="$(command -v jailed-git-ssh)"
test -x "$client_gh" && test -x "$client_ssh" || fail "clean clients are unavailable"
test "$GIT_SSH_COMMAND" = "$client_ssh" || fail "Git SSH shim is not pinned"
test ! -e "$(dirname "$client_gh")/jailed-github-broker" || \
  fail "server executable crossed into jail"

mkdir -p poison
cat > poison/gh <<'SH'
#!/bin/sh
touch poison-invoked
exit 99
SH
cp poison/gh poison/ssh
chmod +x poison/gh poison/ssh
export PATH="$PWD/poison:$PATH"
export GH_HOST=evil.example GH_REPO=beta/other GH_DEBUG=api
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_SSH_VARIANT=ssh

"$client_gh" repo view --json nameWithOwner,defaultBranch > repo.json
jq -e '.nameWithOwner == "alpha/demo" and .defaultBranch == "main"' repo.json > /dev/null || \
  fail "supported repository read returned unexpected data"
"$client_gh" repo view > hostile-environment-repo.json
jq -e '.nameWithOwner == "alpha/demo"' hostile-environment-repo.json > /dev/null || \
  fail "hostile repository environment redirected broker"
reject "$client_gh" repo view --repo beta/other
reject "$client_gh" api /user
"$client_gh" issue create --title 'audit title' --body AUDIT-BODY-SECRET-SENTINEL \
  > issue-create.json
jq -e '.number == 17' issue-create.json >/dev/null || \
  fail "supported issue write returned unexpected data"

reject "$client_ssh" root@github.com "git-upload-pack 'alpha/demo.git'"
reject "$client_ssh" git@evil.example "git-upload-pack 'alpha/demo.git'"
reject "$client_ssh" -o ProxyCommand=sh git@github.com "git-upload-pack 'alpha/demo.git'"
reject "$client_ssh" git@github.com "sh -c id"
reject "$client_ssh" git@github.com "git-upload-pack 'beta/other.git'"

git clone -q git@github.com:alpha/demo.git checkout
test "$(cat checkout/base.txt)" = base || fail "clone did not receive controlled repository"
git -C checkout fetch -q origin
git -C checkout config user.name 'Jailed Test'
git -C checkout config user.email jailed-test@example.invalid
printf '%s\n' PACK-AUDIT-SECRET-SENTINEL > checkout/feature.txt
git -C checkout add feature.txt
git -C checkout commit -q -m feature
git -C checkout push -q origin HEAD:refs/heads/feature/task-10
reject git -C checkout push -q origin HEAD:refs/heads/main

test ! -e poison-invoked || fail "hostile jail PATH was invoked"
touch real-jail-success
