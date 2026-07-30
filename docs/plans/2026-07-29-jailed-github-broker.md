# Jailed GitHub Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan task-by-task. Production behavior tasks require `test-driven-development` and `verification-before-completion`.

**Goal:** Add a reusable, repository-pinned Unix-socket broker that lets jailed Pi use a limited `gh` subset and Git SSH transport through existing host authentication without exposing reusable GitHub or SSH credentials to the jail.

**Architecture:** A standard-library Go multicall binary runs as a per-jailed-Pi host broker and provides jailed `gh` and Git SSH client modes. Typed API requests become fixed `gh api --hostname github.com` commands. Git uses a framed full-duplex bridge to fixed GitHub `git-upload-pack` and `git-receive-pack` SSH commands; jailed Git exclusively owns `.git` and the working tree. The broker denies `refs/heads/main` by default while permitting all other updates GitHub accepts.

**Tech Stack:** Go standard library, Unix sockets, Git pkt-line protocol, host GitHub CLI, host OpenSSH, Nix flakes, jail-nix, Home Manager, Bash-backed Nix checks.

**Reference design:** `docs/specs/2026-07-29-jailed-github-broker-design.md`

## Global constraints

- Do not expose `GH_TOKEN`, `GITHUB_TOKEN`, GitHub CLI configuration, keyring access, SSH keys, SSH configuration, or `SSH_AUTH_SOCK` because of this feature.
- Do not inspect, preflight, normalize, retrieve, or alter host `gh` authentication or its environment.
- Pin `github.com` and the configured repository in every host command.
- Do not invoke a local shell for host `gh` or SSH commands.
- Do not let host Git or host `gh` open the jail-controlled checkout.
- Unknown protocol, operation, field, frame ordering, Git update form, or capability must fail closed.
- Default push denial is the exact ref `refs/heads/main`; all other GitHub-accepted ref updates remain allowed unless explicitly denied.
- Non-fast-forward policy stays with GitHub rulesets and branch protection.
- Keep focused Go files near or below 250 lines and split before roughly 300 lines.
- Do not modify `pi-intervals`.
- `/home/roche/projects/clubhouse/clubhouse_infra/devenv.nix` and `.envrc` are intentionally ignored. Never force-add or commit them.
- Keep `clubhouse_infra` on its existing SSH origin.

## File structure

### Go broker

- Create `packages/jailed-github-broker/go.mod`
- Create `packages/jailed-github-broker/cmd/jailed-github-broker/main.go`
- Create `packages/jailed-github-broker/internal/config/config.go`
- Create `packages/jailed-github-broker/internal/config/config_test.go`
- Create `packages/jailed-github-broker/internal/protocol/frame.go`
- Create `packages/jailed-github-broker/internal/protocol/control.go`
- Create `packages/jailed-github-broker/internal/protocol/protocol_test.go`
- Create `packages/jailed-github-broker/internal/policy/push.go`
- Create `packages/jailed-github-broker/internal/policy/push_test.go`
- Create `packages/jailed-github-broker/internal/gitproto/pktline.go`
- Create `packages/jailed-github-broker/internal/gitproto/receive.go`
- Create `packages/jailed-github-broker/internal/gitproto/receive_test.go`
- Create `packages/jailed-github-broker/internal/github/operations.go`
- Create `packages/jailed-github-broker/internal/github/operations_test.go`
- Create `packages/jailed-github-broker/internal/runner/runner.go`
- Create `packages/jailed-github-broker/internal/runner/runner_test.go`
- Create `packages/jailed-github-broker/internal/server/server.go`
- Create `packages/jailed-github-broker/internal/server/git.go`
- Create `packages/jailed-github-broker/internal/server/server_test.go`
- Create `packages/jailed-github-broker/internal/client/rpc.go`
- Create `packages/jailed-github-broker/internal/client/gh.go`
- Create `packages/jailed-github-broker/internal/client/ssh.go`
- Create `packages/jailed-github-broker/internal/client/client_test.go`

### Nix packaging and integration

- Create `nix/packages/jailed-github-broker.nix`
- Create `modules/packages/jailed-github-broker.nix`
- Create `nix/lib/jailed-github-broker.nix`
- Modify `modules/lib/jailed-pi.nix`
- Modify `modules/home/jailed-pi.nix`
- Create `modules/checks/jailed-github-broker.nix`
- Create `modules/checks/jailed-github-broker-wiring.nix`

