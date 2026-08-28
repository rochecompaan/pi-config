# pi-subagents Model Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each Pi session an opt-in, session-local way to launch subagents on OpenAI or Kimi models, using repository-managed pi-subagents profile files and per-launch `model` parameters.

**Architecture:** Two profile JSON files (`openai.json`, `kimi.json`) live in `profiles/pi-subagents/` and deploy to `~/.pi/agent/profiles/pi-subagents/` through the existing Nix packaging, Home Manager, and jailed-Pi paths. A new skill, `subagent-model-profiles`, teaches the parent session to apply a profile by passing explicit `model: "provider/id:thinking"` parameters on every subagent launch. No settings file is ever written; the global `settings.json` OpenAI `agentOverrides` remain the permanent baseline.

**Tech Stack:** Nix (flake, `runCommand`, Home Manager `home.file`, activation scripts), pi-subagents 0.58.0 profile JSON schema, Pi skill format (Markdown with frontmatter).

**Spec:** `docs/specs/2026-08-27-pi-subagents-model-profiles-design.md`

## Global Constraints

- Work happens directly on `main` (explicit user directive; no worktree).
- Never write to `~/.pi/agent/settings.json` or any `.pi/settings.json` to switch models. Never run `/subagents-load-profile` except as a deliberate manual escape hatch.
- `kimi-coding/k3` and `kimi-coding/k3-256k` support only the thinking levels `low`, `high`, and `max`. Do not use `medium` or `xhigh` with them.
- The `openai.json` profile must mirror the current `settings.json` `subagents.agentOverrides` mapping exactly (same models, same thinking levels).
- No new automated tests: profile JSON and skill prompts are static content per the Testing Value Gate. Verify with the commands listed in each task.
- Commit style: Conventional Commits, e.g. `feat(pi): <summary>`. Commit only; do not push.

---

### Task 1: Profile JSON files

**Files:**
- Create: `profiles/pi-subagents/openai.json`
- Create: `profiles/pi-subagents/kimi.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `profiles/pi-subagents/openai.json` and `profiles/pi-subagents/kimi.json`, which Task 2 copies into the `pi-config` package at `profiles/pi-subagents/`. End state path on disk: `~/.pi/agent/profiles/pi-subagents/{openai,kimi}.json`.

- [ ] **Step 1: Create `profiles/pi-subagents/openai.json`**

```json
{
  "subagents": {
    "agentOverrides": {
      "scout": { "model": "openai-codex/gpt-5.6-luna", "thinking": "low" },
      "delegate": { "model": "openai-codex/gpt-5.6-luna", "thinking": "low" },
      "researcher": { "model": "openai-codex/gpt-5.6-terra", "thinking": "medium" },
      "context-builder": { "model": "openai-codex/gpt-5.6-terra", "thinking": "medium" },
      "planner": { "model": "openai-codex/gpt-5.6-sol", "thinking": "xhigh" },
      "worker": { "model": "openai-codex/gpt-5.6-terra", "thinking": "high" },
      "reviewer": { "model": "openai-codex/gpt-5.6-sol", "thinking": "xhigh" },
      "oracle": { "model": "openai-codex/gpt-5.6-sol", "thinking": "high" }
    }
  }
}
```

- [ ] **Step 2: Create `profiles/pi-subagents/kimi.json`**

```json
{
  "subagents": {
    "agentOverrides": {
      "advisor": { "model": "kimi-coding/k3", "thinking": "high" },
      "context-builder": { "model": "kimi-coding/k3", "thinking": "high" },
      "delegate": { "model": "kimi-coding/k3-256k", "thinking": "low" },
      "mechanical-worker": { "model": "kimi-coding/k3-256k", "thinking": "low" },
      "oracle": { "model": "kimi-coding/k3", "thinking": "high" },
      "planner": { "model": "kimi-coding/k3", "thinking": "max" },
      "researcher": { "model": "kimi-coding/k3-256k", "thinking": "high" },
      "reviewer": { "model": "kimi-coding/k3", "thinking": "max" },
      "scout": { "model": "kimi-coding/k3-256k", "thinking": "low" },
      "worker": { "model": "kimi-coding/k3", "thinking": "high" }
    }
  }
}
```

- [ ] **Step 3: Validate both files parse as JSON**

Run:

```bash
python3 -m json.tool profiles/pi-subagents/openai.json > /dev/null \
  && python3 -m json.tool profiles/pi-subagents/kimi.json > /dev/null \
  && echo OK
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add profiles/pi-subagents/openai.json profiles/pi-subagents/kimi.json
git commit -m "feat(pi): add openai and kimi subagent model profiles"
```

---

### Task 2: Ship the profiles in the `pi-config` package and resources

**Files:**
- Modify: `modules/packages/pi-config.nix` (inside the `piConfig` `runCommand`, after the `multi-model-planning-teams` copy line)
- Modify: `nix/lib/pi-resources.nix` (let bindings, `resourcesPackage` `runCommand`, and the export attrset)

**Interfaces:**
- Consumes: `profiles/pi-subagents/{openai,kimi}.json` from Task 1.
- Produces: `piResources.subagentProfiles` (store path containing `openai.json` and `kimi.json`), used by Task 3. `piResources.package` gains a `profiles/pi-subagents` entry, also used by Task 3.

- [ ] **Step 1: Copy the profiles into the `pi-config` package**

In `modules/packages/pi-config.nix`, find this exact line inside the `piConfig` `runCommand`:

```nix
        cp -r ${../../multi-model-planning-teams} "$out/multi-model-planning-teams"
