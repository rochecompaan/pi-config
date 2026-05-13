---
name: bootstrapping-tilt-worktrees
description: Use when a project uses Tilt and kubectl with git worktrees, subagents, parallel test loops, non-default Tilt ports, Kubernetes namespaces, .env files, Makefile, Taskfile, or Justfile wrappers.
---

# Bootstrapping Tilt Worktrees

## Overview

Core principle: per-worktree Tilt configuration must be executable state, not remembered shell exports. Put reusable logic in scripts, keep Makefile/Taskfile/Justfile targets as thin adapters, and make every Tilt/kubectl/test command consume the same ignored `.env` contract.

## When to Use

Use for projects with Tilt + kubectl where any of these appear:

- parallel git worktrees or subagents
- non-default `TILT_PORT` or Kubernetes namespace
- server tests that run through `kubectl exec`
- raw docs telling agents to `export ...` before `tilt up`
- Makefile, Taskfile, or Justfile targets that should wrap Tilt safely

Do not use for single-worktree projects that never run concurrent Tilt instances unless the team still wants a scripted `.env` bootstrap.

## Required Workflow

1. Read `README.md` in this skill before adapting it into a project.
2. Copy the reusable scripts from `scripts/` into the project, usually under `scripts/tilt-worktree/` or `scripts/`.
3. Configure project-specific env names and port specs in the build-tool wrapper or committed example docs.
4. Add thin build-runner targets only; do not duplicate port allocation or readiness logic in Make/Task/Just.
5. Require orchestrators to run the bootstrap script immediately after creating a worktree and before launching a subagent.
6. Make test targets call the readiness guard before Tilt-backed tests.
7. Make `kubectl` test commands use the configured namespace from `.env`.
8. Report verification evidence from the configured Tilt instance, not from default `tilt logs` or host-only tests.

## Quick Reference

| Need | Script |
| --- | --- |
| Create/update ignored `.env` | `scripts/bootstrap-tilt-worktree-env.sh` |
| Start/log/stop matching Tilt instance | `scripts/tilt-worktree.sh up|logs|down` |
| Fail fast unless Tilt + deployment are ready | `scripts/ensure-tilt-ready.sh` |
| Customize namespace env var | `TILT_WORKTREE_NAMESPACE_ENV=CROPRUN_TILT_NAMESPACE` |
| Customize namespace prefix | `TILT_WORKTREE_NAMESPACE_PREFIX=croprun` |
| Customize ports | `TILT_WORKTREE_PORT_SPECS="TILT_PORT:10380 APP_PORT:18080"` |
| Customize ready resource | `TILT_WORKTREE_READY_RESOURCE=deploy/server` |

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Documenting `export TILT_PORT=...` and trusting agents to remember it | Generate/preserve `.env` with the bootstrap script |
| Baking logic into `just test` or `make test` | Put logic in scripts; wrappers only call scripts |
| Checking `tilt logs` without `--port` | Use `tilt-worktree.sh logs` or `tilt --port "$TILT_PORT" logs` |
| Running `kubectl exec deploy/server` in the default namespace | Use `kubectl -n "$CONFIGURED_NAMESPACE" exec ...` |
| Running raw `tilt down` | Use the wrapper so down targets the current worktree's port and namespace |
| Treating host `go test`/unit tests as equivalent to Tilt-backed tests | State explicitly that Tilt-backed DB/kubectl tests were not run |

## Red Flags

Stop and fix the workflow if you are about to write:

- “Run these exports first…”
- plain `tilt up`, `tilt logs`, or `tilt down` in worktree docs
- plain `kubectl exec deploy/server` without `-n`
- separate Make/Task/Just implementations of the same port logic
- a subagent handoff that does not mention bootstrapping `.env`

## Verification

For the skill package itself, run:

```bash
.pi/skills/bootstrapping-tilt-worktrees/scripts/test-tilt-worktree-scripts.sh
bash -n .pi/skills/bootstrapping-tilt-worktrees/scripts/*.sh
```

When adapted into a project, verify:

- bootstrap creates `.env` and preserves existing values
- occupied base ports increment to the next free set
- Tilt wrappers use the configured `TILT_PORT` and namespace
- test wrappers fail before `kubectl exec` when Tilt is down
- successful test reports include Tilt readiness evidence
