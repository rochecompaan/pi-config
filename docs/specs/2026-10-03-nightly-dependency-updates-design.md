# Nightly dependency updates

## Goal and approved scope

One Forgejo workflow updates flake inputs, extensions, and upstream skill bundles each night.
Each update unit has a separate pull request (PR).
A maintainer merges each PR manually.

The workflow does not merge PRs or commit directly to `main`.
It does not change the selected Nix release channels.
It does not repair upstream code or remove local compatibility patches to make an update pass.

## Schedule and job isolation

The workflow runs at 03:00 UTC each day and supports manual dispatch.
It reads the committed default branch, not changes in another local checkout.
Each update job starts from the same base commit in a separate checkout.
One failed job does not stop other update jobs.
A concurrency limit prevents excessive parallel Nix builds.
Overlapping runs cannot publish competing updates for the same unit.

## PR units

| Unit | Contents |
| --- | --- |
| Flake inputs | One PR for changes to `flake.lock`, including transitive input locks |
| Extension | One PR per extension, with its source revision, source hash, package version, and dependency hashes or lockfiles |
| Skill bundle | One PR per upstream source, such as Superpowers, SimpleEnglish, or the Matt Pocock skills |
| Coupled dependencies | The consuming extension and its required helper sources share one PR |

Examples of coupled dependencies include the CodeGraph wrapper and native binary, and the Listen extension and its Sherpa runtime.
Shared extension dependencies can have their own update unit to avoid duplicate edits in competing PRs.
The dependency inventory names every managed source and its owning update unit.
The inventory excludes unrelated local code and skills that this repository maintains directly.

## Update methods

Flake updates use `nix flake update` and retain the URLs in `flake.nix`.
Tagged Git sources use the latest stable release tag.
Npm sources use the stable release from the upstream registry.
Commit-pinned sources retain their commit-based policy and follow the upstream default branch.
Each update retains a fixed source revision and the correct Nix source hash.

Extension updates also refresh each affected dependency hash and repository-maintained lockfile.
Nix evaluates or builds the affected package to obtain and verify these hashes.
An update never publishes a fake hash or a version change without its matching source hash.
Existing Nix update tools can supply this work where they support the package structure.
Small repository-specific adapters handle the remaining source and lockfile formats.

## Validation and errors

Every changed candidate must pass these commands before publication:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

A package-specific build also verifies dependency hashes that the flake checks do not exercise.
The workflow reports upstream lookup errors, hash errors, build errors, and publication errors separately.
A failed candidate produces diagnostic output but does not publish a new branch or update an existing PR.
A candidate without changes creates no commit or PR.
An unsupported source or missing inventory entry is an error, not a silently skipped dependency.

## Publication and credentials

Each unit has one stable bot branch and at most one open PR against the default branch.
The workflow refreshes the same branch and PR on later runs.
The workflow limits branch updates to its documented bot branch prefix.
It uses a lease when it replaces an existing bot branch to detect concurrent changes.
It never rewrites an unrelated branch.

The publication step receives a repository-scoped Forgejo token through a secret.
Update and validation steps do not receive this publication token.
Checkout credentials do not remain in Git configuration.
The token needs permission to push bot branches and create or update PRs.
The token does not need permission to merge PRs.

## Runner requirements

The jobs require an `x86_64-linux` runner with Nix and network access to the upstream sources and configured binary caches.
The runner label and token secret name are documented deployment requirements.
Repository and user runner queries returned no runners during design.
An inherited instance runner can still exist, so runner availability requires a deployment check.
No runner registration or secret creation is part of this repository change.

## Verification of the automation

The workflow YAML receives syntax and workflow validation rather than tests of static text.
Reusable updater logic receives automated tests for version selection, precise edits, hash handling, and failure isolation.
Publication logic receives tests for no-change runs, PR reuse, concurrent branch changes, and API errors.
Tests use temporary repositories and mocked upstream responses instead of production credentials.
A local dry run demonstrates source discovery and at least one representative update from each source format.
Full flake and extension-load checks verify the final repository changes.
A live scheduled run remains a deployment check after the workflow reaches the server and its runner and secret are available.
