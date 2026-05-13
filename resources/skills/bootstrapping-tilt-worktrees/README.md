# Bootstrapping Tilt Worktrees

This package helps projects that use Tilt + kubectl run safely from multiple git worktrees. It replaces fragile remembered exports with an ignored per-worktree `.env` file and reusable scripts that any build runner can wrap.

## Install in a project

Copy the scripts into your project:

```bash
mkdir -p scripts/tilt-worktree
cp .pi/skills/bootstrapping-tilt-worktrees/scripts/bootstrap-tilt-worktree-env.sh scripts/tilt-worktree/
cp .pi/skills/bootstrapping-tilt-worktrees/scripts/tilt-worktree.sh scripts/tilt-worktree/
cp .pi/skills/bootstrapping-tilt-worktrees/scripts/ensure-tilt-ready.sh scripts/tilt-worktree/
chmod +x scripts/tilt-worktree/*.sh
```

Ensure `.env` is ignored by git.

## Configure for your project

The scripts work with defaults, but most projects should set these in wrapper targets or docs:

```bash
export TILT_WORKTREE_NAMESPACE_ENV=CROPRUN_TILT_NAMESPACE
export TILT_WORKTREE_NAMESPACE_PREFIX=croprun
export TILT_WORKTREE_PORT_SPECS="TILT_PORT:10380 CROPRUN_SERVER_PORT:18080 CROPRUN_LAN_SERVER_PORT:19080"
export TILT_WORKTREE_READY_RESOURCE=deploy/server
```

Generated `.env` example:

```env
CROPRUN_TILT_NAMESPACE=croprun-feature-x
TILT_PORT=10380
CROPRUN_SERVER_PORT=18080
CROPRUN_LAN_SERVER_PORT=19080
```

Existing values are preserved. Missing values are appended. If a base port is occupied, all missing port specs advance together to the next free offset.

## Orchestrator workflow

An orchestrator that creates worktrees for subagents must run bootstrap before handoff:

```bash
scripts/tilt-worktree/bootstrap-tilt-worktree-env.sh
```

Then the subagent should use project targets such as `tilt-up`, `tilt-logs`, `test`, and `tilt-down`; it should not remember raw exports.

## Justfile adapter

```make
tilt_env_vars := 'TILT_WORKTREE_NAMESPACE_ENV=CROPRUN_TILT_NAMESPACE TILT_WORKTREE_NAMESPACE_PREFIX=croprun TILT_WORKTREE_PORT_SPECS="TILT_PORT:10380 CROPRUN_SERVER_PORT:18080 CROPRUN_LAN_SERVER_PORT:19080"'

tilt-env:
	{{tilt_env_vars}} scripts/tilt-worktree/bootstrap-tilt-worktree-env.sh

tilt-up:
	{{tilt_env_vars}} scripts/tilt-worktree/tilt-worktree.sh up

tilt-logs:
	{{tilt_env_vars}} scripts/tilt-worktree/tilt-worktree.sh logs

tilt-down:
	{{tilt_env_vars}} scripts/tilt-worktree/tilt-worktree.sh down

test:
	#!/usr/bin/env bash
	set -euo pipefail
	{{tilt_env_vars}} TILT_WORKTREE_READY_RESOURCE=deploy/server scripts/tilt-worktree/ensure-tilt-ready.sh
	namespace="$(sed -n 's/^CROPRUN_TILT_NAMESPACE=//p' .env | tail -n 1)"
	kubectl -n "$namespace" exec deploy/server -- sh -c 'cd /app/src && go test -p 1 -v ./...'
```

If `.env` may be created during the same recipe, read the specific generated keys after the bootstrap step instead of sourcing the entire file.

## Makefile adapter

