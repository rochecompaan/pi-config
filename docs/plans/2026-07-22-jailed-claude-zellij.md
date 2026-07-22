# Jailed Claude/Zellij Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the packaged `claude-zellij-prompt` skill work from jailed Pi with the user's existing Claude subscription state and an isolated temporary Zellij server.

**Architecture:** Add the pinned Claude Code CLI and a compatible Zellij 0.44.3 package to jailed Pi, expose only Claude's three state paths, and forward `TERM`. Keep Claude inside Pi's existing jail; update the skill to create its Zellij sockets inside the same cleanup-managed temporary directory as captures.

**Tech Stack:** Nix flakes, Home Manager, jail-nix/bubblewrap, Claude Code, Zellij, jq, Pi skills.

## Global Constraints

- Work directly on `main`; the user previously declined an isolated worktree.
- Do not create a separate or nested `jailed-claude` wrapper.
- Use `inputs.llm-agents.packages.${pkgs.system}."claude-code"`.
- Use Zellij from `inputs.llm-agents.inputs.nixpkgs`, version 0.44.3 or newer; repository `pkgs.zellij` 0.43.1 is incompatible with `action list-panes --json`.
- Share `~/.claude`, `~/.claude.json`, and `~/.config/claude` read-write; do not expose broader home/config paths.
- Preserve existing packages, permissions, runtime closure paths, and user extension points.
- Continue using interactive Claude; never introduce `claude --print`, API keys, prompt rewriting, permission bypasses, or automatic UI approval.
- Do not activate Home Manager, modify Claude authentication, or run a live Claude prompt during verification.

---

## File Structure

- Modify `modules/home/jailed-pi.nix`: add package bindings, Claude state access, and `TERM` forwarding.
- Modify `skills/claude-zellij-prompt/SKILL.md`: require a compatible Zellij command surface and isolate session sockets under the temporary directory.
- No persistent automated test file: these are static Nix configuration and process guidance. The project Testing Value Gate calls for direct build/runtime checks, while `writing-skills` requires red/green pressure scenarios for the skill edit.

---

### Task 1: Add Claude and compatible Zellij to jailed Pi

**Files:**
- Modify: `modules/home/jailed-pi.nix:38-47`
- Modify: `modules/home/jailed-pi.nix:65-82`
- Modify: `modules/home/jailed-pi.nix:222-230`

**Interfaces:**
- Consumes: `inputs.llm-agents.packages.${pkgs.system}."claude-code"`, `inputs.llm-agents.inputs.nixpkgs.legacyPackages.${pkgs.system}.zellij`, and existing jail-nix combinators.
- Produces: Claude and Zellij commands in jailed Pi's PATH, shared Claude state mounts, and a forwarded `TERM`.

- [ ] **Step 1: Record the failing pre-change behavior**

Evaluate the two required package facts:

```bash
nix eval --impure --json --expr '
let f = builtins.getFlake "path:/home/roche/projects/pi/roche-pi";
in {
  repoZellij = f.inputs.nixpkgs.legacyPackages.x86_64-linux.zellij.version;
  compatibleZellij = f.inputs.llm-agents.inputs.nixpkgs.legacyPackages.x86_64-linux.zellij.version;
  claude = f.inputs.llm-agents.packages.x86_64-linux."claude-code".version;
}
'
```

Expected: repository Zellij is `0.43.1`, compatible Zellij is `0.44.3` or newer, and Claude Code has a pinned version.

Build the existing jailed Home Manager fixture and inspect its generated sandbox closure/wrapper. Expected RED evidence before the edit:

- no Claude Code closure path;
- no Zellij closure path;
- no `TERM` forwarding;
- no `~/.claude`, `~/.claude.json`, or `~/.config/claude` binds.

Use the same Home Manager fixture shape from `docs/plans/2026-07-21-jailed-pi-op-gpg.md`, with `config.allowUnfree = true`, and inspect the built closure with `nix-store --query --requisites` plus the generated `jailed-pi-sandbox` script.

- [ ] **Step 2: Add pinned package bindings**

Add these bindings after `piPackage`:

```nix
      claudePackage = inputs.llm-agents.packages.${pkgs.system}."claude-code";
      zellijPackage = inputs.llm-agents.inputs.nixpkgs.legacyPackages.${pkgs.system}.zellij;
```

- [ ] **Step 3: Add narrow state and terminal permissions**

Extend `hostCredentialPermissions` after the existing environment forwarding and Git bind:

```nix
        (try-fwd-env "TERM")
```

```nix
        (try-readwrite (noescape ''"$HOME/.claude"''))
        (try-readwrite (noescape ''"$HOME/.claude.json"''))
        (try-readwrite (noescape ''"$HOME/.config/claude"''))
```

Keep all paths optional and preserve the existing op, GnuPG, Git, and XDG runtime permissions.

- [ ] **Step 4: Add Claude and Zellij to the package list**

Change the built-in `extraPkgs` prefix to:

```nix
            extraPkgs = [
              pkgs._1password-cli
              config.programs.gpg.package
              claudePackage
              zellijPackage
            ]
```

Keep `cfg.extraPkgs` and the optional editor concatenation unchanged.

- [ ] **Step 5: Format and evaluate the module**

Run:

```bash
nix fmt -- modules/home/jailed-pi.nix
git diff --check -- modules/home/jailed-pi.nix
```

Expected: both commands exit 0.

Build the synthetic Home Manager jailed Pi package with `config.allowUnfree = true`. Expected: exit 0.

- [ ] **Step 6: Verify the built package and sandbox wrapper**

Inspect the closure and generated sandbox script. Require:

- a Claude Code closure path;
- a Zellij closure path whose version is at least 0.44.3;
- `--setenv TERM` forwarding when the caller sets it;
- optional read-write binds for all three Claude state paths;
- preservation of existing op/GnuPG/Git permissions.

