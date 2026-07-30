# Jailed GitHub Broker Design

## Status

Validated interactively on 2026-07-29.

This design replaces the earlier repository-token proposal. Jailed Pi receives no GitHub API token, GitHub CLI configuration, keyring access, SSH private key, or SSH agent socket.

## Problem

Jailed Pi needs to work with private GitHub repositories while retaining the existing host GitHub CLI and SSH authentication. It must support common repository, issue, pull-request, Actions, status, clone, fetch, and push workflows without exposing the host credentials to jailed processes.

A command wrapper alone is not a security boundary if the jail receives the underlying token or SSH agent. Conversely, executing host `gh` or Git directly against a jail-controlled checkout lets hostile repository configuration, hooks, filters, attributes, object paths, or filesystem links influence a credential-bearing host process.

## Goals

- Keep host GitHub CLI and SSH credentials outside the jail.
- Reuse host `gh` authentication exactly as configured by the operator.
- Reuse host SSH authentication without mounting `SSH_AUTH_SOCK` into the jail.
- Pin each broker instance to one configured `owner/repository`.
- Expose a configurable, typed subset of GitHub CLI operations.
- Let jailed Git exclusively own and update its `.git` directory and working tree.
- Preserve normal Git SSH clone, fetch, pull, and push behavior through an authenticated transport bridge.
- Permit all Git ref updates GitHub accepts by default except `refs/heads/main`.
- Allow projects to add or remove explicit ref denials without changing broker code.
- Provide automated behavioral and adversarial tests for the credential and repository boundaries.

## Non-goals

- Reducing the privileges of the credential already used by host `gh` or host SSH.
- Preventing anonymous outbound HTTPS access from the jail.
- Protecting against another malicious process already running as the same host user.
- Exposing arbitrary `gh api`, GraphQL, HTTP methods, URLs, headers, aliases, or extensions.
- Exposing a generic SSH proxy or interactive SSH shell.
- Enforcing commit-graph policies such as fast-forward-only updates. GitHub rulesets and branch protection remain authoritative for ancestry-sensitive policies.
- Supporting multiple repositories through one broker instance. Projects instantiate the reusable broker separately.

## Threat model

The jailed process may be compromised and may craft arbitrary socket requests, Git protocol bytes, command arguments, repository files, `.git` metadata, hooks, filters, symlinks, and network requests.

The host environment is trusted. In particular, the broker may assume that host `gh` and host SSH are already authenticated and correctly configured. The broker does not inspect, normalize, preflight, retrieve, or modify that authentication or its environment. It still pins `github.com` and the configured repository in every constructed host command so ambient `GH_HOST` or `GH_REPO` values cannot redirect broker authority.

A compromised jail may exercise every enabled broker capability against the configured repository. It must not be able to:

- obtain a reusable API or SSH credential;
- select another repository or GitHub host;
- execute arbitrary host `gh`, `ssh`, Git, or shell commands;
- make arbitrary authenticated HTTP or GraphQL requests;
- make the host open the jail-controlled checkout as a Git repository;
- update a ref explicitly denied by broker policy.

## Architecture

```text
host environment
  ├── authenticated gh + credential store
  ├── authenticated ssh + SSH agent/key configuration
  └── per-invocation broker
        ▲                    ▲
        │ typed RPC          │ framed Git transport
        │                    │
Unix socket bind-mounted into jailed Pi
        │                    │
        ▼                    ▼
  jailed gh client      jailed SSH shim
                              ▲
                              │ standard Git wire protocol
                              ▼
                         jailed Git
                    owns .git and worktree
```

The outer jailed-Pi launcher creates a private runtime directory and starts one broker process before entering the sandbox. Only the broker socket and non-secret client configuration are mounted or forwarded into the jail.

When jailed Pi exits, the launcher terminates the broker and removes the runtime directory. Authentication failures from host `gh` or SSH are returned as ordinary operation failures; the launcher performs no authentication preflight.

## Configuration

