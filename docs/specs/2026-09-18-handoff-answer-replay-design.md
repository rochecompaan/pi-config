# Automatic Handoff Answer Replay

**Date:** 2026-09-18
**Status:** Approach approved. Written specification awaits user review.

## Goal

After automatic handoff, show the last assistant answer again only when it directly answered a user question. Do not repeat autonomous progress reports.

The user approved conservative, model-assisted classification. This classification cannot guarantee perfect accuracy. Uncertain cases must not cause replay.

## Root Cause

`extensions/handoff.ts` transfers a generated summary to the replacement session. It does not transfer the original answer for separate display.

A `WAIT` handoff injects `handoff-context` without an agent turn. The summary can omit an answer that appeared immediately before handoff.

An in-memory reproduction confirmed this omission. All 67 existing handoff tests pass on the baseline commit, `c115f72`.

## Scope

This change affects automatic handoff only. Manual handoff, token thresholds, countdowns, continuity todos, and existing continuation rules remain unchanged.

The existing generation call decides whether replay is appropriate. No additional model call is required for classification or replay.

The extension copies the original answer. The model does not rewrite, summarize, or regenerate it.

## Replay Candidate

The candidate comes from the source conversation captured before automatic preparation starts.

Only the final assistant response in that conversation is eligible. The extension must not search backward for a more convenient earlier answer.

An eligible candidate must:

- Be a completed assistant response with `stopReason: "stop"`.
- Contain nonempty visible text.
- Contain no tool calls.
- Have no later user message that supersedes it.

An incomplete, aborted, failed, or empty response is ineligible. Thinking blocks, tool results, tool arguments, and hidden content are never replayed.

The extension preserves the text blocks in order, including Markdown, code blocks, links, indentation, and whitespace. It separates distinct text blocks with a newline.

The preparation report is never a candidate. A prior replay message is never an assistant candidate for another handoff.

## Classification

The generator receives the candidate together with the source conversation. It uses that context to decide whether the candidate directly answered the latest relevant user question.

A question includes a request for information or explanation without a question mark. For example, “Explain why this failed” qualifies.

The following cases do not qualify:

- Autonomous progress or a report of completed implementation work.
- Commentary about the next tool call or planned work.
- Responses to internal handoff preparation.
- Responses to background notifications or extension instructions rather than a user question.
- An offer or clarification question with no substantive answer.
- Any case where the generator is uncertain about the relationship between the question and response.

An explicit user question about progress can qualify. For example, a direct answer to “What did the tests show?” is distinct from an unsolicited test report.

The source context must retain the distinction between human conversation and internal messages where Pi exposes it. Missing context must not justify a guessed answer.

## Generation Contract

The generated result gains an optional boolean field, `replayLastAnswer`.

The automatic generation protocol adds one control line after `HANDOFF_ACTION`:

```text
HANDOFF_REPLAY_LAST_ANSWER: YES
```

or:

```text
HANDOFF_REPLAY_LAST_ANSWER: NO
```

The parser removes this control line from the handoff prompt. Only an explicit valid `YES` enables replay.

A missing line preserves compatibility with older output and means no replay. An invalid or contradictory replay control line fails generation before session replacement.

The extension also verifies that an eligible source candidate exists. A positive classification without a candidate cannot synthesize an answer.

Manual handoff does not request or use answer replay. Existing legacy-call behavior remains unchanged.

## Replacement Delivery

Replay is independent of the `CONTINUE`, `OFFER`, or `WAIT` action. It does not grant permission to perform work.

The replacement session shows a visible custom message labeled “Answer from previous session”. Its body contains only the original visible answer text.

The extension uses the replacement-session context, not captured objects from the old session. Replay uses `triggerTurn: false`.

Delivery order is:

- `WAIT`: inject the handoff context, then show the answer. The session remains idle.
- `CONTINUE`: show the answer, then submit the existing continuation prompt.
- `OFFER`: show the answer, then submit the existing offer prompt.

The continuation prompt identifies any displayed replay as historical text. It does not ask the replacement agent to answer the same question again.

Existing open-offer behavior remains intact. Replay itself does not reopen a resolved offer or turn an unaccepted recommendation into work.

A successful handoff shows the answer at most once. Cancelled handoffs do not show a replay in another session.

## Error Handling

Generation errors keep the existing session and disable automatic retries, as they do today.

If replay delivery fails after replacement, the extension must preserve the answer in the replacement editor and show an error notice. It must not start automatic work after this failure.

The editor fallback also preserves the generated handoff prompt. Neither the answer nor the checkpoint can overwrite the other.

Existing context-injection and submission failures retain their safe fallback behavior. A failed `WAIT` context injection must preserve any selected answer with the checkpoint.

## Module Boundaries

- `extensions/handoff-generation.ts` owns the classification prompt and response protocol.
- `extensions/handoff.ts` owns source capture, replacement delivery, and failure handling.
- A small answer-specific module can own candidate selection and text extraction if those rules obscure the orchestration.

No unrelated refactor or dependency update belongs in this change.

## Verification

Behavioral tests must cover:

- Valid positive and negative replay controls.
- Missing, malformed, and contradictory controls.
- Exact text preservation, including multiline Markdown and multiple text blocks.
- Exclusion of thinking, tool calls, failed responses, and superseded answers.
- Candidate capture before preparation, despite a later preparation report.
- A positive decision without a candidate.
- `WAIT` replay without an agent turn.
- Replay before `CONTINUE` and `OFFER` submission.
- No replay for negative or uncertain decisions.
- No duplicate replay after repeated settlement events.
- Manual handoff, cancellation, stale-context guards, and delivery-error fallbacks.

Automated tests prove parsing and delivery behavior, not semantic accuracy from a mocked model. Prompt review must cover direct questions and autonomous-report counterexamples.

A bounded live classification check can assess those examples. It is not a deterministic correctness guarantee and must be reported separately from automated tests.

Run the focused tests, extension-load check, and full flake check:

```sh
node --test \
  tests/extensions/handoff-auto.test.ts \
  tests/extensions/handoff-generation.test.ts \
  tests/extensions/handoff.test.ts

nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

Any new answer-specific test file must also run with the focused tests.

## Acceptance Criteria

- A positively classified direct answer appears verbatim after automatic handoff.
- Negative or uncertain classification produces no replay.
- Preparation never replaces the original answer candidate.
- Replay alone starts no model turn and performs no tools or repository changes.
- Existing continuation actions and manual handoff retain their behavior.
- Errors preserve the answer and checkpoint without starting unintended work.
- Tests cover the behavior and failure paths. The final report states the limits of model-assisted classification.