Run the closure's Zellij binary with:

```bash
zellij action list-panes --help
```

Expected: exit 0 and help text documenting JSON output.

- [ ] **Step 7: Commit jailed Pi support**

```bash
git add modules/home/jailed-pi.nix
git commit -m "feat(jailed-pi): add Claude Zellij access"
```

---

### Task 2: Isolate the skill's temporary Zellij server

**Files:**
- Modify: `skills/claude-zellij-prompt/SKILL.md:10-32`
- Modify: `skills/claude-zellij-prompt/SKILL.md:50-68`

**Interfaces:**
- Consumes: `claude`, compatible `zellij`, `jq`, `mktemp`, and the caller deadline.
- Produces: an interactive Claude workflow whose Zellij session, socket, and captures share one cleanup-managed temporary root.

- [ ] **Step 1: Preserve RED pressure-scenario evidence**

The pre-edit fresh-agent baseline used an invalid/non-portable `ZELLIJ_SOCKET_NAME`, `kill-session`, `--format`, and `write` workflow instead of the repository's supported Zellij interface. Record that as the failing baseline required by `writing-skills`.

The behavior gap is specific: without explicit guidance, an agent does not reliably set both supported socket-directory variables or use the tested 0.44.3 command surface.

- [ ] **Step 2: Strengthen preconditions**

Replace the generic Zellij requirement with:

```markdown
- Require `claude`, `jq`, and Zellij with `zellij action list-panes --json` support before session creation.
```

- [ ] **Step 3: Add the private temporary socket contract**

Replace the beginning of the session example through the trap with:

```bash
set -euo pipefail
temp_dir="$(mktemp -d)"
export ZELLIJ_SOCKET_DIR="$temp_dir/zellij"
export ZELLIJ_SOCK_DIR="$ZELLIJ_SOCKET_DIR"
mkdir -p "$ZELLIJ_SOCKET_DIR"

session="pi-claude-feedback-$(date +%s)-$RANDOM"
cleanup() {
  zellij delete-session --force "$session" >/dev/null 2>&1 || true
  rm -rf "$temp_dir"
}
trap cleanup EXIT INT TERM
```

Keep the existing `attach --create-background`, `list-panes --json`, `write-chars`, `paste`, `send-keys`, `dump-screen`, timeout, and blocked-state behavior.

- [ ] **Step 4: Make capture placement explicit**

Update the prose to require all captures under `$temp_dir`, and add the private socket setup to the Quick Reference. Add a common-mistake row stating that a default/shared Zellij socket can expose unrelated sessions and must be replaced by the temporary socket directory.

Keep the skill concise and do not broaden its trigger description.

- [ ] **Step 5: Run GREEN pressure scenarios with the updated skill**

Launch a fresh `delegate` with only `claude-zellij-prompt` injected. Reuse the baseline scenario and require its command plan to:

- create `temp_dir`;
- export both `ZELLIJ_SOCKET_DIR` and `ZELLIJ_SOCK_DIR` beneath it;
- use the documented Zellij 0.44.3 commands;
- preserve the prompt;
- report blocked UI without responding;
- delete the session and temporary directory on every exit path.

Expected: the returned plan satisfies every item without inventing `ZELLIJ_SOCKET_NAME`, `kill-session`, `--format`, or `zellij action write`.

- [ ] **Step 6: Commit the skill update**

```bash
git add skills/claude-zellij-prompt/SKILL.md
git commit -m "fix(skills): isolate Claude Zellij sessions"
```

---

### Task 3: Run integrated jail and skill verification

**Files:**
- Verify: `modules/home/jailed-pi.nix`
- Verify: `skills/claude-zellij-prompt/SKILL.md`

**Interfaces:**
- Consumes: the two committed tasks.
- Produces: evidence that the skill's required tools and workflow operate inside the jail without a live Claude request.

- [ ] **Step 1: Build a direct jailed workflow probe**

Use `self.lib.${system}.mkJailedPi` with a temporary `piPackage` probe that uses the same Claude package, Zellij package, state binds, and `TERM` forwarding as the Home Manager module.

The probe must:

1. run `claude --version`, `zellij --version`, and `jq --version`;
2. confirm the three Claude state paths are visible when they exist on the host;
3. create a private temporary socket directory with both Zellij variables;
4. start a harmless background session;
5. discover a focused non-plugin pane with `list-panes --json` and jq;
6. write a shell command into that pane that records `$TERM`;
7. confirm the pane's `TERM` is not `dumb`;
8. dump the pane screen;
9. delete the session and temporary directory.

Expected: exit 0. Do not start interactive Claude beyond `claude --version`.

- [ ] **Step 2: Verify formatting and repository checks**

Run:

```bash
nix fmt -- --check modules/home/jailed-pi.nix
nix flake check --accept-flake-config --print-build-logs
git diff --check HEAD~2..HEAD
git status --short
```

Expected: all commands exit 0 and the working tree is clean.

- [ ] **Step 3: Request adversarial review**

Dispatch fresh-context `reviewer` against the implementation range. Include:

- spec: `docs/specs/2026-07-22-jailed-claude-zellij-design.md`;
- plan: `docs/plans/2026-07-22-jailed-claude-zellij.md`;
- base SHA: the plan commit;
- head SHA: current `HEAD`;
- evidence from the direct jail probe, pressure scenario, and flake checks.

Fix all Critical and Important findings, rerun focused and full verification, and commit any fixes before reporting completion.

- [ ] **Step 4: Report for user review**

Do not activate Home Manager or push. Report commits, changed files, verification evidence, reviewer assessment, and the remaining manual step: the user may test a real subscription-backed Claude prompt after applying the Home Manager configuration.