Keep broker normalization, generated JSON, lifecycle shell, and socket permissions in `nix/lib/jailed-github-broker.nix`; keep the already-large jailed Pi modules to thin integration calls.

## Task 1: Define configuration and push-policy contracts

**Files:** configuration and policy files listed above.

**Tests first:**

- valid and invalid `owner/repository` slugs;
- missing repository when enabled;
- unknown capabilities and JSON fields;
- `git:write` requiring `git:read`;
- documented size, initial-frame, operation, idle-stream, and concurrency defaults;
- default rejection of exactly `refs/heads/main`;
- default acceptance of feature branches, tags, deletion, multiple updates, and force-shaped old/new pairs;
- custom exact deny refs, deletion denial, and maximum update count.

Run and observe RED:

```sh
cd packages/jailed-github-broker
go test ./internal/config ./internal/policy
```

Implement strict decoding with `json.Decoder.DisallowUnknownFields`, repository validation, capability dependencies, defaults, and syntactic push policy. Do not add commit ancestry logic.

Run and observe GREEN:

```sh
go test ./internal/config ./internal/policy
go test -race ./internal/config ./internal/policy
```

## Task 2: Implement bounded framed protocol

**Files:** `internal/protocol/*`.

Use a fixed header with frame kind and big-endian payload length. Implement one logical request per connection and the state transitions from the design.

**Tests first:**

- one-byte fragmented and coalesced reads;
- short headers and payloads;
- unknown kinds and protocol versions;
- exact and oversized per-kind limits before allocation;
- duplicate/trailing JSON and unknown fields;
- mismatched request IDs;
- invalid direction or frame order;
- duplicate input-end and process-exit frames;
- independent stdout/stderr ordering;
- chunked API responses crossing the control-frame and stream-frame boundaries without unbounded allocation.

Run RED, implement minimally, then run GREEN:

```sh
go test ./internal/protocol -v
go test -race ./internal/protocol
```

## Task 3: Parse receive-pack update commands

**Files:** `internal/gitproto/*`.

Implement a bounded pkt-line parser that returns the accepted raw prefix byte-for-byte plus typed ref updates.

**Tests first:**

- normal branch, tag, deletion, force-shaped, and multiple updates;
- default-main update;
- arbitrary socket fragmentation;
- malformed or truncated lengths;
- missing first-command capability separator;
- duplicate refs;
- invalid or non-UTF-8 ref names;
- consistent SHA-1 and SHA-256 object IDs;
- mixed widths;
- ambiguous flush boundaries;
- valid bounded shallow declarations before ordinary and signed updates;
- complete signed-push certificates whose embedded commands receive the same ref-policy validation;
- malformed certificate headers, commands, signatures, and terminators;
- push options accepted only when advertised;
- prefix above the configured limit;
- no forwardable bytes returned on failure.

Run RED, implement the documented `*shallow (command-list | push-cert)` update-request state machine, then run GREEN:

```sh
go test ./internal/gitproto ./internal/policy -v
go test -race ./internal/gitproto ./internal/policy
```

## Task 4: Define typed GitHub operations

**Files:** `internal/github/*`.

Implement both exact operation tables from the design. Every operation maps to one capability, fixed `github.com` REST endpoint or the one fixed Actions-log command, fixed method and headers, bounded request schema, normalized response schema, and raw-response limit.

The jail-side grammar may support familiar flags, but must reject incomplete writes, duplicate/unknown flags, URLs in numeric fields, file/template/editor/browser flags, implicit checkout/push behavior, project mutations, raw API access, auth commands, aliases, extensions, merge, workflow mutations, and repository administration.

`--repo` is optional or must exactly match the configured repository with optional `github.com/` prefix. `--jq` and response field selection stay jail-side.

**Tests first:** one success and relevant rejection cases for every operation, exact host argv and generated JSON comparisons, normalized response allowlist tests, raw-response and aggregate limit tests, the fixed issue-search query, issue update/comment preflights that reject pull requests before any mutation call, pull-request comment preflights that reject issues before any mutation call, check/status pagination at empty, exact-page, final-page, and over-limit boundaries, no partial multi-call results, hostile `GH_HOST`/`GH_REPO` environments, inert shell metacharacters, and proof that client output programs never reach host argv.

Run RED, implement explicit operation-specific parsing rather than pass-through, then run GREEN:

```sh
go test ./internal/github -v
```

## Task 5: Add host subprocess and audit boundaries

**Files:** `internal/runner/*` plus focused audit helpers if needed.

Host commands must:

- execute directly with fixed absolute paths and argv;
- inherit the normal host environment unchanged;
- run in a broker-private working directory;
- receive closed stdin for API operations;
- run in separate process groups;
- respect operation and idle timeouts;
- die and be reaped as a complete group on cancellation;
- never return or log raw host stderr;
- return fixed operation-specific failure messages and exit status;
- log only escaped metadata and byte counts.

**Tests first:** helper-process argv, environment inheritance, hostile debug environment, no shell interpretation, bounded output, generic errors, cancellation, timeout, process-group descendant cleanup, and audit redaction.

Run RED then GREEN:

```sh
go test ./internal/runner -v
go test -race ./internal/runner
```

## Task 6: Implement broker server and Git streaming

**Files:** `internal/server/*`.

The server must enforce version, operation, capability, concurrency, repository pinning, frame state, and subprocess cancellation before or during dispatch.

For Git:

- `git.uploadPack` starts fixed host SSH for the configured repository and relays framed streams;
- `git.receivePack` relays and records GitHub's advertised capabilities, buffers the complete pre-pack request including push options, validates policy and advertised capabilities, forwards accepted bytes unchanged, and rejects denied bytes before they reach GitHub;
- host SSH stderr is not exposed raw;
- the client cannot supply host, repository, SSH options, or remote command.

**Tests first:** socket-level API success/failure, chunked multi-frame API results, capability denial, repository injection, stdout/stderr framing, exit status, timeout, concurrency exhaustion counted at accept time, slow and partial initial-frame clients closed at deadline, cross-socket isolation, client disconnect, descendant cleanup, exact SSH argv, accepted feature updates, and denied main updates not reaching fake SSH stdin.

Run RED then GREEN:

```sh
go test ./internal/server -v
go test -race ./internal/server
```

## Task 7: Implement jailed clients and multicall command

**Files:** `internal/client/*` and `cmd/jailed-github-broker/main.go`.

Provide:

```text
jailed-github-broker serve --config PATH --socket PATH --ready-file PATH
gh <approved subset>
jailed-git-ssh <Git-generated SSH arguments>
```

The SSH shim accepts only Git's GitHub upload-pack/receive-pack invocation shapes for the configured repository. It rejects interactive mode, forwarding, arbitrary users/hosts/ports/options/commands, and mismatched repositories.

**Tests first:** typed RPC, local syntax rejection before connection, repository mismatch, server error propagation, jail-side JSON/JQ filtering, SSH invocation variants, raw stream behavior, and signal/disconnect handling.

Run RED then GREEN and format:

```sh
go test ./internal/client ./cmd/jailed-github-broker -v
gofmt -w $(find . -name '*.go' -type f)
go vet ./...
go test -race ./...
```

## Task 8: Package broker and add package-level behavior check

**Files:** package Nix files and `modules/checks/jailed-github-broker.nix`.

Use `buildGoModule` with no external modules and normal Go checks. Install the server binary plus jailed links named `gh` and `jailed-git-ssh`.

Start with the expected missing-package failure:

```sh
nix build .#packages.x86_64-linux.jailed-github-broker --no-link
```

Add fake host `gh` and `ssh` executables in the check and prove pinned argv, inherited fake host environment, no environment leakage, capability denial, default-main denial, stream multiplexing, unsupported-command rejection, and cancellation.

Run:

```sh
nix build .#packages.x86_64-linux.jailed-github-broker --no-link
nix build .#checks.x86_64-linux.jailed-github-broker --no-link
```

## Task 9: Add Nix normalization, lifecycle, and Home Manager wiring

**Files:** `nix/lib/jailed-github-broker.nix`, both jailed Pi modules, and `modules/checks/jailed-github-broker-wiring.nix`.

Write failing evaluation and generated-wrapper tests first for:

- disabled default preserving existing behavior;
- enabled broker requiring a valid repository;
- unknown capability rejection;
- `git:write` dependency;
- main denial and overrides;
- optional deletion/count policies, frame/response limits, initial-frame deadline, operation timeout, idle timeout, and concurrency limit;
- atomic private runtime directory;
- mode-`0600` socket verification;
- bounded readiness with live PID check;
- stable jail socket bind;
- jail-side `gh` and `GIT_SSH_COMMAND` wiring;
- broker process-group cleanup and jailed Pi exit-status preservation;
- absence of GitHub credentials, host GitHub config, SSH files, and `SSH_AUTH_SOCK` in generated jail wiring.

