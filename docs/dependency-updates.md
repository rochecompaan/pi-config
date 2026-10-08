# Nightly dependency updates

## Behavior

The workflow `.forgejo/workflows/nightly-dependency-updates.yml` runs each day at **03:00 UTC**.
It also supports manual dispatch on the default branch.
It creates separate pull requests (PRs) for dependency updates.
A maintainer reviews and merges each PR manually.
The workflow never merges PRs or commits to the default branch.

Discovery reads the committed default branch and records one base commit.
Each matrix job uses that exact commit in its own checkout.
At most two update jobs run at once.
A failed job does not cancel other update jobs.
Workflow and unit concurrency groups limit overlapping runs.
Git leases provide the final guard against competing branch updates.

Each changed candidate must pass its package builds, the runtime extension-load check, and the full flake check.
The flake-input unit builds every package output, including packages outside the flake checks.
Validation runs with Nix sandboxing disabled to match the container runner setup.
Publication uses the validated Git tree without new staging.

## Deployment requirements

This branch does not register a runner or create a secret.
The live deployment check remains separate from local verification.

### Runner

Use an **x86_64-linux** Forgejo runner with these resources:

- The label `ubuntu-latest`, or the label from repository variable `DEPENDENCY_UPDATE_RUNNER`.
- A root job environment with writable `/nix` and `/etc/nix` directories, plus `groupadd` and `useradd`.
- Bash, Git, Python 3, and a JavaScript runtime compatible with the pinned checkout action.
- Network access to Forgejo, GitHub, the npm registry, and the configured Nix caches.
- Enough disk space and time for native npm packages and full flake checks.

Both jobs use `.forgejo/actions/setup-nix` to install Nix 2.35.1 with the pinned Cachix install action from v31.
The action reuses a complete persistent Nix installation and refuses an incomplete installation.
It enables flakes and sets `sandbox = false` on both new and existing installations.
It creates 16 unprivileged build users and sets `build-users-group = nixbld`.
The Nix client runs as root, but builders must not: Go telemetry can otherwise create `/homeless-shelter`, which makes later non-sandboxed builds fail.
The workflow builds `packages.x86_64-linux.dependency-update-tools` before it changes any pins.
That immutable package supplies Python, Node/npm, Git, Nix, prefetch tools, and workflow lint tools.
The build result and candidate reports stay in the runner temporary directory, outside the checkout.
Each job has a 90-minute timeout.

Prefer disposable job environments and a runner without unrelated credentials.
Package builds can access the job environment because Nix sandboxing is disabled.
The runner environment provides isolation, not Nix.

### Publication account, token, and username

1. Choose the account that will publish updates. You can use your account or a separate bot account.
2. Give the publication account write access to this repository.
3. For a bot account, limit its write access to this repository only.
4. Create a token with **Specific repositories**. Select only this repository.
5. Grant **Repository: Read and Write** (`write:repository`). Leave other scopes disabled.
6. Store the token as the repository secret `DEPENDENCY_UPDATE_TOKEN`.
7. Set the repository Actions variable `DEPENDENCY_UPDATE_BOT_USERNAME` to the username of the account that created the token.
8. Protect the default branch against direct updater pushes.
9. Require maintainer review and successful checks before a merge.

The username variable identifies the token owner, not a separate account.
For example, a token created by `roche` requires `DEPENDENCY_UPDATE_BOT_USERNAME=roche`.
The updater uses the repository permissions API to resolve that account and verify write access before publication.
Selected-repository tokens permit this lookup only for their owner.
The updater does not call `/user` or require `read:user`.
Existing branch and PR ownership checks use the account ID and canonical username from Forgejo.

Forgejo repository-write access can also permit merges.
The updater never calls a merge endpoint, regardless of those rights.
Do not rely on a GitHub-style `permissions` block to restrict a Forgejo personal token.

The automatic checkout token is distinct from `DEPENDENCY_UPDATE_TOKEN`.
Both checkout steps use `persist-credentials: false`.
Only the final publication step receives the publication token.
Preparation, npm lock generation, and Nix builds do not receive that token.
The updater uses a temporary private Git authentication helper and removes it after publication.
It does not store the token in a URL, command argument, or Git configuration.

The Forgejo API requires HTTPS and refuses redirects.
The Git origin must match the configured Forgejo repository.
Checkout and publication use `https://git.compaan.cloud`, not the runner's internal service URL.
For another deployment, set `DEPENDENCY_UPDATE_SERVER_URL` to its trusted public HTTPS origin.
The workflow passes this origin to the checkout action's `github-server-url` input.
Both checkout steps and publication use the same origin.
The runner must reach that origin and trust its TLS certificate.

## Update units

The inventory defines **16 units** that cover **19 fixed source pins**, plus all flake inputs.
Coupled sources share a PR.
The catalog is `maintenance/dependency_updates/catalog.json`.
The pins are `nix/dependency-pins.json`.

| Unit | Sources |
| --- | --- |
| `flake-inputs` | All inputs in `flake.lock`, including transitive locks |
| `codegraph` | Pi CodeGraph wrapper, CodeGraph package, Linux native binary |
| `context-mode` | Context-mode package |
| `diff-package` | Shared diff package |
| `mattpocock-skills` | Matt Pocock skill bundle |
| `pi-claude-bridge` | Claude bridge extension |
| `pi-context-paging` | Context paging extension |
| `pi-intervals` | Intervals extension |
| `pi-listen` | Listen extension, Sherpa package, Sherpa Linux binary |
| `pi-loadout` | Loadout extension |
| `pi-remote` | Pi remote package |
| `pi-subagents` | Subagents extension |
| `pi-vim` | Vim extension |
| `remote-pi-extension` | Remote Pi extension |
| `simple-english` | Simple English skill bundle |
| `superpowers` | Superpowers skill bundle |

