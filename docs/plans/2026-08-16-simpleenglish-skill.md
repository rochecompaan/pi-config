# SimpleEnglish Skill Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package AminBlg/SimpleEnglish release `v1.2.0` as an immutable, shared Pi Agent Skill and prove that Pi discovers it through the Superpowers, Matt, and `pi-matt` launch profiles.

**Architecture:** Fetch the upstream Git tag once through Nix, export the fixed-output source from `pi-deps.nix`, and link the complete upstream `skills/simple-english` directory into `${piConfig}/skills/simple-english`. Keep the existing shared-resource propagation unchanged because `pi-resources.nix` already exports `${package}/skills`; extend the existing runtime probe so all three required launch paths must discover `simple-english`.

**Tech Stack:** Nix/flake-parts, `pkgs.fetchgit`, `pkgs.runCommand`, Pi native `SKILL.md` discovery, Python assertions embedded in the runtime Nix check, Git.

## Global Constraints

- Work only in `/home/roche/projects/pi/roche-pi/.worktrees/simpleenglish-skill` on branch `feat/simpleenglish-skill`.
- Pin upstream release `v1.2.0` from `https://github.com/AminBlg/SimpleEnglish.git` with fixed SRI hash `sha256-62IdviEpLgMXYzJwjdM6G7VVJtyaAHGhQGHw2oFCAHE=`.
- The tag resolves to commit `eaa7fded155ad47e5baa072ebae4c70d1254e9e2`; the equivalent Nix base32 hash is `0w808a0xmw3182hp204svhk5bd8v7b9qsw1jccbh6bi946z1sqpb`.
- Install the complete upstream `skills/simple-english` directory, including `SKILL.md`, `references/checklist.md`, and `references/use-cases.md`.
- Expose the skill only as `${piConfig}/skills/simple-english` and use Pi's native `SKILL.md` discovery.
- Keep the skill available through the existing shared resource path for `pi`, `pi-matt`, jailed Pi, project Pi resources, and eligible subagents.
- Do not use `npx skills add`, vendor upstream files, add the repository as an extension, or copy the standalone system prompt into `AGENTS.md` or wrapper prompts.
- Do not change existing role settings that control automatic skill inheritance; explicit skill injection remains available.
- Do not modify `nix/lib/pi-resources.nix` unless implementation evidence disproves the inspected propagation path `skills = "${package}/skills"`.
- Do not add a test that merely restates source values or Nix link text. The existing runtime discovery check supplies meaningful behavioral coverage; use direct build and store-path inspection for static packaging details.
- Do not push or merge.

---

## Planned File Structure

### New files

- None. Upstream content remains in its fetched Nix store source and is not vendored.

### Modified files

- `nix/packages/pi-deps.nix` — define and export the pinned `simpleEnglishSrc` fixed-output source.
- `modules/packages/pi-config.nix` — link the complete upstream skill directory into the packaged Pi skills directory.
- `modules/checks/pi-config-extension-load.nix` — require runtime discovery of `simple-english` in Superpowers, Matt selector mode, and the `pi-matt` convenience launch.

### Intentionally unchanged files

- `nix/lib/pi-resources.nix` — already exports the complete `${package}/skills` directory to Home Manager, jailed Pi, and project resources.
- `AGENTS.md` and wrapper prompt files — Pi must load SimpleEnglish only through native skill discovery.

---

### Task 1: Make runtime discovery require SimpleEnglish

**Files:**
- Modify: `modules/checks/pi-config-extension-load.nix:164-200`

**Interfaces:**
- Consumes: JSON probe output whose `skills` field is a sorted list of discovered skill names.
- Produces: Runtime assertions that reject any Superpowers, Matt, or `pi-matt` launch missing `simple-english`.

- [ ] **Step 1: Add `simple-english` to the Superpowers requirement**

Add the exact skill name to the existing Superpowers `require` list:

```python
require("superpowers", superpowers, [
    "using-superpowers",
    "writing-plans",
    "test-driven-development",
    "pi-subagents",
    "context-mode",
    "intervals-time-entries",
    "simple-english",
])
```

- [ ] **Step 2: Add `simple-english` to the Matt requirement**

Add the same exact skill name to the existing Matt selector-mode list:

```python
require("matt", matt, [
    "tdd",
    "implement",
    "code-review",
    "pi-subagents",
    "context-mode",
    "intervals-time-entries",
    "simple-english",
])
```

- [ ] **Step 3: Add an explicit `pi-matt` convenience-launch requirement**

Keep the full profile equality assertion, then make the required skill visible in the failure message for the convenience launch itself:

```python
assert matt_convenience == matt, "pi-matt resources differ from Matt selector mode"
require("matt-convenience", matt_convenience, ["simple-english"])
```

- [ ] **Step 4: Run the focused runtime check and verify RED**

Run:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected result before package wiring: the derivation fails because at least the Superpowers profile is missing `simple-english`. Confirm the failure is the new missing-skill assertion, not an extension-loading or provider error.

