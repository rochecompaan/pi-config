# Threshold-Driven Automatic Handoff Design

**Date:** 2026-08-21
**Status:** Approved for implementation planning

## Purpose

Pi can compact a long session, but compaction loses some detail. The handoff extension creates a focused prompt for a new child session.

This change adds an automatic handoff when raw context usage reaches a token threshold. The user keeps control through a cancellation countdown and final prompt submission.

## Goals

- Trigger an automatic handoff after the agent settles at or above the configured threshold.
- Use `ctx.getContextUsage().tokens` without extra token estimates.
- Use 150,000 tokens as the default threshold.
- Let Pi settings override the default threshold.
- Reuse the current handoff summary and session replacement flow.
- Give the user five seconds to cancel an automatic handoff.
- Put the generated prompt in the new session editor.
- Require the user to press Enter before Pi submits the prompt.
- Keep manual `/handoff <goal>` behavior unchanged.
- Prevent repeated automatic attempts after cancellation or an error.
- Keep Pi compaction enabled as a fallback.

## Non-Goals

- The extension will not submit the generated prompt automatically.
- The extension will not replace or disable Pi compaction.
- The extension will not estimate tool-definition tokens.
- The extension will not add persistent controls for the enabled state or countdown length.
- The extension will not use the older `execute-command` extension.

## Settings

The extension reads the threshold from Pi settings:

```json
{
  "handoff": {
    "autoThresholdTokens": 150000
  }
}
```

The global settings file supplies the base value. A trusted project settings file can override the global value.

The extension uses 150,000 when the effective value is missing, invalid, or not positive. Automatic handoff is enabled by default. The five-second countdown is fixed.

## Commands

### Manual handoff

`/handoff <goal>` keeps its current behavior:

1. The extension collects the active conversation context.
2. The extension generates a handoff prompt for the supplied goal.
3. The user reviews and edits the prompt in the modal editor.
4. The extension creates a child session.
5. The extension puts the edited prompt in the new session editor.
6. The user presses Enter to submit the prompt.

### Automatic controls

The extension adds these control forms:

- `/handoff auto on`
- `/handoff auto off`
- `/handoff auto status`

`auto off` disables threshold checks for the current session. `auto status` shows the effective threshold and current state.

`auto on` clears suppression and arms the automatic trigger. If current usage is already at or above the threshold, the countdown starts immediately.

### Internal automatic invocation

The extension reserves `/handoff --auto` for automatic dispatch. This form is not a user workflow.

## Architecture

`extensions/handoff.ts` remains the extension entry point. It owns Pi events, commands, UI, model calls, and session replacement.

Create `extensions/handoff-auto.ts` for pure automation logic. This module owns settings resolution, command parsing, and state transitions. This split keeps `handoff.ts` focused as it grows beyond its current size.

The `agent_settled` event handler never calls `ctx.newSession()`. Session replacement is available only in an extension command context.

When the trigger conditions match, the handler dispatches `/handoff --auto` with prompt-template expansion enabled. The `/handoff` command handler then owns the complete automatic flow.

## Session State

The automatic feature uses three states:

- `armed`: Threshold checks are active.
- `running`: A countdown or automatic handoff is active.
- `disabled`: Automatic attempts are suppressed until `/handoff auto on`.

Each `session_start` initializes the state to `armed`.

The transition rules are:

| Event | New state |
|---|---|
| Session starts | `armed` |
| Threshold is reached | `running` |
| `/handoff auto off` | `disabled` |
| Countdown is cancelled | `disabled` |
| Dispatch fails | `disabled` |
| Prompt generation fails | `disabled` |
| Generated prompt is empty | `disabled` |
| Session switch is cancelled | `disabled` |
| `/handoff auto on` below threshold | `armed` |
| `/handoff auto on` at or above threshold | `running` |

The extension sets `running` before it dispatches the internal command. This prevents duplicate settled events from starting another attempt.

The extension does not retry an unsuccessful automatic handoff. The user must run `/handoff auto on` to retry.

## Trigger Conditions

The `agent_settled` handler returns unless all these conditions are true:

- The current mode is interactive TUI mode.
- Pi is idle.
- The automatic state is `armed`.
- Context usage is available.
- `usage.tokens` is at least the effective threshold.

The handler ignores unavailable context usage. It also ignores all non-TUI modes because those modes cannot support the required countdown and editor workflow.

## Automatic Flow

