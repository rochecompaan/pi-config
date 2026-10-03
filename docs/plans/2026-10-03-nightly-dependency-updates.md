# Nightly Dependency Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for direct execution. Use superpowers:subagent-driven-development only if the operator authorizes delegation. Execute task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one nightly Forgejo workflow that updates flake inputs, extensions, and upstream skill bundles through separate, validated PRs.

**Architecture:** Move existing pin values into one JSON file without changing the Nix package recipes. A small Python updater resolves upstream versions, refreshes source and npm hashes, and prepares one candidate per update unit. Independent matrix jobs validate candidates, then publish through a separate token-bearing step.

**Tech Stack:** Forgejo Actions, Nix, Python standard library and `unittest`, npm, `semver`, `nix-prefetch-git`, `nix-prefetch-url`, and `prefetch-npm-deps`. Use tools from the existing pinned nixpkgs input. Do not add a flake input, pip dependency, or npm project for the updater.

**Approved spec:** `docs/specs/2026-10-03-nightly-dependency-updates-design.md`.

## Global Constraints

- One Forgejo workflow updates flake inputs, extensions, and upstream skill bundles each night.
- Each update unit has a separate pull request (PR).
- A maintainer merges each PR manually.
- The workflow does not merge PRs or commit directly to `main`.
- The workflow runs at 03:00 UTC each day and supports manual dispatch.
- Each update job starts from the same base commit in a separate checkout.
- One failed job does not stop other update jobs.
- A concurrency limit prevents excessive parallel Nix builds.
- It does not change the selected Nix release channels.
- It does not repair upstream code or remove local compatibility patches to make an update pass.
- A failed candidate produces diagnostic output but does not publish a new branch or update an existing PR.
- A candidate without changes creates no commit or PR.
- An unsupported source or missing inventory entry is an error, not a silently skipped dependency.
- Update and validation steps do not receive this publication token.
- Checkout credentials do not remain in Git configuration.
- The jobs require an `x86_64-linux` runner with Nix and network access to the upstream sources and configured binary caches.
- No runner registration or secret creation is part of this repository change.

## Workspace and verified facts

- Worktree: `.worktrees/nightly-dependency-updates`.
- Branch: `ci/nightly-dependency-updates`.
- Implementation base: `2c5857c`. Spec commit: `ae90346`.
- Do not touch the dirty `flake.nix` and `flake.lock` in the main checkout.
- Another session plans wrapper retirement. It will avoid source pins. Coordinate any changes near `packagePaths` before integration.
- Forgejo is `16.0.4+gitea-1.22.0`. The repository default branch is `main`, and Actions are enabled.
- No repository or user runners appeared in the runner queries. An inherited runner remains possible.
- The pinned nixpkgs exposes `nix-prefetch-git`, `prefetch-npm-deps`, `nodePackages.semver`, and `nix-update`.
- Do not use `nix-update` as a blind text updater for `pi-deps.nix`. It contains multiple unrelated packages and several source formats.
- The Forgejo checkout `v4` tag resolved to `11d5960a326750d5838078e36cf38b85af677262` during planning. Pin that commit in the workflow.

## File responsibilities

| File | Responsibility |
| --- | --- |
| `nix/dependency-pins.json` | Existing versions, revisions, URLs, source hashes, and npm hashes |
| `nix/packages/pi-deps.nix` | Existing extension and skill recipes, now reading pin values |
| `nix/packages/pi-remote.nix` | Existing `@noahsaso/pi-remote` recipe, now reading pin values |
| `nix/packages/pi-intervals.nix` | Existing Intervals recipe, now reading pin values |
| `modules/packages/pi-deps.nix` | Expose missing direct build targets for managed sources |
| `modules/packages/dependency-update-tools.nix` | Package the updater's runtime and verification tools |
| `maintenance/__init__.py` | Python package boundary |
| `maintenance/dependency_updates/__init__.py` | Python package boundary |
| `maintenance/dependency_updates/model.py` | Shared records, inventory loading, and pin-file validation |
| `maintenance/dependency_updates/catalog.json` | Update units, upstream policies, companion rules, and owned paths |
| `maintenance/dependency_updates/sources.py` | Upstream selection and Nix source prefetch adapters |
| `maintenance/dependency_updates/npm_lock.py` | Effective npm manifests, lockfile refresh, and npm hashes |
| `maintenance/dependency_updates/candidate.py` | Candidate preparation, validation, reports, and dry runs |
| `maintenance/dependency_updates/publish.py` | Forgejo API access and bot-branch publication |
| `maintenance/dependency_updates/__main__.py` | CLI argument parsing and command dispatch |
| `maintenance/tests/test_dependency_model.py` | Inventory and precise pin-edit behavior |
| `maintenance/tests/test_dependency_sources.py` | Version selection and fetcher behavior |
| `maintenance/tests/test_dependency_npm_lock.py` | Lockfile policy and hash behavior |
| `maintenance/tests/test_dependency_candidate.py` | No-op, isolation, and validation behavior |
| `maintenance/tests/test_dependency_publish.py` | Branch leases, PR reuse, and API errors |
| `.forgejo/workflows/nightly-dependency-updates.yml` | One schedule, discovery job, and isolated update matrix |
| `docs/dependency-updates.md` | Runner, secret, manual use, troubleshooting, and ownership rules |

Keep each Python module focused. Review any module over 400 meaningful lines before adding more responsibilities.

## Inventory and PR units

The baseline contains 20 managed source pins. Preserve each source's existing fetcher and hash mode.

| Unit ID | Source IDs | Package-specific build targets | Maintained lockfile |
| --- | --- | --- | --- |
| `flake-inputs` | Flake input graph | Full checks only | `flake.lock` |
| `pi-listen` | `pi-listen`, `sherpa-onnx-node`, `sherpa-onnx-linux-x64` | `pi-listen` | None |
| `pi-loadout` | `pi-loadout` | `pi-loadout` | None |
| `pi-vim` | `pi-vim` | `pi-vim` | `nix/packages/pi-vim-package-lock.json` |
| `pi-claude-bridge` | `pi-claude-bridge` | `pi-claude-bridge` | Upstream lock plus existing integrity patch |
| `pi-messenger-bridge` | `pi-messenger-bridge`, `matrix-sdk-crypto-nodejs` | `pi-messenger-bridge` | `nix/packages/pi-messenger-bridge-package-lock.json` |
| `pi-subagents` | `pi-subagents` | `pi-subagents` | Upstream lock |
| `remote-pi-extension` | `remote-pi-extension` | `remote-pi-extension` | `nix/packages/remote-pi-package-lock.json` |
| `pi-remote` | `pi-remote` | `pi-remote` | `pi-remote-package-lock.json` |
| `pi-intervals` | `pi-intervals` | `pi-intervals` | Upstream lock |
| `context-mode` | `context-mode` | `context-mode` | `context-mode-package-lock.json` |
| `codegraph` | `pi-codegraph`, `codegraph`, `codegraph-linux-x64` | `pi-codegraph`, `codegraph` | None |
| `diff-package` | `diff` | `diff-package` | None |
| `superpowers` | `superpowers` | `superpowers-source` | None |
| `simple-english` | `simple-english` | `simple-english-source` | None |
| `mattpocock-skills` | `mattpocock-skills` | `mattpocock-skills` | None |

