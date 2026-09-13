# New Session Model Retention Design

## Context

Pi 0.85.1 rebuilds its session runtime when a user runs `/new`. The replacement runtime resolves the configured startup model and thinking level again.

This behavior breaks workflows that use several concurrent Pi processes with different runtime selections. A user must correct the model after each `/new` handoff.

The extension lifecycle cannot correct this behavior. Pi resolves the replacement runtime inside core code, after the old extension context becomes stale.

This repository receives Pi from the `llm-agents.nix` flake input. It does not contain the upstream Pi source. The local fix must therefore patch the packaged Pi runtime before compilation.

Upstream issue #9054 tracks the product behavior. This patch is a temporary local fix until an upstream release contains the change.

## Goals

1. Retain the active model when `/new` creates a session in the same Pi process.
2. Retain the active thinking level with that model.
3. Keep a fresh Pi process subject to its configured startup defaults.
4. Keep model and thinking changes local unless the user explicitly persists them.
5. Detect patch drift during a future Pi package update.
6. Add an automated regression for the retained runtime selection.

## Non-Goals

- Do not persist the active model or thinking level to global settings.
- Do not change startup model resolution for a fresh Pi process.
- Do not change resume, fork, import, or directory-switch behavior.
- Do not replace `/new` with an extension command.
- Do not maintain a complete fork of upstream Pi.
- Do not patch `llm-agents.nix` outside this repository.

## Selected Approach

Override the Pi derivation from `llm-agents.nix`. Apply a version-specific patch to the unpacked Pi 0.85.1 distribution before Bun compiles the executable.

The patch will modify the packaged JavaScript that implements the session runtime and its factory. This approach gives an immediate local fix without a permanent upstream fork.

The patch file will live beside other package patches in `nix/packages/`. A failed patch hunk will stop the Nix build when an upstream update changes the affected code.

## Runtime Design

`AgentSessionRuntime.newSession()` already owns the replacement boundary. It can read the current session before teardown and supply data to the replacement factory.

After `session_before_switch` permits the operation, `newSession()` will capture:

- `this.session.model`
- `this.session.thinkingLevel`

The method will capture both values before `teardownCurrent()` invalidates the old session. It will add both values to the request for `createRuntime()`.

The runtime factory in `dist/main.js` will accept the optional values. It will prefer them over the startup values returned by `buildSessionOptions()`.

The factory will pass the selected values to `createAgentSessionFromServices()`. That existing function records the initial model and thinking level in the new session transcript.

Only `newSession()` will supply the retained values. Other runtime replacement methods will continue to omit them and keep their current behavior.

## Data Flow

The `/new` flow will be:

1. The interactive command calls `AgentSessionRuntime.newSession()`.
2. The runtime emits `session_before_switch` and respects cancellation.
3. The runtime captures the active model and thinking level.
4. The runtime tears down the current session and its extensions.
5. The runtime creates new services and a new session manager.
6. The runtime factory selects the captured values instead of startup defaults.
7. The new session records those values as its initial runtime selection.
8. Pi binds the new extension context and shows the empty session.

The captured values remain in memory. The patch does not write a global preference.

## Edge Cases and Errors

If the current session has no active model, the runtime factory will use the existing startup resolution path. It will not apply a retained thinking level without a retained model.

The existing session constructor will clamp the retained thinking level to the active model capabilities. This protects the replacement session from an unsupported level.

If `session_before_switch` cancels `/new`, the runtime will not capture, tear down, or replace the current session.

If replacement creation fails, the existing fatal runtime error path will report the error. The patch will not add a second recovery path.

## Package Integration

`modules/packages/pi.nix` will wrap `inputs.llm-agents.packages.${system}.pi` with `overrideAttrs`.

The override will:

1. Append the local patch to any existing package patches.
2. Run the focused runtime and RPC regressions against the patched distribution.
3. Preserve the existing Bun compilation and install checks.

The implementation will not copy a mutable Git source at runtime. Nix will keep all patch and test inputs in the store.

## Test Design

### Runtime Boundary Regression

Add a focused Node test beside the package patch. The test will import the patched `AgentSessionRuntime` from the unpacked Pi distribution.

A fake current session will use a model that differs from the configured startup model. It will also use a non-default thinking level.

The replacement factory will record its request. The test will run `newSession()` and assert that the request contains the active model and thinking level.

The focused test will also cover these boundaries:

- A cancelled `session_before_switch` does not create a replacement runtime.
- A session without an active model leaves startup resolution available.

### RPC Integration Regression

Add a second Node test that starts the real `dist/cli.js` entry point in RPC mode. It will use two local fixture models and no network calls.

The integration test will:

1. Confirm that the first process starts with its configured model and thinking defaults.
2. Select a different model and thinking level through RPC commands.
3. Run `new_session` and read the resulting state through RPC.
4. Confirm that the new transcript records the active model and thinking level.
5. Confirm that the global settings file remains unchanged.
6. Start a second process and confirm that it still uses the configured defaults.

This test exercises both patched production files. It will fail if either the runtime boundary or the real runtime factory drops the retained values.

The Pi derivation will run both tests before Bun compilation. A regression will therefore stop the package build.

The Testing Value Gate passes because these tests prove user-visible runtime behavior. They can fail when `/new` stops retaining the active runtime selection.

## Files

The implementation will modify or add these files:

- `modules/packages/pi.nix`
- `nix/packages/pi-new-session-model-retention.patch`
- `nix/packages/pi-new-session-model-retention.test.mjs`
- `nix/packages/pi-new-session-model-retention-rpc.test.mjs`

No extension source file requires a change.

## Verification

Run the focused Pi package build, which includes the new regression:

```sh
nix build .#packages.x86_64-linux.pi --no-link
```

Run the Home Manager-like extension startup check:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Run the complete flake check:

```sh
nix flake check --accept-flake-config --print-build-logs
```

When practical, start the built Pi executable and make a manual runtime check:

1. Select a model that differs from the configured default.
2. Select a non-default thinking level.
3. Run `/new`.
4. Confirm that the new session uses both selected values.
5. Start a separate Pi process.
6. Confirm that the separate process uses configured startup defaults.

## Acceptance Criteria

- `/new` retains the active model in the same Pi process.
- `/new` retains the active thinking level with that model.
- The new session records both values in its transcript.
- A cancelled `/new` leaves the current runtime unchanged.
- A fresh Pi process continues to use configured startup defaults.
- The patch does not persist a new global preference.
- The package build runs and passes the focused regression.
- The extension-load check passes.
- The complete flake check passes.
- A future incompatible Pi package update fails clearly during patching or the regression.
- No changes are pushed without explicit permission.
