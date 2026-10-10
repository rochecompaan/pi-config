# rpiv-voice Implementation Plan

> For agentic workers: Use `superpowers:executing-plans` for direct execution. Delegation requires explicit operator authorization.

**Goal:** Replace pi-listen with Nix-packaged local dictation through rpiv-voice.

**Architecture:** Build one npm package with a maintained lockfile for its regular dependencies. Keep the source fetcher and package registration in the existing dependency module. Let the existing updater own the source pin and lockfile together.

**Tech Stack:** Nix, npm, Sherpa ONNX, Decibri, Pi, Python unittest.

**Spec:** `docs/specs/2026-10-10-rpiv-voice-design.md`

## Global Constraints

- Continue to support `x86_64-linux` only.
- Pin `@juicesharp/rpiv-voice` version `2.12.0`.
- Use the upstream `/voice` command without a custom keyboard shortcut.
- Enter pastes the transcript into the editor. Esc cancels dictation.
- Pi supplies its own peer dependencies. Do not install another Pi runtime in the voice output.
- Do not add the optional `@juicesharp/rpiv-i18n` package.
- Do not use npm or Git installation at runtime.
- Do not modify the Pi executable, flake inputs, or `pi-intervals` source.

## Review Focus

- Native imports can fail after extension startup because voice loads native modules only when needed.
- Decibri can require Linux audio libraries through dynamic loading rather than ELF dependency entries.
- npm can install a second Pi runtime through peer dependencies unless the build omits peers.
- Model extraction can fail when tar or bzip2 is absent from the user's `PATH`.
- Microphone access and transcript behavior require manual verification after deployment.

## Task 1: Package and register rpiv-voice

Files:

- Create `nix/packages/rpiv-voice.nix`.
- Create `nix/packages/rpiv-voice-package-lock.json`.
- Modify `nix/packages/pi-deps.nix`.
- Modify `modules/packages/pi-deps.nix`.
- Modify `nix/dependency-pins.json`.
- Modify `settings.json`.

Interfaces:

- The build recipe consumes `{ pkgs, src, pin }` and returns the npm package derivation.
- The dependency module exports `rpivVoice` and its scoped resource directory in `packagePaths`.
- The flake exposes `packages.x86_64-linux.rpiv-voice` instead of `pi-listen`.

- [ ] Create the recipe with `buildNpmPackage`, the maintained lockfile, and `autoPatchelfHook`.
- [ ] Omit development dependencies and peer dependencies from npm installation.
- [ ] Add the C++ runtime and the Linux audio libraries that Decibri requires.
- [ ] Substitute absolute Nix paths for tar and bzip2 in `audio/model-download.ts` with `--replace-fail`.
- [ ] Replace the pi-listen source, derivation, package output, and generated resource path.
- [ ] Replace the old source pin with the prefetched rpiv-voice source and npm cache hashes.
- [ ] Remove the separate Sherpa pins and the obsolete `voice` block in `settings.json`.
- [ ] Stage new Nix-referenced files, then run `nix build .#packages.x86_64-linux.rpiv-voice --no-link`.
- [ ] Inspect the output dependency directories and generated package path. Make sure that no copied Pi peer runtime remains.
- [ ] Extract a small bzip2 archive with the substituted tar command and empty `PATH`. Expect the original file contents.

## Task 2: Preserve automatic updates

Files:

- Modify `maintenance/dependency_updates/catalog.json`.
- Modify `docs/dependency-updates.md`.
- Modify `README.md`.

Interfaces:

- The `rpiv-voice` update unit owns `nix/dependency-pins.json` and `nix/packages/rpiv-voice-package-lock.json`.
- The source uses `npm-latest`, `fetchzip`, and the existing maintained-lock policy.

- [ ] Replace the pi-listen catalog source and unit with rpiv-voice.
- [ ] Remove the separate Sherpa catalog sources. Keep the source marker in the audited dependency recipe.
- [ ] Update the active dependency guide and document `/voice`, its keys, and the first model download in the README.
- [ ] Run `python3 -m maintenance.dependency_updates list` and `python3 -m maintenance.dependency_updates audit`. Expect the new unit and a passing source audit.
- [ ] Run `python3 -m unittest discover -s maintenance/tests -p 'test_dependency_*.py' -v` with the built dependency tools on `PATH`. Expect all tests to pass.

## Task 3: Check native loading and Pi startup

Files:

- Modify `modules/packages/pi-config.nix`.

Interfaces:

- The flake exposes `checks.x86_64-linux.rpiv-voice-native-load`.
- The check uses Pi's packaged executable and resolves native dependencies from the voice package's manifest path.

- [ ] Replace the old Sherpa-only check with a native check that loads Sherpa and Decibri.
- [ ] Make the check assert the expected native-backed API exports before it emits its success marker.
- [ ] Keep a temporary home and the invalid-provider startup pattern. Do not open a microphone or download a model.
- [ ] Build `.#checks.x86_64-linux.rpiv-voice-native-load`. Expect a successful derivation.
- [ ] Build `.#checks.x86_64-linux.pi-config-extension-load`. Expect no extension-loading errors.
- [ ] Run `nix flake check --accept-flake-config --print-build-logs`. Expect exit status zero.
- [ ] Inspect the final diff for active pi-listen references, unrelated changes, and missing new files.
- [ ] Report the check results and the manual microphone steps. Leave user state and historical documents unchanged.

## Baseline evidence

The task-specific worktree is `.worktrees/rpiv-voice` on branch `feat/rpiv-voice`.
The existing Pi extension-load check passes.
All 103 dependency-update tests pass with the built dependency-update tools on `PATH`.
The initial lockfile is generated with lifecycle scripts disabled.
No production configuration changes are applied during plan preparation.

## Implementation verification

The package build, native-loading check, extension-startup check, and full flake check pass.
The source audit accepts 16 units and 17 fixed sources.
All 103 dependency-update tests pass with the built dependency tools on `PATH`.
The package contains its regular dependencies and no copied Pi peers or optional i18n peer.
The packaged tar and bzip2 paths extract a small archive with an empty `PATH`.

The updater has no `inventory` subcommand, so verification uses its supported `list` and `audit` commands.
The final diff receives an in-session self-review, not an independent review.
Microphone capture, previews, Enter, and Esc still require manual checks after deployment.
The implementation does not deploy the configuration or change existing user state.