The `pi-remote` unit means `@noahsaso/pi-remote`. The `remote-pi-extension` unit means the npm package `remote-pi`. Do not combine them.

`notion-cli` and `codegraph-viz` are outside this scope. Local extensions and local skills are also outside this scope.

## Task 1: Extract pins without changing package behavior

**Files:** Create `nix/dependency-pins.json` and `modules/packages/dependency-update-tools.nix`. Modify the three Nix recipes and `modules/packages/pi-deps.nix` listed earlier.

**Interfaces:** The pin file is a JSON object keyed by the 20 source IDs. Each record contains the existing applicable string fields: `version`, `rev`, `url`, `hash`, `sha256`, and `npmDepsHash`. Nix recipes read only their existing fields. For versioned source names, record the existing version from the name or URL. The tooling package exposes its commands through `bin/`.

This task changes static data layout. Do not add tests that restate pin values. Use derivation comparison and existing checks instead.

- [x] **Step 1: Save a baseline of existing package derivations.**

```sh
nix eval --json .#packages.x86_64-linux \
  --apply 'ps: builtins.mapAttrs (_: p: p.drvPath) ps' \
  > /tmp/nightly-updates-before.json
```

- [x] **Step 2: Copy existing pin strings into JSON and replace only their Nix references.** Keep existing fetchers, patch lists, and build flags unchanged. Also preserve lockfile paths, install phases, and `packagePaths`. Do not update a version during this extraction.

The Superpowers entry must start with the current values:

```json
{
  "superpowers": {
    "rev": "v6.4.2",
    "sha256": "sha256-BWPiXoXV+jePP+wn/Z+Af4iehIL7oei00plaWaTzq8s="
  }
}
```

Use this expression shape inside each existing recipe:

```nix
pins = builtins.fromJSON (builtins.readFile ../dependency-pins.json);
# dependency-source: superpowers
superpowersSrc = pkgs.fetchgit {
  url = "https://github.com/obra/superpowers.git";
  inherit (pins.superpowers) rev sha256;
};
```

For npm packages, read the source fields from the same source record as the package fields:

```nix
piVimSrc = pkgs.fetchzip {
  inherit (pins."pi-vim") url hash;
};
```

The `piVim` derivation reads `version` and `npmDepsHash` from `pins."pi-vim"`. Preserve its existing `postPatch` and install flags.

Use pin-derived versions in the existing versioned names for Listen, Loadout, pi-codegraph, the CodeGraph shim, its Linux package, and the CodeGraph derivation. Preserve each baseline name exactly. Add a `# dependency-source: SOURCE-ID` marker immediately before each managed fetcher expression. These markers support a conservative inventory audit without a general Nix parser.

- [x] **Step 3: Expose missing build targets and add the tool package.** Add `pi-claude-bridge`, `remote-pi-extension`, `superpowers-source`, and `simple-english-source` to `modules/packages/pi-deps.nix` using the existing exported `piDeps` values.

The tool package uses the existing pinned nixpkgs:

```nix
{ ... }:
{
  perSystem = { pkgs, ... }: {
    packages.dependency-update-tools = pkgs.buildEnv {
      name = "dependency-update-tools";
      paths = [
        (pkgs.python3.withPackages (ps: [ ps.pyyaml ]))
        pkgs.nodejs
        pkgs.nodePackages.semver
        pkgs.git
        pkgs.nix
        pkgs.nix-prefetch-git
        pkgs.prefetch-npm-deps
        pkgs.patch
        pkgs.nixfmt-rfc-style
        pkgs.actionlint
      ];
    };
  };
}
```

- [x] **Step 4: Stage new Nix-referenced files, format, and compare derivations.** Nix flakes do not include untracked files. Compare every original package key against the baseline. New exports do not need an old counterpart.

```sh
git add nix/dependency-pins.json modules/packages/dependency-update-tools.nix
nix eval --json .#packages.x86_64-linux \
  --apply 'ps: builtins.mapAttrs (_: p: p.drvPath) ps' \
  > /tmp/nightly-updates-after.json
python3 - <<'PY'
import json
from pathlib import Path
before = json.loads(Path('/tmp/nightly-updates-before.json').read_text())
after = json.loads(Path('/tmp/nightly-updates-after.json').read_text())
changed = [name for name, drv in before.items() if after.get(name) != drv]
if changed:
    raise SystemExit(f'Existing package derivations changed: {changed}')
print('All existing package derivations match')
PY
nix build .#packages.x86_64-linux.dependency-update-tools --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
git diff --check
```

- [x] **Step 5: Commit the behavior-preserving extraction.**

```sh
git add nix/dependency-pins.json nix/packages/pi-deps.nix \
  nix/packages/pi-remote.nix nix/packages/pi-intervals.nix \
  modules/packages/pi-deps.nix modules/packages/dependency-update-tools.nix
git commit -m "refactor(deps): separate pins from package recipes"
```

## Task 2: Define the inventory and precise pin-edit contract

**Files:** Create the Python package boundaries, `model.py`, `catalog.json`, and `maintenance/tests/test_dependency_model.py`.

**Interfaces:**

```python
from dataclasses import dataclass
from pathlib import Path

@dataclass(frozen=True)
class Unit:
    id: str
    source_ids: tuple[str, ...]
    builds: tuple[str, ...]
    paths: tuple[str, ...]

@dataclass(frozen=True)
class Candidate:
    unit_id: str
    base_branch: str
    base_sha: str
    tree_sha: str
    paths: tuple[str, ...]
    summary: str
    changed: bool
    validated: bool = False
```

`load_catalog(root: Path) -> tuple[dict[str, Unit], dict[str, dict]]` loads the units and source policies. `edit_pins(pins: dict, unit: Unit, replacements: dict) -> dict` returns a new pin dictionary. `UpdateError(stage: str, message: str)` exposes `stage` and identifies `inventory`, `lookup`, `source-hash`, `lockfile`, `npm-hash`, `validation`, or `publication` errors.