`mkJailedPi` gains an optional `githubBroker` argument. Home Manager exposes the same structure.

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

  pushPolicy = {
    denyRefs = [ "refs/heads/main" ];
    denyDeletes = false;
    maxRefUpdates = null;
  };

  limits = {
    maxConcurrentRequests = 8;
    maxControlBytes = 1048576;
    maxStreamFrameBytes = 65536;
    maxPushPrefixBytes = 1048576;
    initialFrameTimeoutSeconds = 5;
    operationTimeoutSeconds = 600;
    idleStreamTimeoutSeconds = 120;
  };
};
```

Defaults:

- `enable = false`;
- `repository` is required when enabled and must be a literal GitHub `owner/repository` slug;
- `capabilities = [ ]`;
- `pushPolicy.denyRefs = [ "refs/heads/main" ]`;
- `pushPolicy.denyDeletes = false`;
- `pushPolicy.maxRefUpdates = null`.
- `limits.maxConcurrentRequests = 8`;
- `limits.maxControlBytes = 1048576`;
- `limits.maxStreamFrameBytes = 65536`;
- `limits.maxPushPrefixBytes = 1048576`;
- `limits.initialFrameTimeoutSeconds = 5`;
- `limits.operationTimeoutSeconds = 600`;
- `limits.idleStreamTimeoutSeconds = 120`.

Enabling `git:write` permits every syntactically valid ref update GitHub accepts except explicit policy denials. Projects can set `denyRefs = [ ]` to allow `main`, or list additional exact refs. Tags, force pushes, deletions, and multi-ref pushes are otherwise permitted. An optional deletion or update-count policy is syntactic and requires no local object mirror.

The generated broker configuration contains no secret and may live in the Nix store.

## Broker lifecycle and socket mount

The host launcher:

1. atomically creates a unique mode-`0700` temporary directory beneath the host runtime directory or `/tmp`;
2. starts the broker with a Unix socket inside that directory and the generated non-secret configuration;
3. waits for an explicit ready marker inside that host-only directory with a bounded timeout, while checking that the expected broker PID remains alive;
4. verifies that the socket is owned by the current user and has mode `0600`;
5. bind-mounts the socket into the jail at a stable path;
6. forwards only the stable socket path, configured repository slug, and jail-side Git transport command;
7. forwards signals and preserves the jailed Pi exit status;
8. terminates and reaps the broker process group and removes the runtime directory on every exit path.

The broker inherits the host environment normally. The jail does not receive host `gh` configuration, keyring state, GitHub authentication environment variables by virtue of the broker, `SSH_AUTH_SOCK`, or SSH files.

## Protocol

Use a versioned, length-prefixed protocol over Unix stream sockets. One connection carries one logical request. Frames have bounded size and one of these roles:

- control request or response;
- stdin bytes;
- stdout bytes;
- stderr bytes;
- end-of-input;
- process exit;
- structured error.

Control requests contain a protocol version, request ID, operation enum, and strictly validated arguments. The repository and host are absent from authoritative request data; the broker reads them from its host-side configuration. Unknown fields, operations, protocol versions, duplicate or trailing JSON values, and oversized frames fail closed.

The first frame must be one control request completed within the initial-frame deadline. Every accepted request receives one bounded control response describing the result stream. API requests permit no client stream frames; the server then sends zero or more bounded stdout-data frames followed by exactly one exit frame. This chunking carries normalized JSON, diffs, or logs larger than the control-frame limit without an unbounded allocation. Git requests receive one acceptance response and then enter a full-duplex stream state: client frames may contain stdin bytes followed by exactly one end-of-input; server frames may contain stdout or stderr bytes followed by exactly one exit frame. Structured errors replace the acceptance response when no stream begins. Frames after terminal state, duplicate end/exit frames, mismatched request IDs, or invalid direction fail closed and cancel the host process.

Git sessions switch to framed full-duplex byte transport after the broker accepts a typed `git.uploadPack` or `git.receivePack` request. Multiplexing preserves separate stdout and stderr streams while allowing the broker to inspect push update commands.

## GitHub CLI subset

A jail-side executable named `gh` parses a supported command subset and sends typed requests. The broker maps those operations to fixed host `gh api --hostname github.com` invocations in a private working directory, with the host command's normal environment and authentication. It closes host stdin, supplies request bodies as bounded data, captures stdout, and never returns or logs raw host stderr. Failures return the exit status plus a generic operation message.

Initial operations:

- repository view;
- issue list, view, create, edit, and comment;
- pull request list, view, create, edit, comment, diff, and checks;
- Actions run list and view, including read-only log retrieval;
- commit status reads.

The normative RPC surface is:

| Operation | Capability | Accepted arguments |
| --- | --- | --- |
| `repository.get` | `repository:read` | none |
| `issues.list` | `issues:read` | state enum; positive limit up to 100 |
| `issues.get` | `issues:read` | positive issue number |
| `issues.create` | `issues:write` | title 1-256 bytes; body up to 65,536 bytes |
| `issues.update` | `issues:write` | positive issue number; optional bounded title/body; optional open/closed state |
| `issues.comment` | `issues:write` | positive issue number; body 1-65,536 bytes |
| `pullRequests.list` | `pull-requests:read` | state enum; optional bounded base/head names; positive limit up to 100 |
| `pullRequests.get` | `pull-requests:read` | positive pull-request number |
| `pullRequests.create` | `pull-requests:write` | bounded head/base names; title 1-256 bytes; body up to 65,536 bytes; draft boolean |
| `pullRequests.update` | `pull-requests:write` | positive number; optional bounded title/body/base; optional open/closed state |
| `pullRequests.comment` | `pull-requests:write` | positive number; body 1-65,536 bytes |
| `pullRequests.diff` | `pull-requests:read` | positive pull-request number |
| `pullRequests.checks` | `pull-requests:read` and `statuses:read` | positive pull-request number |
| `actions.runs.list` | `actions:read` | optional bounded branch/status; positive limit up to 100 |
| `actions.runs.get` | `actions:read` | positive run ID |
| `actions.runs.logs` | `actions:read` | positive run ID; bounded output |
| `statuses.get` | `statuses:read` | 40- or 64-character hexadecimal commit object ID |
| `git.uploadPack` | `git:read` | no authoritative repository or host argument |
| `git.receivePack` | `git:write` and `git:read` | no authoritative repository or host argument |

Each operation maps to one fixed REST endpoint, method, request schema, response schema, and allowlisted response-field set. Numeric identifiers cannot be URLs. Branch names and text are data only. Host argv never contains client-supplied paths, templates, editor/browser flags, project mutations, recovery files, endpoints, methods, headers, or output programs.

All REST calls use `gh api --hostname github.com`, API version `2022-11-28`, and `Accept: application/vnd.github+json` unless the table specifies another media type. GET query parameters are individually encoded from validated enum, number, or bounded branch values. JSON write bodies are generated by the broker and supplied on stdin with `--input -`; read operations receive closed stdin. The broker normalizes GitHub responses to the following fixed wire schemas and discards every unlisted field:

| Operation | Method and fixed endpoint | Request encoding | Normalized response and limit |
| --- | --- | --- | --- |
| `repository.get` | GET `/repos/{owner}/{repo}` | none | repository name, owner, name-with-owner, description, privacy, URL, and default branch; 1 MiB raw |
| `issues.list` | GET `/search/issues` with a server-constructed `repo:{owner}/{repo} is:issue` query | optional validated state term, `per_page` | array of number, title, state, author login, assignee logins, labels, URL, created/updated times; 8 MiB raw |
| `issues.get` | GET `/repos/{owner}/{repo}/issues/{number}` | none; reject a response containing `pull_request` | number, title, body, state, author login, assignee logins, labels, URL, created/updated times; 2 MiB raw |
| `issues.create` | POST `/repos/{owner}/{repo}/issues` | JSON title/body | normalized issue object above; 2 MiB raw |
| `issues.update` | preflight GET `/repos/{owner}/{repo}/issues/{number}`, reject `pull_request`, then PATCH the same endpoint | JSON containing only supplied title/body/state | normalized issue object above; 4 MiB aggregate raw |
| `issues.comment` | preflight GET `/repos/{owner}/{repo}/issues/{number}`, reject `pull_request`, then POST `/repos/{owner}/{repo}/issues/{number}/comments` | JSON body | comment ID, author login, body, URL, created/updated times; 4 MiB aggregate raw |
| `pullRequests.list` | GET `/repos/{owner}/{repo}/pulls` | `state`, optional `base`/`head`, `per_page` | array of number, title, body, state, draft, author login, head/base ref names, head object ID, URL, created/updated times; 8 MiB raw |
| `pullRequests.get` | GET `/repos/{owner}/{repo}/pulls/{number}` | none | pull-request fields above plus mergeable state; 2 MiB raw |
| `pullRequests.create` | POST `/repos/{owner}/{repo}/pulls` | JSON title/head/base/body/draft | normalized pull-request object; 2 MiB raw |
| `pullRequests.update` | PATCH `/repos/{owner}/{repo}/pulls/{number}` | JSON containing only supplied title/body/base/state | normalized pull-request object; 2 MiB raw |
| `pullRequests.comment` | preflight GET `/repos/{owner}/{repo}/pulls/{number}`, then POST `/repos/{owner}/{repo}/issues/{number}/comments` | JSON body | normalized comment object; 4 MiB aggregate raw |
| `pullRequests.diff` | GET `/repos/{owner}/{repo}/pulls/{number}` | `Accept: application/vnd.github.diff` | UTF-8 diff bytes only; 8 MiB |
| `pullRequests.checks` | GET pull request, then GET `/repos/{owner}/{repo}/commits/{head_sha}/check-runs` and GET `/repos/{owner}/{repo}/commits/{head_sha}/status` | object ID comes only from the normalized first response | array of check/status name, state/conclusion, details URL, description, and start/completion times; 8 MiB combined raw |
| `actions.runs.list` | GET `/repos/{owner}/{repo}/actions/runs` | optional `branch`/`status`, `per_page` | array of run ID, name, workflow name, status, conclusion, event, head branch/object ID, URL, created/updated times; 8 MiB raw |
| `actions.runs.get` | GET `/repos/{owner}/{repo}/actions/runs/{run_id}` | none | normalized run object above plus attempt number and jobs URL; 2 MiB raw |
| `actions.runs.logs` | fixed `gh run view --repo github.com/{owner}/{repo} --log {run_id}` | positive run ID only; closed stdin | UTF-8 log bytes; 32 MiB; no raw stderr |
| `statuses.get` | GET `/repos/{owner}/{repo}/commits/{object_id}/status` | validated hexadecimal object ID | overall state/object ID and array of context, state, description, target URL, created/updated times; 8 MiB raw |

The client exposes only operation-specific names from these normalized schemas through `--json`. No raw GitHub response object crosses the socket. Multi-call operations stop on the first failure and return no partial raw response. Because GitHub models pull requests through parts of the Issues API, every issue mutation preflights and rejects a response containing `pull_request`, while every pull-request comment preflights the pull endpoint. A failed or mismatched type preflight prevents the mutation request entirely.

List operations request at most 100 results and use one page sized to the validated limit. Check-runs and combined statuses paginate with explicit `page` and `per_page=100`, stopping at the advertised end, 10 pages, 1,000 normalized records, or the aggregate byte limit. Reaching a page, record, or byte bound while GitHub still advertises another page returns an explicit result-too-large error and no partial response. Tests cover exact page boundaries, empty intermediate/final pages, and over-limit responses.

Capabilities independently enable read and write groups. Every write operation requires complete non-interactive input; the host command never opens an editor or browser.

`--repo` may be omitted, exactly match the configured repository, or exactly match `github.com/owner/repository`. Any other repository fails in both the client and server. Output-selection flags select only fields present in the operation's fixed response schema. Supported `--jq` expressions execute against returned data in the jail, not as host commands.

Unsupported commands include:

- `gh auth` and credential helpers;
- arbitrary `gh api` or GraphQL;
- aliases and extensions;
- repository creation, deletion, transfer, settings, or administration;
- pull-request merge;
- workflow dispatch, rerun, cancellation, or mutation;
- release mutation.

For operations such as pull-request checkout, the jail-side client obtains typed metadata from the broker and then invokes jailed Git. Host `gh` never opens the jail checkout.

## Git SSH transport

The jailed environment sets `GIT_SSH_COMMAND` to a broker client shim. Jailed Git continues to use normal SSH remote URLs.

The shim accepts only the invocation forms Git uses for GitHub `git-upload-pack` and `git-receive-pack`. It opens the Unix socket and requests one of those typed services. It does not implement an interactive shell, port forwarding, arbitrary hosts, or arbitrary remote commands.

The host broker constructs a fixed SSH invocation for:

```text
git@github.com git-upload-pack 'owner/repository.git'
git@github.com git-receive-pack 'owner/repository.git'
```

The owner and repository come only from validated host configuration. The broker invokes SSH directly without a local shell and relays the Git wire protocol. Host Git is not involved and no host process opens the jailed repository.

For receive-pack sessions, GitHub's ref advertisement reaches the jail before the broker can see requested updates. The broker records the advertised capability list while relaying that advertisement. It then parses and buffers the complete pre-pack request, including any push options, before forwarding any update-command byte to GitHub. Parsing follows Git's documented `update-requests = *shallow (command-list | push-cert)` grammar. It accepts bounded, unique `shallow <object-id>` declarations and both ordinary command lists and complete signed push certificates. For certificates it validates every embedded create/update/delete command while preserving certificate bytes unchanged for GitHub's signature and nonce verification. It also accepts bounded push-option pkt-lines only when the server advertisement offered that capability.

The fail-closed pkt-line state machine tolerates arbitrary socket fragmentation but rejects malformed lengths, truncation, duplicate refs or shallow declarations, inconsistent 40/64-character hexadecimal object IDs, invalid or non-UTF-8 ref names, missing first-command capability separators, malformed certificate headers/signatures/terminators, unadvertised capabilities or push options, ambiguous flush boundaries, and input beyond the configured prefix limit. It rejects:

- exact refs listed in `pushPolicy.denyRefs`, including `refs/heads/main` by default;
- deletions when `denyDeletes = true`;
- more updates than `maxRefUpdates` when configured;
- malformed or ambiguous command formats that cannot be validated confidently.

After validation, the broker forwards the buffered bytes unchanged and relays the remainder of the protocol. GitHub remains authoritative for repository permissions, branch protection, rulesets, signature and nonce verification, object validation, and non-fast-forward behavior. `git:write` depends on `git:read` because receive-pack necessarily discloses the repository's ref advertisement.

## Error handling and auditing

- Startup failures explain whether socket creation, broker readiness, or sandbox launch failed without exposing credentials.
- Unsupported `gh` commands and capabilities fail before invoking host tools.
- Host `gh` and SSH exit codes are propagated, but raw host stderr is neither returned nor logged because the inherited host environment may enable credential-bearing diagnostics. The broker returns fixed operation-specific failure text. SSH transport stderr is reduced to bounded, allowlisted connection diagnostics that contain no environment or command data.
- Client disconnects cancel associated host subprocesses.
- Timeouts and byte limits terminate stalled or oversized operations.
- Accepted sockets count against the configured global concurrency limit before any frame is read. Excess sockets are rejected immediately, and partial initial headers are closed at the initial-frame deadline before they can retain descriptors or goroutines.
- Host subprocesses run in separate process groups; cancellation kills and reaps the entire group.
- Logs record operation, escaped request ID, configured repository, duration, exit status, validated and escaped ref names, and byte counts.
- Logs never record issue bodies, pull-request bodies, Git pack contents, authorization material, host environment values, or command traces containing secrets.

## Implementation shape

Implement the broker and clients as one small Go module using the standard library. A multicall binary provides host `serve`, jailed `gh`, and jailed SSH-shim modes. Go provides bounded binary framing, Unix sockets, full-duplex subprocess streaming, cancellation, and focused unit tests without runtime dependencies.

Keep protocol, policy, Git parsing, GitHub command mapping, server lifecycle, and client parsing in separate focused modules. Nix packages the binary and generates the non-secret configuration and jail wrappers.

## Verification

Automated tests must prove behavior rather than static text:

1. configuration validation and default-main denial;
2. strict frame decoding, limits, unknown-field rejection, stream multiplexing, and chunked API results above control/frame boundaries;
3. bounded API pagination with exact-page, final-page, and over-limit behavior and no partial results;
4. Git receive-pack command parsing and rejection of `refs/heads/main`;
5. optional deletion and update-count denials;
6. allowed feature branches, tags, force-shaped updates, shallow updates, signed updates, and multi-ref updates under default policy;
7. supported and unsupported `gh` grammar;
8. server-side repository pinning and capability checks;
9. fixed host `gh` and SSH argv using fake executables;
10. inherited host authentication environment, including hostile `GH_HOST`, `GH_REPO`, and debug values, without redirecting the fixed host/repository or exposing environment data in responses;
11. client disconnect and subprocess cancellation;
12. complete process-group cleanup, accept-time concurrent-session limits, slow initial-frame deadlines, and cross-project socket isolation;
13. generated jail wiring that mounts only the broker socket and forwards neither GitHub credentials nor `SSH_AUTH_SOCK`;
14. a real jail test with fake host `gh` and SSH proving that jailed clients can use the broker but cannot select another repository or invoke arbitrary host commands.

Direct verification must additionally run:

```sh
go test ./...
nix build .#checks.x86_64-linux.jailed-github-broker --no-link
nix build .#checks.x86_64-linux.jailed-github-broker-wiring --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

The project-specific smoke check must confirm that `clubhouse_infra` keeps its SSH origin, does not export or forward a GitHub token for this feature, can perform authenticated read operations through the jailed `gh` client, can fetch through brokered SSH, rejects `main` update-command bytes before forwarding them to GitHub, and leaves its ignored `.envrc` and `devenv.nix` untracked.

## Security properties and limitations

The broker is a narrow capability boundary around broad host authentication; it does not reduce that authentication's underlying scope. Its safety depends on strict operation parsing, fixed host commands, fixed repository configuration, and never exposing a generic authenticated transport.

A compromised jail can read and modify all data authorized by enabled capabilities in the configured repository, except explicit broker denials. It can still access GitHub anonymously over the jail's normal network. GitHub and Git parser vulnerabilities remain relevant, so the broker and host tools must stay updated and all protocol inputs require resource limits.
