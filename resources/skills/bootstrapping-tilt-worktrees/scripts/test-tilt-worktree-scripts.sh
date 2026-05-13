#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bootstrap_script="$script_dir/bootstrap-tilt-worktree-env.sh"
tilt_script="$script_dir/tilt-worktree.sh"
ready_script="$script_dir/ensure-tilt-ready.sh"

tmpdir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  grep -Fq -- "$expected" "$file" || {
    echo "Expected $file to contain: $expected" >&2
    echo "Actual content:" >&2
    cat "$file" >&2
    exit 1
  }
}

assert_matches() {
  local file="$1"
  local pattern="$2"
  grep -Eq -- "$pattern" "$file" || {
    echo "Expected $file to match: $pattern" >&2
    echo "Actual content:" >&2
    cat "$file" >&2
    exit 1
  }
}

make_fake_bin() {
  local name="$1"
  local body="$2"
  cat > "$tmpdir/$name" <<FAKE
#!/usr/bin/env bash
set -euo pipefail
$body
FAKE
  chmod +x "$tmpdir/$name"
}

run_bootstrap() {
  local workdir="$1"
  shift
  mkdir -p "$workdir"
  (
    cd "$workdir"
    "$@" "$bootstrap_script" >/tmp/tilt-worktree-bootstrap.out 2>&1
  )
}

run_bootstrap "$tmpdir/fresh" env
assert_contains "$tmpdir/fresh/.env" "TILT_PORT=10380"
assert_matches "$tmpdir/fresh/.env" '^TILT_WORKTREE_NAMESPACE=tilt-fresh$'

mkdir -p "$tmpdir/existing"
cat > "$tmpdir/existing/.env" <<'ENV'
TILT_PORT=10444
TILT_WORKTREE_NAMESPACE=tilt-custom
EXTRA_VALUE=keep-me
ENV
run_bootstrap "$tmpdir/existing" env
assert_contains "$tmpdir/existing/.env" "TILT_PORT=10444"
assert_contains "$tmpdir/existing/.env" "TILT_WORKTREE_NAMESPACE=tilt-custom"
assert_contains "$tmpdir/existing/.env" "EXTRA_VALUE=keep-me"

node <<'NODE' &
const net = require('net');
const ports = [32100, 33100, 34100];
const servers = ports.map((port) => net.createServer().listen(port, '127.0.0.1'));
process.on('SIGTERM', () => {
  for (const server of servers) server.close();
  process.exit(0);
});
setInterval(() => {}, 1000);
NODE
listener_pid=$!
sleep 1
run_bootstrap "$tmpdir/occupied" env \
  TILT_WORKTREE_NAMESPACE_ENV=CROPRUN_TILT_NAMESPACE \
  TILT_WORKTREE_NAMESPACE_PREFIX=croprun \
  TILT_WORKTREE_PORT_SPECS="TILT_PORT:32100 CROPRUN_SERVER_PORT:33100 CROPRUN_LAN_SERVER_PORT:34100"
kill "$listener_pid"
wait "$listener_pid" 2>/dev/null || true
assert_contains "$tmpdir/occupied/.env" "TILT_PORT=32101"
assert_matches "$tmpdir/occupied/.env" '^CROPRUN_TILT_NAMESPACE=croprun-occupied$'
assert_contains "$tmpdir/occupied/.env" "CROPRUN_SERVER_PORT=33101"
assert_contains "$tmpdir/occupied/.env" "CROPRUN_LAN_SERVER_PORT=34101"

mkdir -p "$tmpdir/invalid-port"
set +e
(
  cd "$tmpdir/invalid-port"
  TILT_WORKTREE_PORT_SPECS="TILT_PORT:70000" "$bootstrap_script" >/tmp/tilt-worktree-invalid-port.out 2>&1
)
invalid_status=$?
set -e
if [ "$invalid_status" -eq 0 ]; then
  fail "invalid port base unexpectedly succeeded"
fi
assert_contains /tmp/tilt-worktree-invalid-port.out "Invalid port base in TILT_WORKTREE_PORT_SPECS: TILT_PORT:70000"