Catalog source policies contain `fetcher`, `channel`, `hash_field`, and the upstream location or npm package name. `hash_field` is `hash` or `sha256`, matching the existing recipe. Channels are `npm-latest`, `git-stable-tag`, `git-default-head`, and `companion`. Fetchers are `fetchzip`, `fetchurl`, `fetchgit`, and `github-archive`. Companion policies also name their primary source and selection rule.

- [x] **Step 1: Write a failing behavior test for exact ownership.**

```python
import unittest
from maintenance.dependency_updates.model import Unit, UpdateError, edit_pins

class PinEditTests(unittest.TestCase):
    def test_edit_preserves_unrelated_source(self):
        pins = {"a": {"rev": "old"}, "b": {"rev": "keep"}}
        unit = Unit("one", ("a",), (), ("nix/dependency-pins.json",))
        result = edit_pins(pins, unit, {"a": {"rev": "new"}})
        self.assertEqual(result["b"], pins["b"])
        self.assertEqual(pins["a"]["rev"], "old")
        self.assertEqual(result["a"]["rev"], "new")

    def test_edit_rejects_source_owned_by_another_unit(self):
        unit = Unit("one", ("a",), (), ("nix/dependency-pins.json",))
        with self.assertRaises(UpdateError):
            edit_pins({"a": {}, "b": {}}, unit, {"b": {"rev": "new"}})
```

- [x] **Step 2: Run the test before implementation.**

```sh
python3 -m unittest discover -s maintenance/tests -p test_dependency_model.py -v
```

Expected: import or missing-interface failure.

- [x] **Step 3: Implement ownership and inventory validation.** Use this core edit rule:

```python
from copy import deepcopy

allowed = set(unit.source_ids)
if set(replacements) - allowed:
    raise UpdateError("inventory", "Replacement includes an unowned source")
if allowed - set(pins):
    raise UpdateError("inventory", "An owned source is missing from the pin file")
result = deepcopy(pins)
for source_id, fields in replacements.items():
    result[source_id].update(fields)
return result
```

Validate unit IDs with `[a-z][a-z0-9-]*`. Reject duplicate ownership, unknown fetchers or channels, missing policies, path traversal, malformed SRI hashes, and unknown replacement fields. Compare the dependency-source markers with the recognized fetcher calls in the three managed Nix files. Reject an unmarked call, a duplicate marker, or a marker without a matching catalog source. Do not attempt to interpret arbitrary Nix syntax. Validate repository-relative paths before filesystem access. Reject a pins/catalog source-set mismatch instead of skipping it.

Populate all 16 units and all 20 sources from the inventory table. Tagged Git sources are Superpowers, SimpleEnglish, and pi-subagents. Commit-based sources are Matt Pocock skills, pi-claude-bridge, and pi-intervals. Record the actual upstream URLs from their current Nix expressions.

- [x] **Step 4: Add tests for malformed inventory input and run them.** Use synthetic input rather than assertions of the production catalog's exact text.

```sh
python3 -m unittest discover -s maintenance/tests -p test_dependency_model.py -v
```

Expected: all tests pass, including rejected duplicate ownership and rejected `../` paths.

- [x] **Step 5: Commit.**

```sh
git add maintenance/__init__.py maintenance/dependency_updates/__init__.py \
  maintenance/dependency_updates/model.py maintenance/dependency_updates/catalog.json \
  maintenance/tests/test_dependency_model.py
git commit -m "feat(deps): define isolated update units"
```

## Task 3: Resolve upstream versions and prefetch the correct source form

**Files:** Create `sources.py` and `maintenance/tests/test_dependency_sources.py`. Extend source-policy records in `catalog.json` only where this task needs concrete upstream fields.

**Interfaces:** `select_stable_tag(refs: str) -> tuple[str, str]` returns the selected tag and peeled commit. `resolve_source(policy: dict, current: dict, read_json, ls_remote) -> dict` returns the next primary-source version, revision, and URL fields. `resolve_companion(policy: dict, manifests: dict[str, dict], locks: dict[str, dict], read_json, run) -> dict` selects a companion from the consuming manifest or lock. `prefetch_source(root: Path, policy: dict, resolved: dict, run) -> tuple[dict, Path]` returns hash-bearing pin fields and the fetched file or directory. The injected `run` callable follows `subprocess.run` arguments and returns `CompletedProcess`.

- [x] **Step 1: Write failing tests for stable selection and annotated tags.**

```python
import unittest
from maintenance.dependency_updates.sources import select_stable_tag

class TagSelectionTests(unittest.TestCase):
    def test_numeric_order_ignores_prereleases_and_peels_tag(self):
        refs = "\n".join([
            "a" * 40 + "\trefs/tags/v1.9.0",
            "b" * 40 + "\trefs/tags/v1.10.0",
            "c" * 40 + "\trefs/tags/v1.10.0^{}",
            "d" * 40 + "\trefs/tags/v2.0.0-rc.1",
        ])
        self.assertEqual(select_stable_tag(refs), ("v1.10.0", "c" * 40))
```

- [x] **Step 2: Run the tests and observe the missing implementation.**

```sh
python3 -m unittest discover -s maintenance/tests -p test_dependency_sources.py -v
```

- [x] **Step 3: Implement stable version rules and source adapters.** Accept stable numeric semver tags with an optional `v` prefix. Compare numeric components, not tag strings. Read both tag and peeled-tag records from `git ls-remote --tags`. Reject a tag list without a stable version.

Npm selection reads `dist-tags.latest`, verifies that its version is stable, and reads that exact version's metadata and tarball URL. Reject missing or prerelease `latest` values instead of guessing another release channel. Git default-head selection uses `git ls-remote --symref URL HEAD` and records the exact returned commit. For Claude Bridge's date label, read that SHA's GitHub commit metadata and its committer date. Reject a mismatched SHA or invalid date in the response.

Use these prefetch methods:

```sh
# fetchzip and GitHub source archives: recursive unpacked hash and store path
nix-prefetch-url --unpack --print-path "$source_url"

# fetchurl: raw-file hash and store path
nix store prefetch-file --json "$source_url"

# fetchgit: Git tree hash, revision, date, and store path
nix-prefetch-git --url "$repo_url" --rev "$commit_sha"

# Convert a legacy hash to the SRI form consumed by the existing recipes
nix hash convert --hash-algo sha256 --to sri "$source_hash"
```

Pass arguments as arrays with `shell=False`. Use bounded subprocess and HTTP timeouts. Require successful status codes and the expected hash/path fields. Write the SRI result into the policy's `hash_field`, not a second, conflicting hash field. Do not parse a generic build failure as a successful hash update.

