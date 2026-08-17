# Show Me Skill Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendor HumanLayer's `show-me` skill unchanged under `skills/show-me` and prove that the packaged Pi configuration discovers it.

**Architecture:** Add the upstream `SKILL.md` as a repository-owned static skill file. Rely on the existing recursive copy of `./skills` in `modules/packages/pi-config.nix`; do not add a Nix source, external symlink, wrapper command, or prompt injection.

**Tech Stack:** Agent Skills `SKILL.md`, GitHub CLI, Nix/flake-parts, Pi native skill discovery, Git.

## Global Constraints

- Work only in `/home/roche/projects/pi/roche-pi/.worktrees/show-me-skill` on branch `feat/show-me-skill`.
- Use the approved design at `docs/specs/2026-08-17-show-me-skill-design.md`.
- Copy <https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md> unchanged at implementation time.
- Create only `skills/show-me/SKILL.md` for the implementation unless verification reveals a requirement that cannot be met within the approved design.
- Do not add a Nix fetcher, upstream revision pin, external skill symlink, wrapper command, supporting file, or system-prompt text.
- Do not rewrite the upstream `open` command for Linux; the known portability limitation is accepted.
- Do not add an automated test that restates the static file contents or existing Nix copy statement. Use direct source comparison, package inspection, and runtime discovery verification.
- Keep temporary upstream files outside the repository and never stage them.
- Do not push or merge.

---

## Planned File Structure

### New file

- `skills/show-me/SKILL.md` — unchanged vendored copy of HumanLayer's visual-explanation skill.

### Existing files used without modification

- `modules/packages/pi-config.nix` — already copies the complete repository `skills` directory into the Pi configuration package.
- `nix/check-support/pi-skillset-probe.ts` — reports the skill names Pi discovers during direct runtime verification.
- `modules/checks/pi-config-extension-load.nix` — exercises packaged Pi startup, extensions, and skill scanning.

---

### Task 1: Vendor and package the upstream skill

**Files:**
- Create: `skills/show-me/SKILL.md`
- Verify unchanged: `modules/packages/pi-config.nix`

**Interfaces:**
- Consumes: The raw GitHub Contents API response for `plugins/show-me/skills/show-me/SKILL.md` on the upstream `main` branch.
- Produces: A UTF-8 Agent Skill file whose frontmatter declares `name: show-me`, available at `${piConfig}/skills/show-me/SKILL.md` after the package build.

- [ ] **Step 1: Confirm the implementation worktree is clean**

Run:

```sh
pwd
git branch --show-current
git status --short
```

Expected result:

```text
/home/roche/projects/pi/roche-pi/.worktrees/show-me-skill
feat/show-me-skill
```

`git status --short` must print nothing. If it lists unrelated files, stop and resolve them before continuing.

- [ ] **Step 2: Fetch the current upstream file outside the repository**

Run:

```sh
upstream=/tmp/humanlayer-show-me-SKILL.md
rm -f "$upstream"
gh api \
  -H 'Accept: application/vnd.github.raw+json' \
  repos/humanlayer/skills/contents/plugins/show-me/skills/show-me/SKILL.md \
  > "$upstream"

test -s "$upstream"
grep -Fxq -- '---' "$upstream"
grep -Fxq 'name: show-me' "$upstream"
grep -Fq 'description:' "$upstream"
```

Expected result: every command exits zero. The temporary file is non-empty and contains the required Agent Skill frontmatter.

- [ ] **Step 3: Copy the upstream file unchanged into the repository**

Run:

```sh
upstream=/tmp/humanlayer-show-me-SKILL.md
mkdir -p skills/show-me
install -m 0644 "$upstream" skills/show-me/SKILL.md
cmp -s "$upstream" skills/show-me/SKILL.md
```

Expected result: `skills/show-me/SKILL.md` exists and `cmp` exits zero, proving the repository copy is byte-for-byte identical to the fetched upstream file.

- [ ] **Step 4: Inspect the new file and confirm implementation scope**

Run:

```sh
test -f skills/show-me/SKILL.md
test "$(find skills/show-me -maxdepth 1 -type f -printf '%f\n')" = "SKILL.md"
git status --short

set +e
git diff --no-index --check /dev/null skills/show-me/SKILL.md
rc=$?
set -e
test "$rc" -eq 1
```

Expected result: the directory contains only `SKILL.md`; Git reports only `?? skills/show-me/`; and the no-index whitespace check returns `1` only because the file is new, with no whitespace errors.

Do not edit `SKILL.md` during review. If its content is wrong, fetch the requested upstream file again and replace the whole copy.

- [ ] **Step 5: Build and inspect the focused Pi configuration package**

Run:

```sh
pi_config="$({
  nix build \
    .#packages.x86_64-linux.pi-config \
    --no-link \
    --print-out-paths
} | tail -n 1)"

test -f "$pi_config/skills/show-me/SKILL.md"
cmp -s skills/show-me/SKILL.md "$pi_config/skills/show-me/SKILL.md"
printf 'packaged skill: %s\n' "$pi_config/skills/show-me/SKILL.md"
```