```

Insert immediately after it:

```nix
        mkdir -p "$out/profiles"
        cp -r ${../../profiles}/pi-subagents "$out/profiles/pi-subagents"
```

- [ ] **Step 2: Export `subagentProfiles` from `pi-resources.nix`**

In `nix/lib/pi-resources.nix`, find this let binding:

```nix
  skills = "${package}/skills";
```

Insert immediately after it:

```nix
  subagentProfiles = "${package}/profiles/pi-subagents";
```

- [ ] **Step 3: Link the profiles into `resourcesPackage`**

In the same file, find the start of the `resourcesPackage` `runCommand`:

```nix
  resourcesPackage = pkgs.runCommand "roche-pi-resources" { } ''
    mkdir -p "$out"
```

Change `mkdir -p "$out"` to:

```nix
    mkdir -p "$out" "$out/profiles"
```

Then find the last link in that script:

```nix
    ln -s ${package}/node_modules "$out/node_modules"
```

Insert immediately after it:

```nix
    ln -s ${package}/profiles/pi-subagents "$out/profiles/pi-subagents"
```

- [ ] **Step 4: Export the new binding**

In the same file, find the export attrset:

```nix
  inherit
    claudeBridgeJson
    dashboardConfigJson
    extensions
    mcpJson
    multiModelPlanningTeams
    resourcesPackage
    settingsJson
    skills
    themes
    ;
```

Change it to include `subagentProfiles` between `skills` and `themes`:

```nix
  inherit
    claudeBridgeJson
    dashboardConfigJson
    extensions
    mcpJson
    multiModelPlanningTeams
    resourcesPackage
    settingsJson
    skills
    subagentProfiles
    themes
    ;