`github-archive` uses `https://github.com/OWNER/REPO/archive/REV.tar.gz`, matching `fetchFromGitHub` for the current sources. Retain the existing tag-based `rev` style for tagged pins. Use exact commit SHAs for commit-based pins.

- [x] **Step 4: Add behavior tests for every fetcher and error boundary.** Test raw versus unpacked hashing and missing prefetch fields. Also test lookup errors, unsafe upstream URLs, default-head parsing, and unchanged selection. Preserve each Git recipe's submodule policy in the prefetch command. Assert command arguments and outputs, not implementation line numbers.

For companions, use `resolve_companion` and the pinned `semver` CLI. Select a stable version within the consuming manifest's declared range. Do not call the primary-source resolver for a companion policy. Sherpa's Linux package must match the selected Sherpa Node version. CodeGraph's Linux package must match the selected shim version. The Matrix binary version must match `node_modules/@matrix-org/matrix-sdk-crypto-nodejs` in the refreshed Messenger lock. A missing matching artifact is an error. Do not substitute an arbitrary newest native binary.

- [x] **Step 5: Run and commit.**

```sh
python3 -m unittest discover -s maintenance/tests -p test_dependency_sources.py -v
git add maintenance/dependency_updates/sources.py \
  maintenance/dependency_updates/catalog.json maintenance/tests/test_dependency_sources.py
git commit -m "feat(deps): resolve and prefetch upstream sources"
```

## Task 4: Refresh effective npm locks and dependency hashes

**Files:** Create `npm_lock.py` and `maintenance/tests/test_dependency_npm_lock.py`. Update lock-policy records in `catalog.json`.

**Interfaces:** `effective_manifest(source_id: str, manifest: dict) -> dict` returns a copy with the recipe's pre-install changes. `refresh_npm_lock(root: Path, source_id: str, fetched: Path, policy: dict, run) -> tuple[bytes, str]` returns the lock content and npm SRI hash. `source_manifest(fetched: Path, fetcher: str) -> dict` reads the manifest without unsafe archive extraction.

- [x] **Step 1: Write a failing test for the pi-remote manifest policy.**

```python
import unittest
from maintenance.dependency_updates.npm_lock import effective_manifest

class ManifestPolicyTests(unittest.TestCase):
    def test_pi_remote_removes_dev_dependencies_without_mutating_input(self):
        original = {
            "name": "@noahsaso/pi-remote",
            "dependencies": {"ws": "^8.0.0"},
            "devDependencies": {"typescript": "^5.0.0"},
            "scripts": {"install": "exit 99"},
        }
        result = effective_manifest("pi-remote", original)
        self.assertNotIn("devDependencies", result)
        self.assertEqual(result["scripts"], {})
        self.assertEqual(result["dependencies"], {"ws": "^8.0.0"})
        self.assertIn("devDependencies", original)
```

- [x] **Step 2: Run the failing test.**

```sh
python3 -m unittest discover -s maintenance/tests -p test_dependency_npm_lock.py -v
```

- [x] **Step 3: Implement lock policies in temporary directories.** Apply the recipe's pre-install manifest policy. Seed a maintained lock from its existing contents. Then generate the new lock with the pinned npm:

```sh
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
prefetch-npm-deps package-lock.json
```

Never run lifecycle scripts. Preserve upstream dependency ranges. Do not upgrade transitive dependencies during an otherwise unchanged source update. Do not pass `--omit=dev` when generating a full lock that the Nix recipe expects. Existing install flags still apply during the package build.

Specific policies:

- `pi-vim`, `pi-messenger-bridge`, `remote-pi-extension`, and `context-mode`: refresh their maintained locks from the new upstream manifest.
- `pi-remote`: remove `devDependencies` and set `scripts` to `{}` before lock generation, matching its current `postPatch`.
- `pi-subagents` and `pi-intervals`: use the prefetched upstream lock. Fail if it is absent or inconsistent.
- `pi-claude-bridge`: copy the source to a temporary directory and apply the existing `pi-claude-bridge-lock-integrity.patch` before prefetching its lock. Do not alter or remove that patch automatically.
- `remote-pi-extension`: do not move host packages to peers before hash calculation. Its recipe performs that change after npm installation.
- `context-mode`: its runtime-path substitution does not change the manifest or lock. Leave that substitution in the Nix recipe.

Raw npm archives require only `package/package.json` and, where present, `package/package-lock.json`. Read regular members with `tarfile.extractfile`. Reject symlink members and oversized or invalid JSON. Do not extract an untrusted archive into the repository.

- [x] **Step 4: Add tests for safe lock generation and hash failures.** Test `--ignore-scripts`, the maintained-lock seed, and upstream-lock absence. Also test patch failure, malformed npm hash output, and post-install host-module handling. Test the unchanged-source no-op at the candidate boundary in Task 5. Check the generated lock's root name, version, and dependency declarations against the effective manifest before accepting its hash.

For commit-based package version labels, read the fetched manifest's version. Intervals retains `VERSION-SHORTREV`. Claude Bridge retains `VERSION-unstable-YYYY-MM-DD`, using the upstream commit date. Do not derive the date from the runner clock.

- [x] **Step 5: Run and commit.**

```sh
python3 -m unittest discover -s maintenance/tests -p test_dependency_npm_lock.py -v
git add maintenance/dependency_updates/npm_lock.py \
  maintenance/dependency_updates/catalog.json maintenance/tests/test_dependency_npm_lock.py
git commit -m "feat(deps): refresh npm locks and hashes safely"
```

## Task 5: Prepare, validate, and report one candidate

**Files:** Create `candidate.py`, `__main__.py`, and `maintenance/tests/test_dependency_candidate.py`.

**Interfaces:** `prepare(root: Path, unit: Unit, base_branch: str, base_sha: str, run, read_json, ls_remote) -> Candidate`; `validate(root: Path, unit: Unit, candidate: Candidate, run) -> Candidate`; `write_report(path: Path, candidate: Candidate | None, error: UpdateError | None = None) -> None`; `read_report(path: Path) -> Candidate`.

Reports contain `schema: 1`, the serialized `candidate`, and an optional error record with `stage` and `message`. `read_report` validates that envelope and rejects a failed report. Successful dry-run reports remain unvalidated.

CLI commands:

```sh
python3 -m maintenance.dependency_updates list
python3 -m maintenance.dependency_updates audit
python3 -m maintenance.dependency_updates prepare superpowers \
  --base main --base-sha "$(git rev-parse HEAD)" \
  --report /tmp/superpowers-candidate.json --dry-run
```

A real isolated job omits `--dry-run` and validates its own report:

```sh
python3 -m maintenance.dependency_updates prepare superpowers \
  --base main --base-sha "$(git rev-parse HEAD)" \
  --report /tmp/superpowers-live-candidate.json
python3 -m maintenance.dependency_updates validate \
  --report /tmp/superpowers-live-candidate.json
```

`list` emits a compact JSON array of unit IDs. `audit` fails on catalog/pin ownership errors and reports any unmanaged fixed source remaining in the three managed recipes. `prepare --dry-run` uses a temporary clone, reports planned changes, and does not mutate the caller's checkout. A dry-run report is not publishable.

- [x] **Step 1: Write a failing test for a failed validation gate.**

```python
import subprocess
import unittest
from pathlib import Path
from maintenance.dependency_updates.model import Candidate, Unit, UpdateError
from maintenance.dependency_updates.candidate import validate

class CandidateValidationTests(unittest.TestCase):
    def test_failed_gate_does_not_mark_candidate_validated(self):
        unit = Unit("superpowers", ("superpowers",), (), ("nix/dependency-pins.json",))
        candidate = Candidate(
            "superpowers", "main", "a" * 40, "b" * 40,
            unit.paths, "Update Superpowers", True,
        )
        commands = []
        def fail(command, **kwargs):
            commands.append(command)
            return subprocess.CompletedProcess(command, 1, "", "build failed")
        with self.assertRaises(UpdateError) as raised:
            validate(Path.cwd(), unit, candidate, fail)
        self.assertEqual(raised.exception.stage, "validation")
        self.assertEqual(len(commands), 1)
        self.assertFalse(candidate.validated)
```

- [x] **Step 2: Run the tests before implementation.**

```sh
python3 -m unittest discover -s maintenance/tests -p test_dependency_candidate.py -v
```

- [x] **Step 3: Implement candidate preparation as one unit-scoped transaction.** Require a clean checkout at `base_sha`. Resolve and prefetch primary sources. Read their manifests and refresh any affected npm lock. Then resolve companions from those manifests and locks before prefetching the companions. Source IDs within a unit list each consuming source before its companions. Reject missing, later, or cross-unit companion references during inventory loading. Persist only fields already defined in each pin record. Keep informational selection metadata in the candidate summary. For npm sources, verify the fetched manifest's name and version against the selected registry metadata. Prepare all pin and lock replacements in temporary storage before writing repository files. Roll back the unit's tracked changes on an error. Never reset unrelated work.

For `flake-inputs`, run only `nix flake update` as the update operation. Its owned path is `flake.lock`. For every other unit, permit `nix/dependency-pins.json` and only that unit's maintained lock paths. Verify that only the unit's pin records changed within the shared JSON file.

Stage the owned changed files and capture the exact candidate tree with `git write-tree`. Record the base commit, base branch, tree hash, changed paths, summary, and `validated=False`. Unknown path or unrelated pin changes are errors.

Do not refresh lockfiles if all selected source revisions and companion versions remain unchanged. Emit `changed=false` through `GITHUB_OUTPUT` when there is no diff. Otherwise emit `changed=true`.

- [x] **Step 4: Implement the validation gate and its immutable-tree check.** First require strict sandbox configuration and pass a fresh runtime isolation canary. Force sandboxing without fallback on every build. Run direct builds from the unit's `builds`, then both required checks. For `flake-inputs`, discover and build every package output, including packages not built by flake checks:

```python
commands = [
    ["nix", "build", f".#packages.x86_64-linux.{name}", "--no-link"]
    for name in unit.builds
]
commands += [
    ["nix", "build", ".#checks.x86_64-linux.pi-config-extension-load", "--no-link"],
    ["nix", "flake", "check", "--accept-flake-config", "--print-build-logs"],
]
for command in commands:
    result = run(command, cwd=root, check=False)
    if result.returncode:
        raise UpdateError("validation", f"Command failed: {command}")
```

After the commands pass, verify that the index tree still equals `candidate.tree_sha` and tracked files still match the index. Then return a new candidate with `validated=True`. A no-change candidate needs no builds and cannot enter publication.

- [x] **Step 5: Add transaction and CLI tests, run them, and commit.** Use temporary Git repositories. Cover preparation rollback, no-change output, dry-run isolation, flake-only ownership, unrelated-source rejection, a tree change during validation, and invalid unit IDs.

```sh
python3 -m unittest discover -s maintenance/tests -p test_dependency_candidate.py -v
python3 -m maintenance.dependency_updates audit
python3 -m maintenance.dependency_updates list
git add maintenance/dependency_updates/candidate.py \
  maintenance/dependency_updates/__main__.py maintenance/tests/test_dependency_candidate.py
git commit -m "feat(deps): prepare and validate isolated candidates"
```

## Task 6: Publish only validated candidates and reuse bot PRs

**Files:** Create `publish.py` and `forgejo_api.py` and `maintenance/tests/test_dependency_publish.py`. Extend CLI dispatch in `__main__.py`.

**Interfaces:** `bot_branch(unit_id: str) -> str` returns `automation/dependencies/UNIT`. `ForgejoClient(server_url: str, repository: str, token: str, request)` exposes `current_user() -> dict`, `open_pulls() -> list[dict]`, `create_pull(head: str, base: str, title: str, body: str) -> dict`, and `update_pull(number: int, title: str, body: str) -> dict`. `publish(root: Path, candidate: Candidate, client: ForgejoClient, run) -> str | None` returns a PR URL or `None` for a no-op.

- [x] **Step 1: Write a failing test for an unvalidated candidate.**

```python
import unittest
from pathlib import Path
from unittest.mock import Mock
from maintenance.dependency_updates.model import Candidate, UpdateError
from maintenance.dependency_updates.publish import publish

class PublicationGateTests(unittest.TestCase):
    def test_unvalidated_candidate_never_calls_api_or_git(self):
        candidate = Candidate(
            "superpowers", "main", "a" * 40, "b" * 40,
            ("nix/dependency-pins.json",), "Update Superpowers", True,
        )
        client, run = Mock(), Mock()
        with self.assertRaises(UpdateError):
            publish(Path.cwd(), candidate, client, run)
        self.assertEqual(client.mock_calls, [])
        run.assert_not_called()
```

- [x] **Step 2: Run the failing tests.**

```sh
python3 -m unittest discover -s maintenance/tests -p test_dependency_publish.py -v
```

- [x] **Step 3: Implement publication guards and exact bot-branch leases.** Return immediately for `changed=False`. Otherwise require `validated=True`, an unchanged candidate tree, the declared unit's paths and pin ownership, and a valid base commit.

Fetch the current default-branch head and bot-branch head. Refuse publication if the default branch moved from `candidate.base_sha`. For an existing branch, require bot-owned update metadata. If a PR exists, require the expected bot author, source repository, head branch, and base branch. Refuse an unrelated or ambiguous branch/PR.