```make
TILT_ENV = TILT_WORKTREE_NAMESPACE_ENV=CROPRUN_TILT_NAMESPACE \
           TILT_WORKTREE_NAMESPACE_PREFIX=croprun \
           TILT_WORKTREE_PORT_SPECS="TILT_PORT:10380 CROPRUN_SERVER_PORT:18080 CROPRUN_LAN_SERVER_PORT:19080"

tilt-env:
	$(TILT_ENV) scripts/tilt-worktree/bootstrap-tilt-worktree-env.sh

tilt-up:
	$(TILT_ENV) scripts/tilt-worktree/tilt-worktree.sh up

tilt-logs:
	$(TILT_ENV) scripts/tilt-worktree/tilt-worktree.sh logs

tilt-down:
	$(TILT_ENV) scripts/tilt-worktree/tilt-worktree.sh down

test:
	$(TILT_ENV) TILT_WORKTREE_READY_RESOURCE=deploy/server scripts/tilt-worktree/ensure-tilt-ready.sh
	namespace="$$(sed -n 's/^CROPRUN_TILT_NAMESPACE=//p' .env | tail -n 1)"; \
	kubectl -n "$$namespace" exec deploy/server -- sh -c 'cd /app/src && go test -p 1 -v ./...'
```

## Taskfile adapter

```yaml
version: '3'

env:
  TILT_WORKTREE_NAMESPACE_ENV: CROPRUN_TILT_NAMESPACE
  TILT_WORKTREE_NAMESPACE_PREFIX: croprun
  TILT_WORKTREE_PORT_SPECS: TILT_PORT:10380 CROPRUN_SERVER_PORT:18080 CROPRUN_LAN_SERVER_PORT:19080

tasks:
  tilt-env:
    cmds:
      - scripts/tilt-worktree/bootstrap-tilt-worktree-env.sh
  tilt-up:
    cmds:
      - scripts/tilt-worktree/tilt-worktree.sh up
  tilt-logs:
    cmds:
      - scripts/tilt-worktree/tilt-worktree.sh logs
  tilt-down:
    cmds:
      - scripts/tilt-worktree/tilt-worktree.sh down
  test:
    cmds:
      - TILT_WORKTREE_READY_RESOURCE=deploy/server scripts/tilt-worktree/ensure-tilt-ready.sh
      - |
        namespace="$(sed -n 's/^CROPRUN_TILT_NAMESPACE=//p' .env | tail -n 1)"
        kubectl -n "$namespace" exec deploy/server -- sh -c 'cd /app/src && go test -p 1 -v ./...'
```

## Tiltfile integration

Your Tiltfile must read `.env` and use generated port values. Example Starlark shape:

```python
load('ext://dotenv', 'dotenv')

dotenv('.env')
server_port = os.getenv('CROPRUN_SERVER_PORT', '8080')
lan_server_port = os.getenv('CROPRUN_LAN_SERVER_PORT', '9080')
forward_ip = os.getenv('TILT_FORWARD_IP', '')

server_port_forwards = ['%s:8080' % server_port]
if forward_ip:
    server_port_forwards.append('%s:%s:8080' % (forward_ip, lan_server_port))

k8s_resource('server', port_forwards=server_port_forwards)
```

## Script reference

### `bootstrap-tilt-worktree-env.sh`

Creates/updates `.env`.

Configuration:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TILT_WORKTREE_ENV_FILE` | `.env` | Env file to create/update |
| `TILT_WORKTREE_NAMESPACE_ENV` | `TILT_WORKTREE_NAMESPACE` | Name of the project namespace variable to write |
| `TILT_WORKTREE_NAMESPACE_PREFIX` | `tilt` | Prefix for generated namespace |
| `TILT_WORKTREE_PORT_SPECS` | `TILT_PORT:10380` | Space-separated `ENV_NAME:BASE_PORT` specs |

### `tilt-worktree.sh`

Runs Tilt against the configured instance:

```bash
scripts/tilt-worktree/tilt-worktree.sh up
scripts/tilt-worktree/tilt-worktree.sh logs --tail=20
scripts/tilt-worktree/tilt-worktree.sh down
```

### `ensure-tilt-ready.sh`

Fails unless Tilt responds on the configured port and the configured Kubernetes resource is available.

Configuration:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TILT_WORKTREE_READY_RESOURCE` | `deploy/server` | Resource passed to `kubectl wait` |
| `TILT_WORKTREE_READY_TIMEOUT` | `5s` | Wait timeout |

## Verification

After integration:

```bash
scripts/tilt-worktree/bootstrap-tilt-worktree-env.sh
# then use your wrapper:
just tilt-up      # or make tilt-up / task tilt-up
just tilt-logs    # or make tilt-logs / task tilt-logs
just test         # or make test / task test
```

A valid test target should fail before `kubectl exec` when the configured Tilt instance is down, and it should print the configured port and namespace in diagnostics.