- [ ] **Step 5: Review the focused assertion diff**

Run:

```sh
git diff -- modules/checks/pi-config-extension-load.nix
git diff --check
```

Expected result: only the three intended runtime requirements changed, and `git diff --check` exits zero.

---

### Task 2: Pin and package the complete upstream skill

**Files:**
- Modify: `nix/packages/pi-deps.nix:107-125,218-234`
- Modify: `modules/packages/pi-config.nix:82-101`
- Verify unchanged: `nix/lib/pi-resources.nix:57-88`

**Interfaces:**
- Consumes: AminBlg/SimpleEnglish tag `v1.2.0`, resolved commit `eaa7fded155ad47e5baa072ebae4c70d1254e9e2`, and SRI source hash `sha256-62IdviEpLgMXYzJwjdM6G7VVJtyaAHGhQGHw2oFCAHE=`.
- Produces: `piDeps.simpleEnglishSrc` and `${piConfig}/skills/simple-english`, preserving upstream-relative references.

- [ ] **Step 1: Reproduce the upstream source hash and file inventory**

Run:

```sh
prefetch_json="$(mktemp)"
nix-prefetch-git \
  --url https://github.com/AminBlg/SimpleEnglish.git \
  --rev v1.2.0 \
  | tee "$prefetch_json"
source_path="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["path"])' "$prefetch_json")"
```

Expected JSON fields:

```text
"rev": "eaa7fded155ad47e5baa072ebae4c70d1254e9e2"
"sha256": "0w808a0xmw3182hp204svhk5bd8v7b9qsw1jccbh6bi946z1sqpb"
```

Convert the hash to the repository's SRI form:

```sh
nix hash convert \
  --hash-algo sha256 \
  --to sri \
  0w808a0xmw3182hp204svhk5bd8v7b9qsw1jccbh6bi946z1sqpb
```

Expected output:

```text
sha256-62IdviEpLgMXYzJwjdM6G7VVJtyaAHGhQGHw2oFCAHE=
```

Inspect the prefetched source path printed by `nix-prefetch-git` and require all three files:

```sh
test -f "$source_path/skills/simple-english/SKILL.md"
test -f "$source_path/skills/simple-english/references/checklist.md"
test -f "$source_path/skills/simple-english/references/use-cases.md"
```

- [ ] **Step 2: Define the fixed-output source**

Add this source next to the other externally fetched skill sources in `nix/packages/pi-deps.nix`:

```nix
simpleEnglishSrc = pkgs.fetchgit {
  url = "https://github.com/AminBlg/SimpleEnglish.git";
  rev = "v1.2.0";
  sha256 = "sha256-62IdviEpLgMXYzJwjdM6G7VVJtyaAHGhQGHw2oFCAHE=";
};
```

A fetched source is sufficient because this integration reads static skill files and has no runtime package dependencies.

- [ ] **Step 3: Export `simpleEnglishSrc` from `piDeps`**

Add `simpleEnglishSrc` to the sorted `inherit` block returned by `nix/packages/pi-deps.nix`:

```nix
inherit
  codegraphCli
  contextMode
  diffPackage
  mattPocockSkills
  mattPocockSkillsSrc
  piCodegraph
  piListen
  piMessengerBridge
  piRemote
  piSubagents
  piVim
  simpleEnglishSrc
  superpowersSrc
  ;
```

- [ ] **Step 4: Link the complete skill directory into `piConfig`**

In `modules/packages/pi-config.nix`, add one store symlink after `chmod u+w "$out/extensions" "$out/skills"`:

```nix
ln -s ${piDeps.simpleEnglishSrc}/skills/simple-english "$out/skills/simple-english"
```

Keep the destination explicit. Do not copy individual files. Plain `ln -s` must fail if a repository-owned skill already occupies the same name, preventing silent replacement.

- [ ] **Step 5: Confirm shared-resource propagation needs no edit**

Inspect `nix/lib/pi-resources.nix` and confirm these existing definitions remain unchanged:

```nix
skills = "${package}/skills";
```

```nix
ln -s ${skills} "$out/skills"
```

This proves that adding the link to `piConfig` propagates through the existing Home Manager, jailed Pi, project-resource, and eligible-subagent paths without wrapper-specific wiring.

- [ ] **Step 6: Build the Pi configuration with the pinned hash**

Run the required package build exactly:

```sh
nix build .#packages.x86_64-linux.pi-config --no-link
```

Expected result: exit zero. A wrong source hash or missing upstream path must fail this build.

- [ ] **Step 7: Inspect the built store path and all required files**

Resolve the output and verify the symlink plus its complete referenced content:

```sh
pi_config="$({ nix build .#packages.x86_64-linux.pi-config --no-link --print-out-paths; } | tail -n 1)"
test -L "$pi_config/skills/simple-english"
test -f "$pi_config/skills/simple-english/SKILL.md"
test -f "$pi_config/skills/simple-english/references/checklist.md"
test -f "$pi_config/skills/simple-english/references/use-cases.md"
readlink -f "$pi_config/skills/simple-english"
```