Create a commit from the validated tree, not from a fresh staging operation:

```sh
git -c user.name=dependency-updater \
  -c user.email=dependency-updater@users.noreply.git.compaan.cloud \
  commit-tree "$validated_tree" -p "$base_sha"

git push \
  "--force-with-lease=refs/heads/$bot_branch:$expected_remote_sha" \
  origin "$commit_sha:refs/heads/$bot_branch"
```

Use an empty expected SHA for an absent branch. Include `Dependency-Update-Unit` and `Dependency-Update-Base` trailers in the commit message. Refuse a pre-existing branch without the expected trailers. If the existing bot commit has the same tree and base parent, reuse it instead of rewriting it every night.

Never run `git push --force`, push to the default branch, or call a merge endpoint. On a lease failure, stop without updating a PR. Do not retry with a new lease inside the same validated candidate.

- [x] **Step 4: Implement the Forgejo API and temporary Git authentication.** Use these repository-scoped endpoints:

```text
GET   /api/v1/user
GET   /api/v1/repos/{owner}/{repo}/pulls?state=open&limit=50&page={page}
POST  /api/v1/repos/{owner}/{repo}/pulls
PATCH /api/v1/repos/{owner}/{repo}/pulls/{number}
```

Paginate open PRs. Match the exact bot head, base, source repository, and author. Create one PR only if none matches. On later runs, update that PR's title and body only if their contents changed. If a push succeeded but PR creation failed, the next run can reuse the orphan bot branch after the trailer and ownership checks.

Require HTTPS and the configured server origin. Refuse credential-bearing redirects. Use bounded timeouts and report HTTP status errors without tokens or full authorization headers. Validate JSON response shape.

Git authentication uses a temporary private `GIT_ASKPASS` script, the bot login from `GET /user`, and the token in the subprocess environment. Set `GIT_TERMINAL_PROMPT=0`. Do not embed credentials in a URL, command arguments, or permanent Git configuration. Remove the helper in a `finally` block.

- [x] **Step 5: Add realistic publication tests, run them, and commit.** Use local bare Git repositories for leases and tree comparisons. Mock only the HTTP boundary. Cover first PR creation, paginated PR reuse, unchanged branch reuse, an orphan bot branch, and a human-owned branch. Also cover stale default heads, lease rejection, duplicate PR matches, API failure, unsafe redirects, and no-change candidates.

```sh
python3 -m unittest discover -s maintenance/tests -p test_dependency_publish.py -v
git add maintenance/dependency_updates/publish.py \
  maintenance/dependency_updates/__main__.py maintenance/tests/test_dependency_publish.py
git commit -m "feat(deps): publish leased bot branches and reuse PRs"
```

Task 6 verification: 80 behavior tests passed, including three pre-API remote races and lease rejection. Python compilation and `git diff --check` passed. The API client is separate in `forgejo_api.py`. Publication checks the default and bot heads again before any PR mutation, including same-tree reuse.

## Task 7: Wire the single Forgejo workflow and deployment guide

**Files:** Create `.forgejo/workflows/nightly-dependency-updates.yml` and `docs/dependency-updates.md`.

**Interfaces:** The workflow consumes the CLI commands, unit array, candidate report, and step `changed` output. The publication command consumes `DEPENDENCY_UPDATE_TOKEN`, `FORGEJO_SERVER_URL`, and `FORGEJO_REPOSITORY` from its step environment.

This task is static workflow and documentation work. Do not create tests that assert YAML or documentation text. Use YAML parsing, workflow linting, and the updater's existing behavior tests.

- [x] **Step 1: Create the workflow's triggers, checkout pin, and isolated matrix.**

Use the following policy values:

```yaml
name: Nightly dependency updates
on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch:
concurrency:
  group: nightly-dependency-updates
  cancel-in-progress: false
```

The discovery job checks out the default branch with this action and credential policy:

```yaml
- uses: https://code.forgejo.org/actions/checkout@11d5960a326750d5838078e36cf38b85af677262
  with:
    persist-credentials: false
```

Use `runs-on: ${{ vars.DEPENDENCY_UPDATE_RUNNER || 'nix' }}` for discovery and update jobs. The workflow must refuse non-default-branch manual dispatch before any token-bearing step.

Discovery emits the actual checkout commit, the default-branch name, and the compact `list` result. Each update job checks out that exact commit. Use:

```yaml
strategy:
  fail-fast: false
  max-parallel: 2
  matrix:
    unit: ${{ fromJSON(needs.discovery.outputs.units) }}
```

Add a job-level concurrency group using `matrix.unit`. Use workflow-level concurrency for overlapping runs and the Git lease as the final race guard.

Define job environment values `UPDATE_UNIT`, `BASE_SHA`, and `BASE_BRANCH` from the matrix and discovery outputs. Pass them through quoted shell variables, not interpolation into command text.

- [x] **Step 2: Build tooling before the candidate changes any pins.** Put the build result and report in the runner's temporary directory. Prepend the immutable tool package's `bin/` to `GITHUB_PATH`. Do not run `nix develop` with the publication token in its environment.

```sh
nix build .#packages.x86_64-linux.dependency-update-tools \
  --out-link "$RUNNER_TEMP/dependency-update-tools"
printf '%s\n' "$RUNNER_TEMP/dependency-update-tools/bin" >> "$GITHUB_PATH"
printf 'UPDATE_REPORT=%s/dependency-%s.json\n' "$RUNNER_TEMP" "$UPDATE_UNIT" >> "$GITHUB_ENV"
```

Require an enabled Nix build sandbox before fetching or building upstream candidates. Check `nix config show --json` and require `sandbox.value` to equal Boolean `true`. Unsandboxed native-package builds can modify a host runner before its later publication step.

```sh
python3 - <<'PY'
import json
import subprocess
configuration = json.loads(subprocess.check_output(['nix', 'config', 'show', '--json']))
if configuration.get('sandbox', {}).get('value') is not True:
    raise SystemExit('Dependency updates require an enabled Nix build sandbox')
PY
```

The preparation and validation step bodies are:

```sh
python3 -m maintenance.dependency_updates prepare "$UPDATE_UNIT" \
  --base "$BASE_BRANCH" --base-sha "$BASE_SHA" --report "$UPDATE_REPORT"
```

```sh
python3 -m maintenance.dependency_updates validate --report "$UPDATE_REPORT"
```

Run the Python behavior suite and `audit` in discovery. Update jobs run `prepare UNIT`, then `validate` only when `changed` is true. Give each job a 90-minute timeout. Show an `always()` diagnostic step with its unit, report state, error stage, and validation status. Do not suppress failures with `continue-on-error`.

