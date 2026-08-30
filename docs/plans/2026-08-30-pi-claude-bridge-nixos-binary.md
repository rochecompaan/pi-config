# pi-claude-bridge NixOS Binary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Claude executable bundled with `pi-claude-bridge` run on NixOS and fail the package build if that runtime behavior regresses.

**Architecture:** Keep the Agent SDK's bundled Claude Code version. Extend the existing `piClaudeBridge` `buildNpmPackage` derivation with Nix's ELF auto-patching hook and its runtime library input, then execute the installed binary during `installCheckPhase`, after fixup hooks have run, as the regression check.

**Tech Stack:** Nix, `buildNpmPackage`, `autoPatchelfHook`, Claude Agent SDK 0.2.141, Claude Code 2.1.141, Pi runtime checks

## Global Constraints

- Modify only `nix/packages/pi-deps.nix` during implementation.
- Keep `pi-claude-bridge` at version 0.7.0 and Agent SDK 0.2.141.
- Keep the SDK's bundled Claude executable; do not set `provider.pathToClaudeCodeExecutable`.
- Do not change `claude-bridge.json`, package locks, upstream bridge source, or the default Pi provider and model.
- Do not enable or depend on `nix-ld`.
- Preserve support for the Home Manager, project, and jailed Pi launch paths.
- Run the required runtime extension-load check and full flake check before completion.

---

### Task 1: Patch and test the bundled Claude executable

**Files:**
- Modify: `nix/packages/pi-deps.nix:66-85`
- Test: build-time `installCheckPhase` check in the same derivation

**Interfaces:**
- Consumes: The installed executable at `$out/lib/node_modules/pi-claude-bridge/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`.
- Produces: A `piClaudeBridge` store output whose bundled executable uses Nix store runtime paths and reports `2.1.141 (Claude Code)`.

- [ ] **Step 1: Add the failing build-time runtime check**

Add these attributes to `piClaudeBridge` after `postPatch`, without adding patch inputs yet:

```nix
      doInstallCheck = true;
      installCheckPhase = ''
        claude="$out/lib/node_modules/pi-claude-bridge/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"
        claudeVersion="$("$claude" --version)" || exit $?
        test "$claudeVersion" = "2.1.141 (Claude Code)"
      '';
```

Use `installCheckPhase` because `autoPatchelfHook` runs through `postFixupHooks`, after literal `postFixup` text.

- [ ] **Step 2: Build the Pi configuration and verify the check fails for the confirmed reason**

Run:

```bash
nix build .#packages.x86_64-linux.pi-config --no-link --print-build-logs
```

Expected: FAIL in the `pi-claude-bridge-0.7.0` install-check phase because the bundled executable cannot use `/lib64/ld-linux-x86-64.so.2` on NixOS. The command must reach `Running phase: installCheckPhase` and the new `--version` check; an unrelated evaluation or dependency failure does not satisfy the red step.

- [ ] **Step 3: Add the minimal Nix auto-patching inputs**

Add these attributes after `src = piClaudeBridgeSrc;`:

```nix
      nativeBuildInputs = [ pkgs.autoPatchelfHook ];
      buildInputs = [ pkgs.stdenv.cc.cc.lib ];
```

Do not add an executable-path override or an explicit `autoPatchelf` command. Let the hook patch native files in the completed package output.

- [ ] **Step 4: Rebuild and verify the regression check passes**

Run:

```bash
nix build .#packages.x86_64-linux.pi-config --no-link --print-build-logs
```

Expected: PASS. The `pi-claude-bridge-0.7.0` derivation completes auto-patching during fixup and then passes the exact version check during `installCheckPhase`.

- [ ] **Step 5: Inspect and execute the packaged binary directly**

Run:

```bash
set -euo pipefail
out="$(nix build .#packages.x86_64-linux.pi-config --no-link --print-out-paths)"
bridge="$(jq -r '.packages[] | select(endswith("/lib/node_modules/pi-claude-bridge"))' "$out/settings.json")"
claude="$bridge/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"
test -x "$claude"
test "$("$claude" --version)" = "2.1.141 (Claude Code)"
```

Expected: every command exits with status 0.

- [ ] **Step 6: Run the affected packaged-runtime checks**

Run:

```bash
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix build .#checks.x86_64-linux.jailed-pi-auth-mode --no-link
```

Expected: both checks exit with status 0. The extension-load output contains no `Failed to load extension`, `No such built-in module`, or `Cannot find package` error.

- [ ] **Step 7: Reproduce a real Pi request through the built bridge provider**

Run:

```bash
set -euo pipefail
out="$(nix build .#packages.x86_64-linux.pi-config --no-link --print-out-paths)"
bridge="$(jq -r '.packages[] | select(endswith("/lib/node_modules/pi-claude-bridge"))' "$out/settings.json")"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
DEBUG_CLAUDE_AGENT_SDK=1 CLAUDE_BRIDGE_DEBUG=1 \
  pi --no-extensions \
    --extension "$bridge/src/index.ts" \
    --provider claude-bridge \
    --model claude-haiku-4-5 \
    --no-session \
    --print "Reply with exactly: ok" 2>&1 | tee "$log"
! grep -F 'Claude Code process exited with code 127' "$log"
! grep -F 'EPIPE: broken pipe, send' "$log"
```

Expected: Pi exits with status 0 and returns a Claude response. Neither the subprocess exit-127 diagnostic nor the derived `EPIPE` error appears.

- [ ] **Step 8: Run the required full flake check**

Run:

```bash
nix flake check --accept-flake-config --print-build-logs
```

Expected: exit status 0 with no failed flake check.

- [ ] **Step 9: Review and commit the package fix**

Run:

```bash
git diff --check
git diff -- nix/packages/pi-deps.nix
git add nix/packages/pi-deps.nix
git commit -m "fix(pi): patch bundled Claude bridge executable"
```

Expected: the diff contains only the two patch inputs and the `postFixup` version check in `piClaudeBridge`.

---

### Task 2: Review the completed fix

**Files:**
- Review: `nix/packages/pi-deps.nix`
- Compare: `docs/specs/2026-08-30-pi-claude-bridge-nixos-binary-design.md`

**Interfaces:**
- Consumes: The committed Task 1 diff and its verification evidence.
- Produces: Review findings resolved or an explicit clean review before completion.

- [ ] **Step 1: Request an adversarial code review**

Give the reviewer the approved spec, implementation plan, base SHA `bceee9f`, implementation head SHA, exact verification commands and results, and the constraint that implementation must change only `nix/packages/pi-deps.nix`.

- [ ] **Step 2: Resolve any valid findings**

For each finding, verify it against the derivation and spec before editing. If a production change is needed, repeat the smallest relevant red-green check, rerun the affected Nix checks, and commit the correction with a focused Conventional Commits subject.

- [ ] **Step 3: Confirm final repository state and evidence**

Run:

```bash
git status --short --branch
git diff --check HEAD^ HEAD
git show --stat --oneline HEAD
```

Expected: the worktree is clean, the committed implementation scope is correct, and all verification evidence is current for the final HEAD.