mkdir -p "$tmpdir/existing-invalid-port"
cat > "$tmpdir/existing-invalid-port/.env" <<'ENV'
TILT_PORT=abc
ENV
set +e
(
  cd "$tmpdir/existing-invalid-port"
  "$bootstrap_script" >/tmp/tilt-worktree-existing-invalid-port.out 2>&1
)
existing_invalid_status=$?
set -e
if [ "$existing_invalid_status" -eq 0 ]; then
  fail "existing invalid port unexpectedly succeeded"
fi
assert_contains /tmp/tilt-worktree-existing-invalid-port.out "Invalid existing port value in .env: TILT_PORT=abc"

run_bootstrap "$tmpdir/ugly-name-with-a-trailing-cut------------------------------------------------" env \
  TILT_WORKTREE_NAMESPACE_PREFIX='My_App_'
assert_matches "$tmpdir/ugly-name-with-a-trailing-cut------------------------------------------------/.env" '^TILT_WORKTREE_NAMESPACE=my-app-ugly-name-with-a-trailing-cut$'

mkdir -p "$tmpdir/poison"
cat > "$tmpdir/poison/.env" <<ENV
TILT_PORT=32101
CROPRUN_TILT_NAMESPACE=croprun-poison
POISON=\$(touch '$tmpdir/poisoned')
ENV

make_fake_bin kubectl '
case "$*" in
  "create namespace croprun-occupied --dry-run=client -o yaml")
    echo "kubectl $*" >> "$TMPDIR/fake-tilt.args"
    printf "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: croprun-occupied\n"
    ;;
  "apply -f -")
    cat >/dev/null
    echo "kubectl $*" >> "$TMPDIR/fake-tilt.args"
    ;;
  *)
    echo "unexpected kubectl args: $*" >&2
    exit 2
    ;;
esac
'
make_fake_bin tilt '
echo "tilt $*" >> "$TMPDIR/fake-tilt.args"
exit 0
'
(
  cd "$tmpdir/occupied"
  TMPDIR="$tmpdir" PATH="$tmpdir:$PATH" \
    TILT_WORKTREE_NAMESPACE_ENV=CROPRUN_TILT_NAMESPACE \
    "$tilt_script" up >/tmp/tilt-worktree-up.out 2>&1
)
assert_contains "$tmpdir/fake-tilt.args" "kubectl create namespace croprun-occupied --dry-run=client -o yaml"
assert_contains "$tmpdir/fake-tilt.args" "kubectl apply -f -"
assert_contains "$tmpdir/fake-tilt.args" "tilt up --port 32101 --namespace croprun-occupied"

rm -f "$tmpdir/fake-tilt.args"
make_fake_bin tilt '
if [ "$*" = "down --namespace croprun-occupied" ]; then
  echo "tilt $*" >> "$TMPDIR/fake-tilt.args"
  exit 0
fi
echo "unexpected tilt args: $*" >&2
exit 2
'
(
  cd "$tmpdir/occupied"
  TMPDIR="$tmpdir" PATH="$tmpdir:$PATH" \
    TILT_WORKTREE_NAMESPACE_ENV=CROPRUN_TILT_NAMESPACE \
    "$tilt_script" down >/tmp/tilt-worktree-down-action.out 2>&1
)
assert_contains "$tmpdir/fake-tilt.args" "tilt down --namespace croprun-occupied"

set +e
(
  cd "$tmpdir/occupied"
  TMPDIR="$tmpdir" PATH="$tmpdir:$PATH" \
    TILT_WORKTREE_NAMESPACE_ENV=CROPRUN_TILT_NAMESPACE \
    TILT_PORT=abc \
    "$tilt_script" logs >/tmp/tilt-worktree-invalid-env-port.out 2>&1
)
wrapper_invalid_status=$?
set -e
if [ "$wrapper_invalid_status" -eq 0 ]; then
  fail "tilt-worktree accepted invalid TILT_PORT from environment"
fi
assert_contains /tmp/tilt-worktree-invalid-env-port.out "Invalid TILT_PORT: abc"