- [x] **Step 3: Add the final publication step with token-only-at-publication scope.**

```yaml
- name: Publish validated update
  if: success() && steps.prepare.outputs.changed == 'true'
  env:
    DEPENDENCY_UPDATE_TOKEN: ${{ secrets.DEPENDENCY_UPDATE_TOKEN }}
    FORGEJO_SERVER_URL: ${{ forgejo.server_url }}
    FORGEJO_REPOSITORY: ${{ forgejo.repository }}
  run: |
    python3 -m maintenance.dependency_updates publish --report "$UPDATE_REPORT" \
      --server "$FORGEJO_SERVER_URL" --repository "$FORGEJO_REPOSITORY"
```

Keep the token out of workflow-level env, job-level env, checkout inputs, updater steps, and build steps. Fail with a clear publication error if the secret is missing. Do not assume a GitHub-style `permissions` block controls Forgejo token rights.

- [x] **Step 4: Document deployment and operator use.** The guide must name:

- Runner label `nix`, override variable `DEPENDENCY_UPDATE_RUNNER`, and the required `x86_64-linux` Nix environment with its build sandbox enabled.
- Repository secret `DEPENDENCY_UPDATE_TOKEN`, bot account, selected-repository write access, and recommended default-branch protection.
- The automatic checkout token is distinct from the publication token.
- The bot never merges PRs, even if the server's repository-write scope also permits merging.
- Schedule time, manual dispatch on the default branch, local dry-run commands, and the 16 PR units.
- Bot branch prefix `automation/dependencies/` and the rule against human commits on those branches.
- Failure stages and the fact that failed checks leave an existing PR unchanged.
- Source-policy changes require maintainer review. Unknown sources fail `audit` rather than disappear from the schedule.
- Action and runner compatibility must receive a live deployment check. Runner and secret creation are not implemented by this branch.

- [x] **Step 5: Validate syntax and commit.** Parse YAML with `yaml.BaseLoader` to avoid the YAML 1.1 interpretation of `on` as a Boolean. For GitHub-oriented `actionlint`, use a temporary copy that normalizes only the Forgejo action URL prefix and `forgejo.` expression context to the equivalent GitHub spelling. Do not alter the production workflow for the linter.

```sh
python3 -m unittest discover -s maintenance/tests -p 'test_dependency_*.py' -v
python3 - <<'PY'
from pathlib import Path
import tempfile
import subprocess
import yaml
source = Path('.forgejo/workflows/nightly-dependency-updates.yml').read_text()
yaml.load(source, Loader=yaml.BaseLoader)
normalized = source.replace('https://code.forgejo.org/', '').replace('forgejo.', 'github.')
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / 'nightly-dependency-updates.yml'
    path.write_text(normalized)
    subprocess.run(['actionlint', str(path)], check=True)
PY
git diff --check
git add .forgejo/workflows/nightly-dependency-updates.yml docs/dependency-updates.md
git commit -m "ci(deps): schedule isolated nightly update PRs"
```

The normalized lint is not proof of Forgejo runtime compatibility. Compare the original workflow against Forgejo 16's documented contexts, concurrency, and matrix support. Confirm those behaviors in the deployment run.

Task 7 verification: original YAML parsed with `yaml.BaseLoader`; a temporary Forgejo-to-GitHub normalized copy passed `actionlint`; all original run blocks passed `bash -n`. The default-branch guard accepted main and rejected feature/tag refs when run directly. All 80 behavior tests and `git diff --check` passed. Forgejo 16 documentation covers the contexts, matrix, schedule, and best-effort workflow concurrency. Live runner/job concurrency compatibility remains deferred.

## Task 8: Rehearse update formats and record final evidence

**Files:** Update this plan's checkboxes and `docs/dependency-updates.md` only if verified operator guidance changes. Do not publish branches during local rehearsal.

**Interfaces:** Use the completed CLI and tests. No new production interfaces.

- [x] **Step 1: Run the complete updater behavior suite from the pinned tool environment.**

```sh
nix build .#packages.x86_64-linux.dependency-update-tools \
  --out-link /tmp/nightly-dependency-tools
export PATH="/tmp/nightly-dependency-tools/bin:$PATH"
python3 -m unittest discover -s maintenance/tests -p 'test_dependency_*.py' -v
python3 -m compileall -q maintenance
python3 -m maintenance.dependency_updates audit
```

- [x] **Step 2: Rehearse representative real-source formats without publication.** Run dry preparations for each source format. Include tagged Git, commit-based GitHub archives, unpacked npm sources, raw npm archives, and native companions:

```sh
base="$(git rev-parse HEAD)"
status=0
for unit in flake-inputs superpowers pi-intervals pi-vim context-mode codegraph pi-listen pi-messenger-bridge; do
  if ! python3 -m maintenance.dependency_updates prepare "$unit" \
    --base main --base-sha "$base" \
    --report "/tmp/nightly-$unit.json" --dry-run; then
    status=1
  fi
done
test "$status" -eq 0
```

Record old and selected versions, fetched source form, lock changes, and hash outcomes. An unchanged upstream pin is a valid no-op. Do not count an adapter that never performed a prefetch as hash-verification evidence.

Use the existing prefetch interface to verify current pins when upstream selection is unchanged:

```sh
python3 - <<'PY'
import json
import subprocess
from pathlib import Path
from maintenance.dependency_updates.model import load_catalog
from maintenance.dependency_updates.sources import prefetch_source
root = Path.cwd()
units, policies = load_catalog(root)
pins = json.loads((root / 'nix/dependency-pins.json').read_text())
for source_id in ('superpowers', 'pi-intervals', 'pi-vim', 'context-mode', 'matrix-sdk-crypto-nodejs'):
    fields, fetched = prefetch_source(root, policies[source_id], pins[source_id], subprocess.run)
    field = policies[source_id]['hash_field']
    if fields[field] != pins[source_id][field]:
        raise SystemExit(f'{source_id}: current source hash differs')
    print(source_id, fields[field], fetched)
PY
```

If a compatibility patch no longer applies, report the candidate error. Do not edit the patch just to complete the rehearsal. A unit's failure must not prevent rehearsal of later units.

