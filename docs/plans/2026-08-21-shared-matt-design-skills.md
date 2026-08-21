# Shared Matt Design Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `codebase-design` and `domain-modeling` available through the shared Pi configuration without copying or duplicating their upstream content.

**Architecture:** Link both skill directories from the existing immutable `mattpocock-skills` package into the shared `pi-config` skills directory. Extend the real Pi runtime check to prove discovery in all launch profiles and one discovered entry per skill.

**Tech Stack:** Nix, Bash build scripts, Python runtime assertions, Pi Agent Skills

## Global Constraints

- Reuse the existing pinned `mattpocock/skills` source.
- Keep the complete `mattpocock-skills` package unchanged.
- Expose only `codebase-design` and `domain-modeling` through the shared configuration.
- Preserve the complete upstream directory for each selected skill.
- Do not copy either skill into the repository-owned `skills/` directory.
- Do not change the Matt source revision, hash, wrapper selector, or routing instructions.
- Keep `domain-modeling` in its upstream American spelling.
- Load no source from the network at Pi runtime.

## File structure

- `modules/packages/pi-config.nix` builds the shared Pi resource package and adds the two immutable skill links.
- `modules/checks/pi-config-extension-load.nix` starts real Pi launch profiles and asserts their discovered skills.
- No new implementation module is needed because both changes extend focused existing modules.

---

### Task 1: Add and verify the shared Matt skills

**Files:**
- Modify: `modules/checks/pi-config-extension-load.nix:154-207`
- Modify: `modules/packages/pi-config.nix:89-107`

**Interfaces:**
- Consumes: `${piDeps.mattPocockSkills}/skills/engineering/<skill>` from `nix/packages/pi-deps.nix`.
- Produces: `${piConfig}/skills/codebase-design` and `${piConfig}/skills/domain-modeling`.
- Produces: Runtime assertions for Superpowers, Matt selector, and `pi-matt` convenience launches.

- [ ] **Step 1: Extend the runtime assertions before adding the links**

Add a uniqueness assertion to `validate_shape` in `modules/checks/pi-config-extension-load.nix`:

```python
assert len(profile["skills"]) == len(set(profile["skills"])), (
    f"{name}: skills must not contain duplicate names"
)
```

Add both selected skills to the required lists for all three profiles:

```python
require("matt-convenience", matt_convenience, [
    "codebase-design",
    "domain-modeling",
    "simple-english",
])
```

Add these entries to the existing Superpowers requirement:

```python
"codebase-design",
"domain-modeling",
```

Add the same entries to the existing Matt requirement:

```python
"codebase-design",
"domain-modeling",
```

Keep the existing forbidden-skill assertions unchanged as diagnostic spot checks. The complete Matt-package intersection assertion proves that plain Pi receives no other Matt skills.

- [ ] **Step 2: Run the runtime check and confirm the expected failure**

Run:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected result: the build fails because the Superpowers profile is missing `codebase-design` and `domain-modeling`. The Matt profiles already receive them from the complete Matt package.

- [ ] **Step 3: Add the minimal shared skill links**

In the writable skills section of `modules/packages/pi-config.nix`, add this loop after the existing external skill links:

```nix
        for skill in codebase-design domain-modeling; do
          skill_dir="${piDeps.mattPocockSkills}/skills/engineering/$skill"
          test -f "$skill_dir/SKILL.md"
          ln -s "$skill_dir" "$out/skills/$skill"
        done
```

The `test -f` command makes a changed upstream layout fail during the Nix build. The links preserve all companion files in each upstream directory.

- [ ] **Step 4: Run the focused runtime check**

Run:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected result: PASS. Each profile discovers both selected skills. The uniqueness assertion passes for Matt launches because Pi deduplicates the shared symlink and package path.

- [ ] **Step 5: Inspect the built skill links**

Run:

```sh
pi_config=$(nix build .#packages.x86_64-linux.pi-config --no-link --print-out-paths)
matt_skills=$(nix build .#packages.x86_64-linux.mattpocock-skills --no-link --print-out-paths)
for skill in codebase-design domain-modeling; do
  resolved=$(readlink -f "$pi_config/skills/$skill")
  expected="$matt_skills/skills/engineering/$skill"
  test -f "$resolved/SKILL.md"
  test "$resolved" = "$expected"
  printf '%s -> %s\n' "$skill" "$resolved"
done
```

Expected result: both commands print paths inside the existing `mattpocock-skills` store output. Both `SKILL.md` checks and path-equality checks pass.

- [ ] **Step 6: Run the required full verification**

Run:

```sh
nix build .#packages.x86_64-linux.pi-config --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

Expected result: all commands exit with status 0. The runtime check reports no extension-load errors or skill assertion errors.

No separate test will assert the source revision, hash, or literal link text. The runtime check and built-link inspection prove the required behavior.

- [ ] **Step 7: Commit the implementation**

```sh
git add modules/packages/pi-config.nix modules/checks/pi-config-extension-load.nix
git commit -m "feat(pi): share selected Matt design skills"
```
