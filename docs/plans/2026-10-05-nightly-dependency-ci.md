# Nightly dependency CI repairs

**Goal:** Repair the four failure categories from Forgejo run 4. Commit each fix separately.

**Scope:** Preserve HTTPS, repository ownership, exact candidate trees, and manual PR review. Do not push or dispatch CI.

**Architecture:** Use the public Forgejo origin for checkout and publication. Keep compatibility fixes in the Nix package layer. Use behavior tests for reusable logic and existing runtime checks for dependency compatibility.

## Task 1: Public Forgejo origin

Files: `.forgejo/workflows/nightly-dependency-updates.yml`, `docs/dependency-updates.md`.

- [x] Define one trusted public HTTPS origin, with an Actions variable override.
- [x] Supply that origin to both checkout steps and publication.
- [x] Verify the pinned checkout input contract, workflow lint, publisher origin guards, and maintenance tests.
- [x] Commit the fix. Do not add tests that assert YAML text.

Evidence: the pinned checkout declares `github-server-url`. Normalized workflow lint passes. The unchanged publisher accepts the public checkout origin. All 91 maintenance tests pass.

## Task 2: Pi preview patch

Files: `nix/packages/pi-tool-result-preview-dist.patch` and related package checks if needed.

- [x] Reproduce the patch failure against Pi 1.0.2 in a disposable candidate.
- [x] Repair the patch without removing bounded result previews.
- [x] Run the existing preview behavior tests for the current pin and the updated Pi candidate.
- [x] Run the runtime extension-load check and full flake check.
- [x] Commit the fix.

Evidence: Pi 1.0.2 renamed the image conversion import. Split the first patch hunk so it no longer depends on that unrelated import. Pi 1.0.0 and Pi 1.0.2 package checks pass. Runtime extension-load and full flake checks pass for both pins. The updated flake lock stays in a disposable candidate.

## Task 3: Bridge lock integrity

Files: bridge package and lock policy, with focused behavior tests for any reusable repair logic.

- [x] Reproduce failure of the version-specific integrity patch against the selected upstream source.
- [x] Replace the stale repair with a reproducible lock-integrity policy that follows the lock's actual package versions.
- [x] Preserve upstream versions, disable npm lifecycle scripts, and reject invalid package metadata.
- [x] Run maintenance tests, bridge package checks, the runtime extension-load check, and full flake check.
- [x] Commit the fix.

Evidence: missing integrity, registry identity, unsafe URLs, and owned candidate lock files have regression coverage. All 100 maintenance tests pass. The pinned bridge package, extension-load check, and full flake check pass. Real upstream collection produces a repaired lock and npm cache hash for 0.9.1. Its package build now reaches separate stale history/paging patches.

Decision: commit the lock repair independently. Investigate the newly exposed source-patch failures after Task 4. Do not remove the history or paging behavior to pass the build.

## Task 4: Loadout skill filtering

Files: loadout compatibility patches and runtime probes.

- [x] Reproduce the disabled-skill bootstrap failure with pi-loadout 0.0.36.
- [x] Repair filtering across legacy and structured prompt APIs without weakening the assertions.
- [x] Run loadout behavior checks, the runtime extension-load check, and full flake check.
- [x] Commit the fix.

Evidence: another extension sets an opaque forced prompt before loadout. Version 0.0.36 changes structured skills but leaves that forced prompt unchanged. A new provider-input regression fails before the repair and passes after it. Filter the rendered prompt when `forceSystemPrompt` is present. All 13 loadout runtime tests, extension loading, and full flake checks pass for 0.0.35 and 0.0.36.

## Follow-up: Bridge source compatibility

Approved by the user after the four initial commits. Keep the dependency pins unchanged; verify the update in a disposable candidate.

- [x] Trace the newly exposed history/paging patch failures against bridge 0.9.1.
- [x] Add failing provider tests for idle session paging, AskClaude transcript fallback, active child paging, and active parent paging.
- [x] Extract the existing history support modules without changing their behavior. Keep the legacy index patches for the current pin.
- [x] Add a 0.9.1 integration patch. Use per-session history keys, preserve safe transcript fallback, and reuse upstream abandoned-query guards. Retire only the query whose selected history changed.
- [x] Run all bridge behavior tests, runtime extension loading, and full flake checks for the current and updated source.
- [x] Review and commit the follow-up separately.

Files: `nix/packages/pi-deps.nix`, the three legacy bridge patches, `nix/packages/pi-claude-bridge-history/`, a new session-history patch, the provider harness, and session-isolation tests.

Evidence before implementation: all four new tests fail against unpatched 0.9.1. Idle paging and AskClaude resume the stale session. Active parent and child paging do not start replacement SDK queries. The current bridge still passes all 11 active-paging tests with the compatible harness.

Evidence after implementation: the current bridge passes 23 applicable tests. Version 0.9.1 passes all 27 tests. Both sources pass runtime extension loading and full flake checks. All 100 maintenance tests pass with the pinned update tools. The extracted support modules exactly match the files produced by the three previous patches. The executable check accepts stable Claude Code version output instead of one fixed version. Both package builds exercise the guard. Nix formatting passes. These config checks use direct verification instead of new automated tests. Dependency pins remain unchanged. The 0.9.1 source, repaired lock, and npm cache hash stay in a disposable candidate.

## Final verification

- [x] Review the complete diff and run the maintenance test suite.
- [x] Run `nix build .#checks.x86_64-linux.pi-config-extension-load --no-link`.
- [x] Run `nix flake check --accept-flake-config --print-build-logs`.
- [x] Report the four commits and the bridge follow-up, verification evidence, and unverified live-run behavior.

## Execution notes

The parent implements all tasks. Delegation is not authorized. This plan follows the approved investigation rather than a new feature design.

The baseline suite passes all 91 tests with the pinned update tools. The host PATH lacks `semver`, so verification uses `/tmp/nightly-dependency-tools/bin`.