rm -f "$tmpdir/fake-tilt.args"
set +e
(
  cd "$tmpdir/occupied"
  TMPDIR="$tmpdir" PATH="$tmpdir:$PATH" \
    TILT_WORKTREE_NAMESPACE_ENV=CROPRUN_TILT_NAMESPACE \
    TILT_PORT=abc \
    "$ready_script" >/tmp/tilt-worktree-ready-invalid-env-port.out 2>&1
)
ready_invalid_status=$?
set -e
if [ "$ready_invalid_status" -eq 0 ]; then
  fail "ensure-tilt-ready accepted invalid TILT_PORT from environment"
fi
assert_contains /tmp/tilt-worktree-ready-invalid-env-port.out "Invalid TILT_PORT: abc"
if [ -e "$tmpdir/fake-tilt.args" ]; then
  fail "ensure-tilt-ready invoked tilt with an invalid TILT_PORT"
fi

make_fake_bin tilt '
if [ "$1" = "--port" ] && [ "$2" = "32101" ] && [ "$3" = "logs" ]; then
  exit 0
fi
echo "unexpected tilt args: $*" >&2
exit 2
'
(
  cd "$tmpdir/poison"
  TMPDIR="$tmpdir" PATH="$tmpdir:$PATH" \
    TILT_WORKTREE_NAMESPACE_ENV=CROPRUN_TILT_NAMESPACE \
    "$tilt_script" logs --tail=1 >/tmp/tilt-worktree-poison.out 2>&1
)
if [ -e "$tmpdir/poisoned" ]; then
  fail "tilt-worktree.sh executed non-required .env content"
fi

make_fake_bin tilt '
if [ "$1" = "--port" ] && [ "$2" = "32101" ] && [ "$3" = "logs" ]; then
  exit 0
fi
echo "unexpected tilt args: $*" >&2
exit 2
'
make_fake_bin kubectl '
if [ "$1" = "-n" ] && [ "$2" = "croprun-occupied" ] && [ "$3" = "wait" ] && [ "$4" = "--for=condition=Available" ] && [ "$5" = "deploy/server" ]; then
  exit 0
fi
echo "unexpected kubectl args: $*" >&2
exit 2
'
(
  cd "$tmpdir/occupied"
  PATH="$tmpdir:$PATH" \
    TILT_WORKTREE_NAMESPACE_ENV=CROPRUN_TILT_NAMESPACE \
    TILT_WORKTREE_READY_RESOURCE=deploy/server \
    "$ready_script" >/tmp/tilt-worktree-ready.out 2>&1
)
assert_contains /tmp/tilt-worktree-ready.out "Tilt is running and deploy/server is ready in namespace croprun-occupied."

make_fake_bin tilt '
if [ "$1" = "--port" ] && [ "$2" = "32101" ] && [ "$3" = "logs" ]; then
  echo "Tilt is down" >&2
  exit 1
fi
echo "unexpected tilt args: $*" >&2
exit 2
'
make_fake_bin kubectl '
touch "$TMPDIR/kubectl-called-while-tilt-down"
exit 99
'
set +e
(
  cd "$tmpdir/occupied"
  TMPDIR="$tmpdir" PATH="$tmpdir:$PATH" \
    TILT_WORKTREE_NAMESPACE_ENV=CROPRUN_TILT_NAMESPACE \
    TILT_WORKTREE_READY_RESOURCE=deploy/server \
    "$ready_script" >/tmp/tilt-worktree-down.out 2>&1
)
down_status=$?
set -e
if [ "$down_status" -eq 0 ]; then
  fail "ensure-tilt-ready unexpectedly succeeded when Tilt was down"
fi
if [ -e "$tmpdir/kubectl-called-while-tilt-down" ]; then
  fail "kubectl was called while Tilt was down"
fi
assert_contains /tmp/tilt-worktree-down.out "Configured TILT_PORT=32101"
assert_contains /tmp/tilt-worktree-down.out "Configured CROPRUN_TILT_NAMESPACE=croprun-occupied"

echo "tilt worktree script tests passed"
