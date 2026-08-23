# Review Prompt Footer Design

## Goal

Show which review prompt produced each completed `/review` response.

The extension must append one exact footer after the review output:

```text
review prompt: codex
```

or:

```text
review prompt: thermo-nuclear
```

The footer must be part of the saved assistant message. It must appear again when Pi restores the session.

## User-visible behavior

The extension maps the selected review profile to a display name:

- `standard` maps to `codex`.
- `thermo-nuclear` maps to `thermo-nuclear`.

The extension adds one blank line before the footer. The footer follows the findings, verdict, and human-reviewer callouts in a normal review response.

The behavior applies to fresh-session reviews and current-session reviews. Existing target selection, profile selection, model selection, review rubrics, and `/end-review` behavior do not change.

## Architecture

Add a focused core helper and a thin lifecycle adapter under `extensions/review/`. The core helper owns:

- The profile-to-display-name mapping.
- The exact footer format.
- Assistant-message transformation.
- Idempotence checks.
- The one-shot scheduled and armed footer state.

The lifecycle adapter owns Pi event registration and the schedule-before-send boundary. It registers `before_agent_start`, `message_end`, and `agent_settled`, and exposes one send helper that schedules the exact full prompt and selected profile immediately before `pi.sendUserMessage()`. Scheduling does not arm message transformation.

Keep review prompt construction and `/review` orchestration in `extensions/review/index.ts`. The index registers the lifecycle adapter once and delegates finalized prompt sending to it.

The `before_agent_start` callback compares `event.prompt` with the scheduled full prompt. An exact match promotes the scheduled footer to armed state. A different prompt clears the unarmed schedule. Scheduling a second prompt may replace an older unarmed schedule, but it must not replace an armed footer for a review already in progress.

The `message_end` callback replaces the completed assistant message through Pi's supported return value.

The handler appends the footer only when all these conditions are true:

1. A review footer is armed.
2. The message role is `assistant`.
3. The assistant message has `stopReason: "stop"`.
4. The message has at least one text block with nonempty text.

A `toolUse`, `length`, or `error` message keeps the armed state because Pi may continue the same agent run through tool execution, automatic retry, or compact-and-retry without another `before_agent_start` event. An `aborted` message clears the armed state without a footer.

An `agent_settled` handler clears any scheduled or armed state that remains after Pi has exhausted automatic retry and compaction recovery. This clears final `length` and `error` failures without dropping state before a successful retry.

The exact prompt text is the correlation key. This mechanism does not add a marker to the model prompt and does not change either review rubric. Pi 0.84.2 emits `before_agent_start` only after it accepts the user message far enough to start an agent run, so model or authentication failures that reject earlier never arm the footer.

## Message transformation

Append the footer to the final text content block:

```text
<existing review text>

review prompt: <display-name>
```

Preserve thinking and tool-call blocks without changes. Scan backward across trailing text blocks, ignoring non-text blocks, until reaching review prose. Remove every trailing standalone footer line whose trimmed text matches either known review prompt name, including candidate-only text blocks. Then append only the selected profile's canonical footer to the last text block that still contains review prose. This collapses repeated, indented, wrong-profile, and split-block footer candidates while preserving prose that merely ends with the same words. Consume the armed state after this normalization.

Pi runs `message_end` before it persists the finalized assistant message. Therefore, session history and restored transcripts contain the footer.

## Data flow

1. `/review` resolves the selected profile.
2. `dispatchReviewPrompt()` schedules the existing full review prompt and mapped footer.
3. `dispatchReviewPrompt()` sends the existing full review prompt.
4. When Pi accepts that exact prompt, `before_agent_start` promotes its footer to armed state.
5. Pi emits zero or more assistant messages with `stopReason: "toolUse"` while the model inspects the code.
6. Pi emits the final assistant message with `stopReason: "stop"`.
7. The `message_end` handler appends the mapped footer and clears the armed state.
8. Pi persists and renders the modified assistant message.

## Error handling

- Clear scheduled state if prompt dispatch throws synchronously.
- Leave state unarmed if prompt dispatch rejects asynchronously before `before_agent_start`.
- Clear an unarmed schedule when a different prompt reaches `before_agent_start`.
- Do not replace an armed footer when another `/review` dispatch is attempted during the active review.
- Keep armed state across `toolUse`, `length`, and `error` messages so automatic continuation can still receive the footer.
- Clear armed state after an `aborted` response or when `agent_settled` confirms no retry remains.
- Clear stale scheduled or armed state when the agent settles.
- Do not modify unrelated assistant messages when no review footer is armed.
- Do not add duplicate footers.

## Testing

Add focused behavior tests for the helper module:

- `standard` produces `review prompt: codex`.
- `thermo-nuclear` produces `review prompt: thermo-nuclear`.
- A scheduled footer becomes armed only when `before_agent_start` receives the exact scheduled review prompt.
- An asynchronous dispatch rejection that never reaches `before_agent_start` cannot modify a later unrelated assistant response.
- A `/review` attempt during an unrelated streaming response cannot modify that response.
- A second `/review` attempt cannot replace the armed footer for an active review.
- A completed assistant review gets one blank line and the exact footer.
- Tool-use messages preserve armed state and remain unchanged.
- Error and length responses remain unchanged and preserve armed state for a successful retry.
- A retried response that completes after `error` or `length` receives the footer.
- Aborted responses clear armed state and remain unchanged.
- Repeated, indented, wrong-profile, alternating, and split-block trailing footer candidates collapse to one selected canonical footer.
- A lifecycle adapter harness verifies schedule-before-send ordering, exact registered arming, `message_end` replacement, retry preservation, and scheduled/armed settlement cleanup.
- A second transformation does not duplicate the footer.
- Non-assistant messages remain unchanged.
- Agent settlement clears stale scheduled or armed state.

Run all review-extension tests. Run the packaged Pi extension-load check and the full flake check before completion.

No screenshot test is necessary because this change modifies persisted message text, not TUI layout.

## Non-goals

- Rename the existing `standard` profile.
- Change either review rubric.
- Add the footer to `/end-review` summaries or review-finding todos.
- Add a custom TUI renderer or a separate transcript entry.
- Persist unfinished scheduled or armed footer state across extension reloads.