Expected result: all `test` commands exit zero and `readlink -f` resolves below the fetched SimpleEnglish Nix store source.

- [ ] **Step 8: Run the focused runtime check and verify GREEN**

Run:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected result: exit zero, proving Pi discovers `simple-english` in Superpowers, Matt selector mode, and `pi-matt` convenience mode while still loading extensions successfully.

- [ ] **Step 9: Review the implementation diff**

Run:

```sh
git diff -- nix/packages/pi-deps.nix modules/packages/pi-config.nix modules/checks/pi-config-extension-load.nix
git diff --check
```

Expected result: the diff contains one fetched source, one exported attribute, one complete-directory link, and the three discovery requirements. No vendored SimpleEnglish files, prompt edits, extension path, or `pi-resources.nix` change appears.

---

### Task 3: Run the completion contract, obtain independent review, and commit

**Files:**
- Verify: `docs/specs/2026-08-16-simpleenglish-skill-design.md`
- Verify: `docs/plans/2026-08-16-simpleenglish-skill.md`
- Verify: `nix/packages/pi-deps.nix`
- Verify: `modules/packages/pi-config.nix`
- Verify: `modules/checks/pi-config-extension-load.nix`

**Interfaces:**
- Consumes: The candidate worktree diff, approved design, this plan, and required Nix flake outputs.
- Produces: Fresh verification evidence, independent review findings with valid issues resolved, and one final implementation commit without push or merge.

- [ ] **Step 1: Run all required verification commands from a fresh invocation**

Run each command without relying on an earlier result:

```sh
nix build .#packages.x86_64-linux.pi-config --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
git diff --check
```

Expected result: every command exits zero. Capture each exit status and any failure summary before making a completion claim.

- [ ] **Step 2: Reinspect the packaged file inventory after the fresh builds**

Run:

```sh
pi_config="$({ nix build .#packages.x86_64-linux.pi-config --no-link --print-out-paths; } | tail -n 1)"
for path in \
  skills/simple-english/SKILL.md \
  skills/simple-english/references/checklist.md \
  skills/simple-english/references/use-cases.md
do
  test -f "$pi_config/$path"
  printf 'present: %s\n' "$path"
done
```

Expected result: all three `present:` lines print and the command exits zero.

- [ ] **Step 3: Check the candidate branch scope before review**

Run:

```sh
git status --short
git diff --stat
git diff -- docs/specs/2026-08-16-simpleenglish-skill-design.md
git diff -- AGENTS.md
```

Expected result: only the plan and three intended implementation files differ from the plan commit; the approved spec and `AGENTS.md` have no uncommitted changes.

- [ ] **Step 4: Request an independent fresh-context review**

Resolve and dispatch the canonical Pi `reviewer` with fresh context. Give it:

- Description: package AminBlg/SimpleEnglish `v1.2.0` as a shared native Pi skill and extend runtime discovery checks.
- Requirements: the approved design at `docs/specs/2026-08-16-simpleenglish-skill-design.md` and this plan.
- Base reference: the committed implementation-plan SHA.
- Candidate head: the uncommitted working tree diff from that base.
- Scope: source pin/hash, complete-directory packaging, shared propagation, explicit Superpowers/Matt/`pi-matt` assertions, exclusions, and verification evidence.
- Review mode: read-only, adversarial, fresh context; report only actionable findings with severity and file/line evidence.

- [ ] **Step 5: Assess and address every review finding**

For each finding:

1. Re-read the cited code and requirement.
2. Reproduce the concern with the narrowest direct command when possible.
3. Fix Critical and Important findings that are technically valid.
4. Fix Minor findings when they improve correctness or clarity without expanding scope.
5. Reject incorrect findings with concrete code or command evidence rather than agreement language.

Do not dispatch another writing agent into this shared worktree. Keep one writer and make any accepted fixes directly.

- [ ] **Step 6: Re-run the full verification contract after review fixes**

Run again, even if the reviewer found nothing:

```sh
nix build .#packages.x86_64-linux.pi-config --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
git diff --check
```

Then repeat the three-file packaged inventory loop from Step 2. Expected result: every command exits zero and all required files remain present.

- [ ] **Step 7: Stage and inspect only the intended implementation files**

Run:

```sh
git add \
  nix/packages/pi-deps.nix \
  modules/packages/pi-config.nix \
  modules/checks/pi-config-extension-load.nix
git status --short
git diff --cached --check
git diff --cached --stat
```

Expected result: exactly the three implementation files are staged, the plan is already committed, and the cached diff check exits zero.

- [ ] **Step 8: Commit the verified implementation**

Run:

```sh
git commit -m "feat(pi): add SimpleEnglish skill"
```

Do not push or merge.

- [ ] **Step 9: Record final branch evidence**

Run:

```sh
git status --short --branch
git log -3 --oneline
```

Expected result: a clean `feat/simpleenglish-skill` branch whose latest commits are the implementation commit, the implementation-plan commit, and spec commit `69d9a82`.
