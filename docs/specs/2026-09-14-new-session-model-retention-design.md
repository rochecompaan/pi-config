# Preserve the Active Runtime Choice Across `/new`

**Status:** Approved design

**Date:** 2026-09-14

## Summary

Pi starts `/new` with the configured startup model and thinking level. It does not retain changes made during the current session.

A repository extension will preserve the active model and thinking level across `/new`. The extension will not change fresh Pi startup behavior.

## Context

This repository packages upstream Pi through `llm-agents.nix`. It does not contain the Pi core source.

Pi 0.85.1 handles built-in interactive commands before extension commands. An extension cannot replace `/new` by registering another command with the same name.

Pi provides lifecycle events for session replacement. It also lets extensions set the active model and thinking level in the replacement runtime.

The extension will use these APIs to change the effective `/new` behavior. The built-in command will still create the new session.

## Goals

- Retain the active provider and model when the user runs `/new`.
- Retain the active thinking level as part of the same runtime choice.
- Apply the retained values only inside the current Pi process.
- Use documented Pi extension and session-persistence APIs.
- Leave the built-in `/new` command and its normal session lifecycle intact.

## Non-goals

- Do not persist runtime choices across Pi process restarts.
- Do not change configured startup defaults.
- Do not change `/resume`, `/fork`, `/clone`, or `/reload`.
- Do not support sessions created with `--no-session`.
- Do not patch or fork upstream Pi.
- Do not register a replacement command named `new`.

## Terms

The **runtime choice** consists of these values:

- the provider identifier
- the model identifier
- the effective thinking level

The **handoff entry** is a private custom session entry that stores the runtime choice for one `/new` transition.

## Architecture

Add one extension at `extensions/retain-new-session-model/index.ts`.

The extension has one responsibility. It transfers the runtime choice from the current saved session to the replacement session created by `/new`.

The extension uses two lifecycle events:

1. `session_before_switch` captures the runtime choice in the old session.
2. `session_start` restores that choice in the replacement runtime.

No extension command is necessary.

## Handoff entry

The extension appends an invisible custom entry to the old session. The entry does not enter the model context or appear in the transcript.

The custom type will be specific to this extension. Its data will use this versioned shape:

```ts
{
  version: 1,
  provider: string,
  modelId: string,
  thinkingLevel: ThinkingLevel,
}
```

The extension writes one entry for each `/new` attempt. A newer entry takes precedence over older entries in the same session.

The schema version permits a later format change without ambiguous parsing.

## Capture flow

The `session_before_switch` handler acts only when `event.reason` is `"new"`.

The handler reads `ctx.model` and `ctx.thinkingLevel`. It then appends the handoff entry through `pi.appendEntry()`.

The handler does not change global settings. It does not cancel or replace the session transition.

If another extension cancels `/new`, the entry remains in the old session. A later attempt writes a newer entry.

## Restore flow

The `session_start` handler acts only when both conditions are true:

- `event.reason` is `"new"`
- `event.previousSessionFile` is present

The handler reads the previous saved session and finds its newest handoff entry. It validates the custom type, version, and value types before use.

The handler resolves the stored provider and model through the replacement runtime model registry. It then calls `pi.setModel()`.

The handler calls `pi.setThinkingLevel()` only after the model change succeeds. This order lets Pi apply the thinking level against the correct model capabilities.

A successful restore is silent. The standard Pi footer shows the resulting model and thinking level.

## Scope of behavior

The extension consumes a handoff only after `/new`.

These session-start reasons do not consume a handoff:

- `startup`
- `reload`
- `resume`
- `fork`

A fresh Pi process continues to resolve its model and thinking level from startup arguments and configured defaults.

## Failure behavior

| Condition | Result |
| --- | --- |
| The previous session file is absent | Keep the replacement session defaults. |
| No handoff entry exists | Keep the replacement session defaults. |
| The entry is malformed | Keep the defaults and show a warning. |
| The entry version is unsupported | Keep the defaults and show a warning. |
| The stored model is unavailable | Keep the defaults and show a warning. |
| Authentication is unavailable | Keep the defaults and show a warning. |
| The thinking level is unsupported | Let Pi clamp it to the restored model capabilities. |
| Reading the previous session fails | Keep the defaults and show a warning. |

If model restoration fails, the extension does not apply the stored thinking level to the fallback model.

Warnings identify the extension and state why restoration did not occur. They do not expose credentials or session contents.

## Module structure

The implementation and its small parsing functions will remain in one cohesive module:

- `extensions/retain-new-session-model/index.ts`
- `extensions/retain-new-session-model/index.test.ts`

The extension file will remain below the repository module-size review threshold. A split is not useful for this limited responsibility.

Pure validation and entry-selection functions can be exported for focused tests. The extension factory remains the only runtime entry point.

## Testing strategy

Automated tests will cover behavior rather than static file contents.

The tests will prove these cases:

1. Only a `"new"` switch writes a handoff entry.
2. The entry contains the exact provider, model identifier, and thinking level.
3. A `"new"` start reads and validates the newest matching handoff entry.
4. Model restoration occurs before thinking-level restoration.
5. Missing handoff state leaves the replacement defaults unchanged.
6. Malformed and unsupported entries produce warnings and leave defaults unchanged.
7. An unavailable model produces a warning and skips thinking restoration.
8. An authentication error produces a warning and skips thinking restoration.
9. Other session-start reasons do not read or apply a handoff.

The tests can use temporary JSONL session fixtures and mocked Pi contexts. They do not need a provider network request.

The Nix resource wiring is static configuration. It does not need a new content-assertion test.

Final verification will include:

```sh
bun test extensions/retain-new-session-model/index.test.ts
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

## Existing baseline failure

The clean `f20d187` baseline fails in `checks.x86_64-linux.jailed-github-broker`. The failure occurs before this design adds any files.

The failing check reports:

```text
timed out waiting for expected file
```

This check is unrelated to Pi extension loading. Final verification must report it separately if it remains present.

## Acceptance criteria

- `/new` retains the active provider and model in a normal saved session.
- `/new` retains the active effective thinking level.
- A fresh Pi process still uses its configured startup defaults.
- `/resume`, `/fork`, `/clone`, and `/reload` keep their current behavior.
- The extension does not patch upstream Pi or replace the built-in command.
- Restore failures preserve usable replacement-session defaults and show a clear warning.
- The focused extension tests and Pi extension-load check pass.
- The full flake-check result reports this change separately from the known baseline failure.