```

- [ ] **Step 5: Build the package and confirm the profiles landed**

Run:

```bash
out=$(nix build .#packages.x86_64-linux.pi-config --no-link --print-out-paths | tail -1)
ls "$out/profiles/pi-subagents"
```

Expected output:

```text
kimi.json
openai.json
```

- [ ] **Step 6: Commit**

```bash
git add modules/packages/pi-config.nix nix/lib/pi-resources.nix
git commit -m "feat(pi): ship subagent profiles in pi-config package"
```

---

### Task 3: Link the profiles into the Home Manager and jailed agent directories

**Files:**
- Modify: `modules/home/pi.nix` (the `home.file` attrset)
- Modify: `modules/home/jailed-pi.nix` (the `home.activation.jailedPiAgentDir` script)

**Interfaces:**
- Consumes: `piResources.subagentProfiles` and `piResources.package` (with `profiles/pi-subagents`) from Task 2.
- Produces: `~/.pi/agent/profiles/pi-subagents` and `<jailed-agent-dir>/profiles/pi-subagents` symlinks after the user's next Home Manager activation.

- [ ] **Step 1: Add the Home Manager `home.file` entry**

In `modules/home/pi.nix`, find this line inside `home.file`:

```nix
          ".pi/agent/multi-model-planning-teams".source = piResources.multiModelPlanningTeams;
```

Insert immediately after it:

```nix
          ".pi/agent/profiles/pi-subagents".source = piResources.subagentProfiles;
```

- [ ] **Step 2: Add the jailed activation link**

In `modules/home/jailed-pi.nix`, find this line inside the `home.activation.jailedPiAgentDir` script:

```nix
          ln -sfnT ${piResources.package}/multi-model-planning-teams "$agent_dir/multi-model-planning-teams"
```

Insert immediately after it:

```nix
          mkdir -p "$agent_dir/profiles"
          ln -sfnT ${piResources.package}/profiles/pi-subagents "$agent_dir/profiles/pi-subagents"
```

- [ ] **Step 3: Run the runtime extension-load check**

Run:

```bash
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: build succeeds, no `Failed to load extension`, `No such built-in module`, or `Cannot find package` errors.

- [ ] **Step 4: Run the full flake check**

Run:

```bash
nix flake check --accept-flake-config --print-build-logs
```

Expected: all checks pass.

- [ ] **Step 5: Commit**

```bash
git add modules/home/pi.nix modules/home/jailed-pi.nix
git commit -m "feat(pi): link subagent profiles into agent directories"
```

---

### Task 4: The `subagent-model-profiles` skill

**Files:**
- Create: `skills/subagent-model-profiles/SKILL.md`

**Interfaces:**
- Consumes: the deployed profiles at `~/.pi/agent/profiles/pi-subagents/<name>.json` (Tasks 1-3).
- Produces: a skill the parent session reads when the user asks to switch subagent models. The existing `cp -r ${../../skills} "$out/skills"` in `pi-config.nix` packages it automatically; no Nix changes.

- [ ] **Step 1: Create `skills/subagent-model-profiles/SKILL.md`**

```markdown
---
name: subagent-model-profiles
description: Use when the user asks to switch subagent models for the current session - "use kimi", "switch subagents to kimi", "use openai", "back to defaults". Applies a named pi-subagents profile to this session's subagent launches without changing global settings.
---

# Subagent model profiles

Profiles live at `~/.pi/agent/profiles/pi-subagents/<name>.json`. Each file maps
subagent roles to `{ "model": "provider/id", "thinking": "<level>" }` under
`subagents.agentOverrides`.

Available profiles: `openai`, `kimi`. OpenAI is the global baseline: with no
active profile, launches already use the OpenAI mapping from global settings.

## Rules

- Never run `/subagents-load-profile`. It rewrites the global settings and
  affects every open session.
- Never edit `settings.json` or `.pi/settings.json` to switch subagent models.

## Applying a profile

When the user activates a profile:

1. Read `~/.pi/agent/profiles/pi-subagents/<name>.json`. If the file is missing
   or invalid, stop, report the problem, and suggest a Home Manager rebuild or
   `/subagents-check-profile <name>`.
2. Keep the mapping active for the rest of the session, or until the user
   switches profiles or deactivates.
3. On every subagent launch, pass the launched role's entry as the model
   argument in the form `provider/id:thinking`:
   - single launch: the `model` parameter
   - parallel tasks: each task's `model` parameter
   - chains: each step's `model` parameter
4. For roles the profile does not list, pass no model parameter. Baseline
   behavior applies to them.

## Switching and deactivating

- "use openai" after another profile: apply `openai.json` the same way.
- "back to defaults" or "stop the profile": stop passing per-launch models.
  The global OpenAI baseline takes over.

## Notes

- Already-running subagents keep their model. The profile affects new launches.
- Status and model listings show the global baseline, not the session profile.
  Verify the active profile through launch results.
- Session compaction can drop the active profile. Recover it from the
  conversation when visible; otherwise ask the user to restate it.
```

- [ ] **Step 2: Confirm the skill is packaged**

Run:

```bash
out=$(nix build .#packages.x86_64-linux.pi-config --no-link --print-out-paths | tail -1)
test -f "$out/skills/subagent-model-profiles/SKILL.md" && echo OK
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add skills/subagent-model-profiles/SKILL.md
git commit -m "feat(pi): add subagent-model-profiles skill"
```

---

### Task 5: Final verification

No new files. No commit. Automated checks run here; the live session checks are for the user (or an interactive session) after the next Home Manager activation.

- [ ] **Step 1: Re-run the extension-load check and full flake check**

```bash
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

Expected: both pass.

- [ ] **Step 2 (user-side, after Home Manager activation): validate the profiles**

In any Pi session, run:

```text
/subagents-check-profile openai
/subagents-check-profile kimi
```

Expected: both profiles validate.

- [ ] **Step 3 (user-side): smoke-test session-local isolation**

In one Pi session, say "use kimi", then launch a `scout` subagent. Expected: the run reports `kimi-coding/k3-256k`.

In a second, concurrent Pi session (no activation), launch a `scout` subagent. Expected: the run reports `openai-codex/gpt-5.6-luna`.

This proves the profile is session-local and the global baseline is untouched.