1. The settled handler detects raw usage at or above the threshold.
2. The handler changes the state to `running`.
3. The handler dispatches `/handoff --auto`.
4. The command shows a five-second countdown.
5. The user can press Escape to cancel.
6. The flow continues automatically when the countdown reaches zero.
7. The command collects the active conversation context.
8. The command generates a prompt with the existing handoff summary logic.
9. The command creates a child session with the current session file as `parentSession`.
10. The replacement-session callback puts the prompt in the editor.
11. The callback tells the user that the handoff prompt is ready.
12. The user can edit the prompt.
13. The user presses Enter.

Automatic mode uses this fixed goal:

> Continue the current task in a fresh session. Preserve the current objective, decisions, progress, blockers, and concrete next steps.

The summarizer infers the active task from the conversation. The flow does not use a separate model call to infer the goal.

## Session Replacement Safety

The command captures only plain data before session replacement. This data includes the generated prompt and current session file path.

After `ctx.newSession()` succeeds, the old extension API and command context are stale. The replacement callback uses only its `replacementCtx` parameter.

The callback calls `replacementCtx.ui.setEditorText()` to stage the prompt. It does not call `sendUserMessage()`.

If another extension cancels the switch, `ctx.newSession()` returns a cancelled result. The original context remains valid in that case, so the extension can show a cancellation notice.

## Error Handling

The extension changes the automatic state to `disabled` after any unsuccessful automatic attempt. This rule prevents repeated countdowns and repeated model charges.

The automatic flow handles these outcomes:

- The user cancels the countdown.
- Internal command dispatch throws an error.
- No model is selected.
- The conversation has no handoff messages.
- Authentication resolution fails.
- Prompt generation is aborted or fails.
- Prompt generation returns no text.
- Another extension cancels the new session.

Each outcome keeps the current session active. The extension shows a short error or information notice when a TUI context remains valid.

## Compaction Fallback

The extension does not subscribe to compaction events and does not cancel compaction. Pi keeps its normal threshold and overflow compaction behavior.

If a model has a context window below 150,000 tokens, automatic handoff does not run with the default setting. Pi compaction remains the fallback. The user can lower `handoff.autoThresholdTokens` for that model.

## Test Design

Automated tests use the existing `node:test` style. Tests cover behavior, not static settings text.

The design uses narrow injected boundaries for the countdown, prompt generation, and session switch. Tests do not wait five seconds or call a real model.

### Settings tests

- Use 150,000 when no threshold exists.
- Use a valid global threshold.
- Use a valid trusted project override.
- Use 150,000 for an invalid or non-positive effective value.

### Trigger tests

- Do not trigger below the threshold.
- Trigger at the exact threshold.
- Ignore unavailable usage.
- Ignore non-TUI modes.
- Ignore duplicate settled events while the state is `running`.

### Control tests

- `auto off` changes the state to `disabled`.
- `auto on` rearms below the threshold.
- `auto on` starts immediately at or above the threshold.
- `auto status` reports the state and effective threshold.

### Automatic flow tests

- Continue when the countdown reaches zero.
- Disable automatic handoff when the countdown is cancelled.
- Disable automatic handoff after dispatch, generation, empty-output, or switch errors.
- Record the old session file as `parentSession`.
- Use only the replacement context after a successful switch.
- Put the generated prompt in the replacement editor.
- Do not submit the generated prompt.

### Manual regression tests

- Keep the required manual goal.
- Keep the modal prompt review and edit step.
- Put the edited prompt in the replacement editor.
- Require the user to press Enter.

## Verification

Run these checks after implementation:

1. Run the focused TypeScript tests with the Node test runner.
2. Run `nix build .#checks.x86_64-linux.pi-config-extension-load --no-link`.
3. Run `nix flake check --accept-flake-config --print-build-logs`.
4. Do an interactive TUI smoke test.

The smoke test must show the five-second countdown. Escape must cancel the attempt. A completed handoff must leave the prompt in the new editor until the user presses Enter.

## Acceptance Criteria

- Raw context usage at or above the effective threshold starts one automatic attempt after `agent_settled`.
- The default threshold is 150,000 tokens.
- Pi settings can override the threshold.
- The user has five seconds to cancel.
- The countdown continues automatically at zero.
- An unsuccessful attempt does not repeat until the user runs `/handoff auto on`.
- Re-enabling above the threshold starts the countdown immediately.
- The new session records the old session as its parent.
- Automatic mode stages the generated prompt but never submits it.
- Manual `/handoff <goal>` keeps its current review and edit behavior.
- Pi compaction remains enabled as a fallback.