Run and observe RED:

```sh
nix build .#checks.x86_64-linux.jailed-github-broker-wiring --no-link
```

Implement `githubBroker ? { }` in `mkJailedPi`, a typed Home Manager submodule, generated non-secret JSON, outer lifecycle wrapper, and socket permission. Keep disabled output unchanged.

Run GREEN plus regressions:

```sh
nix build .#checks.x86_64-linux.jailed-github-broker-wiring --no-link
nix build .#checks.x86_64-linux.jailed-pi-auth-mode --no-link
nix build .#checks.x86_64-linux.jailed-pi-git-identity-wiring --no-link
nix build .#checks.x86_64-linux.jailed-pi-git-identity-home --no-link
```

## Task 10: Add a real-jail adversarial check

**File:** extend `modules/checks/jailed-github-broker-wiring.nix` or split a focused real-jail check before the module becomes too large.

Use fake host `gh` and `ssh` outside the jail and a controlled bare Git repository. Prove from an actual jail:

- supported brokered repository read succeeds;
- another repository and raw API fail;
- arbitrary host commands fail;
- clone/fetch through the SSH shim succeeds;
- a feature branch update reaches fake receive-pack;
- `refs/heads/main` update bytes never reach fake receive-pack;
- GitHub token variables and `SSH_AUTH_SOCK` are absent;
- host GitHub and SSH configuration are not visible;
- only the broker socket crosses the new boundary.

Run:

```sh
nix build .#checks.x86_64-linux.jailed-github-broker-wiring --no-link
```

## Task 11: Integrate `clubhouse_infra` locally

**Modify but never commit:** `/home/roche/projects/clubhouse/clubhouse_infra/devenv.nix`.

Configure:

```nix
githubBroker = {
  enable = true;
  repository = "alphaexplorationco/clubhouse_infra";
  capabilities = [
    "repository:read"
    "issues:read"
    "issues:write"
    "pull-requests:read"
    "pull-requests:write"
    "actions:read"
    "statuses:read"
    "git:read"
    "git:write"
  ];
  pushPolicy.denyRefs = [ "refs/heads/main" ];
};
```

Ensure the brokered `gh` client wins inside the jail. Do not add or forward `GH_TOKEN`, add credential helpers, or mount SSH authentication.

Apply the Testing Value Gate: this ignored project-local Nix wiring does not justify a static-content test. Verify directly:

```sh
cd /home/roche/projects/clubhouse/clubhouse_infra
nix-instantiate --parse devenv.nix >/dev/null
git check-ignore -q devenv.nix
git check-ignore -q .envrc
test -z "$(git ls-files -- devenv.nix .envrc)"
test "$(git remote get-url origin)" = \
  'git@github.com:alphaexplorationco/clubhouse_infra.git'
direnv exec . devenv shell -- true
```

Run a safe authenticated jail smoke check for supported read operations and `git fetch --dry-run`. Verify a main push is rejected locally by the broker using a dry-run or controlled fake target; do not mutate `main` on GitHub. Confirm credential variables and `SSH_AUTH_SOCK` are absent without printing environment values.

## Task 12: Final verification and adversarial review

Run:

```sh
cd /home/roche/projects/pi/roche-pi/.worktrees/jailed-gh-auth/packages/jailed-github-broker
gofmt -w $(find . -name '*.go' -type f)
go vet ./...
go test -race ./...

cd /home/roche/projects/pi/roche-pi/.worktrees/jailed-gh-auth
nix build .#checks.x86_64-linux.jailed-github-broker --no-link
nix build .#checks.x86_64-linux.jailed-github-broker-wiring --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
git diff --check
git status --short
```

Request a fresh adversarial `reviewer` pass with:

- implemented behavior summary;
- this plan and design;
- base and head SHAs;
- explicit focus on credential leakage, host/repository redirection, Git update-filter bypasses, socket races, cancellation, and jail escape surfaces.

Resolve Important or Critical findings with TDD and rerun the complete verification suite.

Review final scope to ensure no lock changes, dependency pins, `pi-intervals` edits, token references, host credential mounts, or committed `clubhouse_infra` local files are present.
