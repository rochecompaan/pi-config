# Pi Extension Host Dependencies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the Pi 1.0 startup dependency warnings by upgrading pi-subagents and temporarily patching remote-pi packaging.

**Architecture:** Keep both extensions Nix-managed. Upgrade pi-subagents to its current released tag. Apply temporary remote-pi build patches without changing its pinned source revision or dependency lock. Pi supplies its runtime modules through the extension loader; the standalone CLI skips extension-only imports.

**Tech Stack:** Nix, npm, Node.js, Pi 1.0.0.

## Global Constraints

- Work in `.worktrees/pi-extension-host-deps` on `fix/pi-extension-host-deps`.
- Upgrade `pi-subagents` from `0.58.0` to `0.74.0`.
- Keep `remote-pi` at `0.7.0`; its current upstream release and branch do not fix the dependency declarations.
- Preserve ordinary extension runtime dependencies.
- Do not modify upstream repositories or live Home Manager resources.
- Host-provided packages must not remain bundled with the installed extensions.
- Do not add tests that merely assert dependency pins or manifest values. Verify the packages and actual startup instead.
- Preserve the standalone remote-pi CLI. Test its actual entry point and extension tool registration.

## Task 1: Upgrade pi-subagents

**Files:** Modify `nix/packages/pi-deps.nix`.

- [x] Reproduce the old warning and verify the current extension-load baseline.
- [x] Set the source tag to `v0.74.0` and package version to `0.74.0`.
- [x] Replace the fetchgit and npm dependency hashes using the Nix fixed-output hash cycle.
- [x] Install without dev dependencies or host peers: `npmInstallFlags = [ "--omit=dev" "--omit=peer" ];`.
- [x] Build the package and inspect its installed dependency declarations and module tree.

## Task 2: Apply the temporary remote-pi packaging fix

**Files:** Modify `nix/packages/pi-deps.nix` and `modules/checks/pi-config-extension-load.nix`; create `patches/remote-pi-host-imports.patch`.

- [x] Keep the existing fetched source and lockfile unchanged.
- [x] Reproduce the standalone CLI failure after removing bundled host modules. Add a runtime smoke check and observe it fail for the missing host import.
- [x] Patch the shared compiled entry point to import Pi host modules and tool registration only when loaded as an extension, using upstream's `_isDirectRun()` guard.
- [x] Verify CLI help and extension loading pass after the patch. Extend the runtime check to reject host-dependency warnings and require remote-pi tool registration.
- [x] In `postInstall`, move direct dependencies on `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` into peer dependencies with `"*"` ranges.
- [x] Remove installed copies of the five host-provided packages: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`.
- [x] Mark the patch as temporary and explain when it can be removed.
- [x] Build the package and verify its other runtime dependencies remain installed.

## Task 3: Verify and review

- [x] Run `nix build .#checks.x86_64-linux.pi-config-extension-load --no-link`.
- [x] Run `nix flake check --accept-flake-config --print-build-logs`.
- [x] Test Home Manager-like startup with the built resources and an invalid provider, checking for dependency warnings and extension-load errors. The only failure must be the deliberately invalid provider.
- [x] Inspect the installed module trees for remaining copies of host-provided packages.
- [x] Run the available Nix formatter check and `git diff --check`.
- [x] Obtain a fresh reviewer assessment, then address any verified issues.
- [x] Record verification results and prepare branch integration options. Do not merge, push, or activate Home Manager without approval.

## Verification Results

- Baseline extension-load check passed.
- The new packaged CLI smoke test failed before the import patch: `ERR_MODULE_NOT_FOUND` for `@earendil-works/pi-coding-agent`.
- The same runtime check passed after the patch, including CLI help, extension loading, and remote tool registration.
- `nix build .#checks.x86_64-linux.pi-config-extension-load --no-link` passed on the final implementation.
- `nix flake check --accept-flake-config --print-build-logs` passed on the final implementation.
- Direct and symlinked CLI help and the CLI daemon-registry command exited successfully.
- Home Manager-like startup reported only the deliberately invalid provider error, with no dependency warnings or extension-load errors.
- Both installed extensions contain no copies of the five host modules. All ordinary direct runtime dependencies remain installed.
- Nix formatting and `git diff HEAD --check` passed.
- Fresh review and a focused follow-up review reported no findings.

Static pin and manifest tests were not added. Installed-tree inspection and startup checks verify those packaging edits directly; the new runtime smoke check protects the CLI behavior changed by the temporary source patch.