Tagged Git sources use the latest stable tag.
Npm sources use the stable registry release.
Commit-based sources follow the upstream default branch and retain an exact commit pin.
Source hashes retain each Nix fetcher's unpacking and submodule policy.
Affected npm locks and cache hashes change with their consuming source.
Unchanged sources do not regenerate npm locks.
Local compatibility behavior remains intact.
The bridge uses the upstream lock's exact versions and restores missing integrity from matching npm registry metadata.
The repaired lock stays in the unit's owned files and supplies the Nix package build.
The repair never runs npm lifecycle scripts.

The bot branch for each unit is `automation/dependencies/UNIT`.
Publication creates one open PR or reuses the existing bot PR.
A matching tree and base reuse the existing commit.
The updater refuses human-owned branches, mismatched PR authors, forks, and duplicate PR matches.
It checks the remote default and bot heads again before PR edits.
A failed lease stops publication without a retry.

CAUTION: Do not add human commits to branches under `automation/dependencies/`.
The updater can replace an owned bot branch after validation.
Use a separate branch for manual changes.

## Local use

### Inventory and behavior tests

Run these commands from the repository root:

```sh
nix build .#packages.x86_64-linux.dependency-update-tools \
  --out-link /tmp/nightly-dependency-tools
export PATH="/tmp/nightly-dependency-tools/bin:$PATH"
python3 -m maintenance.dependency_updates list
python3 -m maintenance.dependency_updates audit
python3 -m unittest discover -s maintenance/tests -p 'test_dependency_*.py' -v
```

Unknown, unmarked, or unsupported sources fail `audit`.
They do not disappear from the schedule.
Source-policy changes require maintainer review.

### Dry preparation

Use a clean, committed feature branch for a dry preparation:

```sh
base="$(git rev-parse HEAD)"
python3 -m maintenance.dependency_updates prepare superpowers \
  --base main --base-sha "$base" \
  --report /tmp/dependency-superpowers.json --dry-run
```

A dry preparation uses a temporary clone and never publishes.
It performs real upstream lookup, source prefetch, and affected lock/hash generation.
It does not validate package builds.
The temporary clone is removed after preparation, so its report cannot support later validation or publication.

### Candidate validation

Use a disposable worktree at the committed base for preparation and validation:

```sh
base="$(git rev-parse HEAD)"
python3 -m maintenance.dependency_updates prepare pi-vim \
  --base main --base-sha "$base" --report /tmp/dependency-pi-vim.json
python3 -m maintenance.dependency_updates validate --report /tmp/dependency-pi-vim.json
```

Preparation requires a clean checkout.
The report must stay outside the checkout.
Validation refuses a changed base, index tree, tracked file, or untracked file.
A no-change report needs no builds and creates no commit or PR.

These local commands do not publish.
Publication also requires the remote default branch to equal the report's base commit.
A local feature commit is not a valid publication base unless it is the current remote default head.

## Errors and recovery

The always-run diagnostic step shows the unit, report location, changed state, validation state, and error stage.
The report also contains the exact base and candidate tree when preparation succeeds.
Failed jobs retain their failure status.

| Stage | Meaning | Operator action |
| --- | --- | --- |
| `inventory` | Unsupported source, invalid catalog, or invalid report | Review the source policy or report |
| `lookup` | Upstream release or commit lookup failed | Read the upstream error and retry later |
| `source-hash` | Prefetch failed or fetched package metadata differed | Review the upstream artifact and source policy |
| `lockfile` | Lock generation, metadata validation, or patch application failed | Review the upstream dependencies and local patch |
| `npm-hash` | Npm cache prefetch failed or returned an invalid hash | Review the dependency downloads |
| `preparation` | Checkout or ownership guard failed | Start from a clean base and prepare again |
| `validation` | Package, extension-load, or flake check failed | Read the build logs and repair the cause |
| `publication` | Missing token, stale base, lease conflict, ownership conflict, or API error | Review the remote state and prepare again |

A failed preparation or validation leaves an existing PR unchanged.
An API error after a successful push can leave an owned bot branch without a PR.
The next run can reuse that branch after the ownership checks.
A remote-head race after the push can also leave a branch without a PR edit.
Git pushes and Forgejo PR edits are separate operations, not one atomic transaction.

If a compatibility patch fails, report the upstream change.
Do not remove the patch to make the update pass.
If the Intervals extension breaks, repair it in `~/projects/pi/extensions/pi-intervals` before another revision update.

## Live deployment check

The local checks do not prove runner or action compatibility.
Forgejo 16 documents schedule, dispatch, matrix, contexts, and workflow concurrency support.
Concurrency is best-effort, so publication also uses exact Git leases and remote-head checks.
The deployed runner still needs a live check for job concurrency and matrix limits.

After integration and runner/secret configuration, obtain operator approval before dispatch:

1. Manually dispatch the workflow on the default branch.
2. Verify the pinned checkout action and default-branch event metadata.
3. Verify the Nix installation, disabled sandbox, and immutable tool build.
4. Verify independent matrix jobs and the two-job limit.
5. Verify that a failed unit does not cancel other units.
6. Verify no-change behavior and validated bot PR publication.
7. Dispatch again and verify PR and branch reuse.
8. Verify that no PR merges automatically.
9. Observe the next scheduled run at 03:00 UTC.

Do not create runners, secrets, pushes, or dispatches without separate approval.