- [x] **Step 3: Run required checks on the final implementation tree.**

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
git diff --check
git status --short
```

Record command exit codes and the tested commit. Do not substitute `pi --help` or a package build for the extension-load check.

- [x] **Step 4: Review spec coverage and present completion evidence.** Direct execution does not authorize dispatching a reviewer. Do a parent review unless the operator separately requests independent review. Show the update units, meaningful automated-test results, unchanged baseline derivations, final Nix checks, and residual deployment requirements. Verify `fetchgit` and GitHub archive adapters against the existing submodule and hash policies.

Do not merge or push this branch merely because the plan is complete. Offer a local squash merge into `main`, a PR, or keeping the branch when implementation is complete. Respect other sessions' dirty work.

- [ ] **Step 5: After integration and runner/secret setup, perform the live deployment check with operator approval.**

This is a deferred deployment check, not a blocker for completing repository implementation. Do not dispatch without explicit operator approval.

Manually dispatch the workflow on the default branch. Observe independent matrix jobs, one failure not cancelling its neighbors, no-change behavior, bot-branch publication, PR reuse on a second dispatch, and no automatic merges. Record any runner or action compatibility blocker rather than claiming the schedule works from local lint alone.

### Task 8 evidence (2026-10-03)

Repository checks ran on `97f524446c971f90451f68e90cb652d39787a3ab`. Later changes record this evidence and correct the guide's error-stage names only.

- The pinned tool package rebuilt successfully.
- All 80 behavior tests passed. Python compilation and inventory audit passed.
- A fresh runtime sandbox canary passed.
- `nix build .#checks.x86_64-linux.pi-config-extension-load --no-link` exited 0.
- `nix flake check --accept-flake-config --print-build-logs` exited 0.
- All 20 original package derivations matched `/tmp/nightly-updates-before.json`. The five new outputs expose tooling or existing sources/packages.
- Eight isolated dry preparations exited 0. They did not change this worktree or publish.

| Rehearsal unit | Old -> selected | Source form and outcome |
| --- | --- | --- |
| `flake-inputs` | Four locks changed | `flake-parts`, `import-tree`, `llm-agents`, and `nixpkgs-lib`; only `flake.lock` changed |
| `superpowers` | `v6.4.2 -> v6.4.2` | Tagged `fetchgit` with submodules; no-op |
| `pi-intervals` | `0.1.0-17b7a28 -> same` | Commit-based GitHub archive; no-op |
| `pi-vim` | `0.14.1 -> 0.14.2` | Unpacked npm source; maintained lock and source/cache hashes changed |
| `context-mode` | `1.0.169 -> same` | Raw npm archive with patched upstream lock; no-op |
| `codegraph` | Wrapper `0.1.10 -> 0.1.11`; package/native `1.5.0 -> 1.6.2` | Three unpacked npm sources and hashes changed together |
| `pi-listen` | `7.2.2 -> same` | Listen and Sherpa companion unit; no-op |
| `pi-messenger-bridge` | `0.4.0 -> same` | Bridge and raw Matrix native companion unit; no-op |

The flake lock revisions changed as follows in the temporary clone:

- `flake-parts`: `17c9d6cdfc60c64f4ee8d306f9bc0b4ccb51481e -> 024633cd702b10285db5cb19b40ad48d2399ba60`.
- `import-tree`: `4ebb10ae17d5f1ad366e7aef5b92cb8eecf24f69 -> eb1b52eaecc57f7c136d07ae8a93e724dfecac46`.
- `llm-agents`: `20762f12777a611184868a1a4408bc42a014adf1 -> 83984ebbbe5322b261d9fdc24eb15cf44f23abec`.
- `nixpkgs-lib`: `db3f255737b94216eb71cce308e2912cf6bc2d7c -> f7cd230690d9fc982d06129f9189b101fddcfa3b`.

The Pi Vim lock changed only its root version from `0.14.1` to `0.14.2`. Dependency package versions stayed unchanged. Its new source hash was `sha256-KiQYCdC6yr9PTZX2En53Eq4NT5rQ21aR+kGItRO7WbU=`; its new npm cache hash was `sha256-sMPZ+qbfaNvNjQKMlc5UEQ3RFC140HvKBSMSBKFjOz0=`.

The CodeGraph source hashes changed to:

- Wrapper: `sha256-N0u1qLNG9101uDwJY7yIjcSH0XKGBSKwv89RvXULdLA=`.
- Package: `sha256-O16z3guMKVgT5gte3z8XQ/tW4l+GHOhgArg0+fZ0h2U=`.
- Native binary: `sha256-a032dRSZ93aZH3F1iQutcKp822nEdJIrw9dnfzC7FyQ=`.

A second isolated Pi Vim preparation also passed real candidate validation: direct package build, fresh sandbox probe, extension loading, and full flake checks. It did not publish or modify repository pins.

Fresh prefetches reproduced the current pinned hashes for `superpowers` (`fetchgit`), `pi-intervals` (GitHub archive), `pi-vim` (`fetchzip`), `context-mode` (`fetchurl`), and `matrix-sdk-crypto-nodejs` (raw native archive). Thus unchanged-source no-ops did not substitute for source-hash evidence.

Parent review covered the spec map, immutable-tree guards, exact branch leases, PR ownership/reuse, token scope, workflow failure isolation, and source/lock policies. No blocker remained. The source adapters preserve Git submodule behavior and archive unpacking, confirmed by the matching live hashes. The raw Superpowers fetcher still has its `# dependency-source: superpowers` marker. Compatibility patches remain unchanged. The candidate module remains one scoped transaction pipeline; other production modules stay below 200 meaningful lines.

Evidence logs and details are in `/tmp/nightly-task8-initial-*.log`, `/tmp/nightly-task8-final-checks.json`, `/tmp/nightly-task8-rehearsal-status.json`, `/tmp/nightly-task8-detailed.json`, and `/tmp/nightly-task8-candidate-validation.log`.

Deployment Step 5 remains deferred. No production push, API write, dispatch, runner registration, secret creation, merge, or integration occurred. Local lint is not a claim of live Forgejo compatibility.

## Self-review coverage map

| Spec requirement | Tasks |
| --- | --- |
| All flake inputs, extensions, upstream skill bundles | 1–3, 7 |
| One workflow, separate PRs, coupled helper dependencies | 2–3, 6–7 |
| Stable tags/npm releases and exact commit-based pins | 3–4 |
| Correct source hashes, npm hashes, maintained locks | 1, 3–5 |
| No unrelated pin changes or compatibility-patch removal | 1–5 |
| One failed update does not block others | 5, 7–8 |
| Same base commit, bounded concurrency, overlap protection | 5–7 |
| Required Nix gates before publication | 5, 7–8 |
| No-change runs and failed candidates do not publish | 5–6 |
| Stable bot branch, PR reuse, lease-protected updates | 6 |
| Token restricted to publication and no stored checkout credentials | 6–7 |
| Runner, secret, and deployment prerequisites | 7–8 |
| Behavior tests rather than tests of static configuration | 2–6 |
| Local dry runs and final runtime checks | 8 |