Expected result: the build exits zero, the packaged skill exists, and `cmp` proves that Nix copied the repository file unchanged.

- [ ] **Step 6: Remove the temporary upstream file**

Run:

```sh
rm -f /tmp/humanlayer-show-me-SKILL.md
test ! -e /tmp/humanlayer-show-me-SKILL.md
```

Expected result: the temporary file is removed and cannot be staged accidentally.

- [ ] **Step 7: Stage and commit only the skill file**

Run:

```sh
git add skills/show-me/SKILL.md
git status --short
git diff --cached --check
git diff --cached --stat
git commit -m "feat(pi): add show-me skill"
```

Expected result: only `skills/show-me/SKILL.md` is staged, the cached diff check exits zero, and the implementation commit succeeds. Do not stage the spec or plan because both were committed before execution.

---

### Task 2: Verify runtime discovery and complete the branch

**Files:**
- Verify: `skills/show-me/SKILL.md`
- Verify unchanged: `modules/packages/pi-config.nix`
- Verify unchanged: `nix/check-support/pi-skillset-probe.ts`
- Verify unchanged: `modules/checks/pi-config-extension-load.nix`

**Interfaces:**
- Consumes: The committed repository skill and the existing Pi configuration/resource packages.
- Produces: Fresh evidence that Pi discovers `show-me`, existing runtime checks pass, the full flake remains valid, and an independent reviewer finds no unresolved actionable issue.

- [ ] **Step 1: Run a direct Pi skill-discovery probe**

Run:

```sh
pi_config="$({
  nix build \
    .#packages.x86_64-linux.pi-config \
    --no-link \
    --print-out-paths
} | tail -n 1)"
pi_package="$({
  nix build \
    .#packages.x86_64-linux.pi \
    --no-link \
    --print-out-paths
} | tail -n 1)"
probe_output="$(mktemp)"
probe_home="$(mktemp -d)"
agent_dir="$probe_home/.pi/agent"
mkdir -p "$agent_dir"

for resource in \
  AGENTS.md \
  settings.json \
  mcp.json \
  extensions \
  agents \
  multi-model-planning-teams \
  skills \
  themes \
  node_modules
do
  ln -s "$pi_config/$resource" "$agent_dir/$resource"
done

HOME="$probe_home" \
PI_SKILLSET_PROBE_OUTPUT="$probe_output" \
"$pi_package/bin/pi" \
  --no-session \
  --no-tools \
  --extension "$PWD/nix/check-support/pi-skillset-probe.ts" \
  -p /write-skillset-probe

python3 - "$probe_output" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    profile = json.load(f)

assert "show-me" in profile["skills"], profile["skills"]
print("discovered skill: show-me")
PY

rm -rf "$probe_output" "$probe_home"
```

Expected result: Pi exits zero before any provider request and Python prints `discovered skill: show-me`.

- [ ] **Step 2: Run the required runtime extension-load check**

Run:

```sh
nix build \
  .#checks.x86_64-linux.pi-config-extension-load \
  --no-link
```

Expected result: exit zero with no `Failed to load extension`, `No such built-in module`, or `Cannot find package` regression.

- [ ] **Step 3: Run the full completion verification**

Run:

```sh
nix build .#packages.x86_64-linux.pi-config --no-link
nix flake check --accept-flake-config --print-build-logs
git diff --check
git status --short --branch
```

Expected result: every command exits zero and the branch is clean after the implementation commit.

- [ ] **Step 4: Request an independent fresh-context review**

Resolve and dispatch the canonical Pi `reviewer` with fresh context. Provide:

- Description: vendor HumanLayer's `show-me` `SKILL.md` unchanged under the repository-owned `skills` directory.
- Requirements: `docs/specs/2026-08-17-show-me-skill-design.md` and this implementation plan.
- Base reference: the implementation-plan commit SHA.
- Candidate head: the current implementation commit SHA.
- Scope: exact upstream copy, repository path, existing package propagation, accepted unchanged Linux `open` command, exclusion of Nix fetchers/pins and prompt edits, and verification evidence.
- Review mode: read-only and adversarial; report only actionable findings with severity and file/line evidence.

- [ ] **Step 5: Assess and address every review finding**

For each finding:

1. Re-read the cited requirement and file.
2. Reproduce the concern with the narrowest direct command.
3. Fix valid Critical or Important findings without expanding beyond the approved design.
4. Fix valid Minor findings only when they improve correctness or clarity.
5. Reject incorrect findings with concrete file or command evidence.

If a fix changes `skills/show-me/SKILL.md`, replace it from the requested upstream source and re-run the byte comparison before committing. Commit valid review fixes separately with a concise Conventional Commits message. Do not amend or push.

- [ ] **Step 6: Re-run verification after review**

Repeat the direct runtime probe from Step 1, then run:

```sh
nix build .#packages.x86_64-linux.pi-config --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
git diff --check
git status --short --branch
git log -4 --oneline --decorate
```

Expected result: Pi again reports `show-me`, every Nix command exits zero, the worktree is clean, and the branch history contains the spec, plan, and implementation commits plus any justified review-fix commit.
