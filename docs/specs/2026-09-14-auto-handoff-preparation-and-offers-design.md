# Prepared Automatic Handoff and Open Recommendation Re-Offer Design

**Date:** 2026-09-14
**Status:** Approved for implementation planning

## Purpose

The automatic handoff extension currently preserves open recommendations in generated context, but a `WAIT` handoff does not start a replacement-agent turn. The user therefore does not see those recommendations again.

The current flow also generates the handoff immediately. It gives the active agent no opportunity to preserve detailed requirements in persistent todos before the session changes.

This change adds a preparation turn before every automatic handoff. The active agent first assesses whether detailed context needs persistent todo storage. After that turn settles, the extension generates the handoff and changes sessions. The replacement agent proactively re-offers unanswered recommendations when no executable request takes priority.

## Goals

- Run an agent preparation turn before automatic handoff prompt generation.
- Instruct the active agent to create or update todos when detailed requirements or context need durable storage.
- Do not create placeholder or unnecessary todos.
- Keep the user conversation separate from the internal preparation transcript.
- Preserve relevant todo IDs in the generated handoff prompt.
- Re-offer unanswered assistant recommendations in the replacement session.
- Re-ask a final unanswered offer directly.
- Give a one-sentence user-topic recap before older unanswered recommendations.
- Keep executable unfinished user work distinct from optional recommendations.
- Keep manual `/handoff <goal>` behavior unchanged.
- Preserve the existing cancellation, retry-disable, session-replacement, and fallback safeguards.

## Non-Goals

- Automatically derive todo files without an agent turn.
- Create a todo for every automatic handoff.
- Replace the todo tool or change its persistence format.
- Treat assistant recommendations as approved work.
- Act on a recommendation before the user accepts it.
- Change the token threshold, countdown duration, compaction policy, or manual handoff editor flow.
- Add a second user confirmation after the existing countdown.

## Terms

- **User conversation:** The conversation state captured before automatic preparation starts. It determines unfinished work, open recommendations, and recommendation recency.
- **Preparation turn:** An internal agent turn in the current session that assesses continuity needs and uses the todo tool when durable detail is warranted.
- **Preparation transcript:** Messages produced after the preparation boundary. It supplies todo IDs and continuity notes but does not alter recommendation recency.
- **Open recommendation:** An explicit recommendation or offer from the assistant that the user has neither accepted nor declined.
- **Direct re-ask:** A replacement response that immediately repeats a final unanswered offer.
- **Contextual reminder:** A replacement response that gives a one-sentence recap of the latest relevant user topic, then reminds the user about unanswered recommendations.

## Current Behavior and Problem

`handoff-generation.ts` currently returns `continue` or `wait`. Its prompt asks the generator to list open recommendations, but it also says that a replacement agent may re-surface them only when the user asks for direction.

`handoff.ts` submits a `continue` prompt with `sendUserMessage()`, which starts a replacement turn. It injects a `wait` prompt as context with `triggerTurn: false`. An automatic handoff with completed work and open recommendations therefore switches sessions without showing the recommendations to the user.

Automatic prompt generation also starts as soon as the countdown completes. Although file-based todos survive session changes, the current agent cannot create or update them as part of the handoff process.

## Architecture

The existing module boundaries remain:

- `extensions/handoff-auto.ts` owns command parsing and pure automatic state transitions.
- `extensions/handoff.ts` owns countdown, preparation orchestration, transcript capture, generation, and session replacement.
- `extensions/handoff-generation.ts` owns the generation contract, action parsing, and replacement prompt policy.

The todo extension remains independent. The handoff extension instructs the agent to call the registered `todo` tool; it does not read or write todo files directly.

## Automatic State Model

The automatic state model distinguishes each asynchronous phase:

- `armed`: waiting for the threshold.
- `countdown`: the threshold was reached and the cancellation UI is active or queued.
- `preparing`: the preparation agent turn is active or waiting to settle.
- `finalizing`: preparation settled and the internal finalization command is queued or running.
- `disabled`: automatic attempts are blocked until `/handoff auto on`.

Required transitions:

1. `session-start` moves to `armed`.
2. `threshold-reached` moves from `armed` to `countdown`.
3. An accepted countdown snapshots the source conversation and moves to `preparing` before it starts the preparation turn.
4. The next valid `agent_settled` event moves from `preparing` to `finalizing` before it dispatches finalization.
5. Automatic cancellation or failure moves to `disabled`.
6. `/handoff auto off` moves to `disabled` from any active state.
7. `/handoff auto on` moves to `countdown` when usage is already at the threshold; otherwise it moves to `armed`.

The transition to `finalizing` happens before command dispatch so duplicate `agent_settled` events cannot finalize twice.

## Automatic Flow

1. `agent_settled` checks interactive mode, idle state, automatic state, context usage, and threshold.
2. The extension enters `countdown` and dispatches the existing internal automatic command.
3. The command shows the five-second cancellation countdown.
4. If the user cancels, automatic handoff becomes `disabled` as it does today.
5. If the countdown completes, the extension captures:
   - the current session file;
   - the user-conversation messages used for final generation;
   - a branch boundary used to identify later preparation messages.
6. The extension enters `preparing`.
7. It sends a visible custom `handoff-preparation` message with `triggerTurn: true` while the agent is idle.
8. The active agent performs the preparation contract and settles.
9. The `agent_settled` handler enters `finalizing`, collects the preparation transcript after the saved boundary, and dispatches an internal finalization command.
10. The finalization command generates a handoff from the captured user conversation plus the separate preparation transcript.
11. The command creates the replacement session.
12. The replacement callback routes the generated action:
    - `CONTINUE` starts a replacement turn.
    - `OFFER` starts a replacement turn.
    - `WAIT` injects context without starting a turn.

Session replacement remains inside a command handler because `ctx.newSession()` is command-only. Post-switch work uses only the replacement context supplied to `withSession`.

## Preparation Contract

The custom preparation message identifies itself as extension policy, not as a user request. It instructs the current agent to do only handoff preparation.

The agent must:

1. Review the current objective, detailed requirements, acceptance criteria, decisions, constraints, progress, relevant files, blockers, and concrete next steps.
2. Assess whether a concise generated handoff can safely preserve that information.
3. Use the todo tool to inspect relevant existing todos when needed to avoid duplication.
4. Create, update, or append to todos when detailed information needs durable storage.
5. Put useful detail in each todo body, including the task goal, requirements, decisions, current state, and next action when applicable.
6. Avoid placeholder, duplicate, speculative, or unnecessary todos.
7. Finish with a short preparation report that lists each created or updated todo ID, or states that no todo was warranted.

The preparation turn must not continue implementation work, choose an open recommendation for the user, or craft the final handoff prompt. Prompt generation starts only after preparation settles.

## Conversation and Preparation Separation

The extension snapshots the user conversation before it sends the preparation message. Final generation serializes two labeled inputs:

1. `User Conversation`
2. `Automatic Handoff Preparation`

The generation policy must use only `User Conversation` to decide:

- whether explicit user work remains unfinished;
- whether recommendations remain open;
- whether an open offer was the final exchange;
- whether later user messages require a contextual reminder.

The policy uses `Automatic Handoff Preparation` only for todo IDs, todo status, continuity detail, and preparation failures. Internal preparation instructions and responses are not user intent and cannot open, close, or age a recommendation.

The generated prompt includes a `Continuity Todos` section. It lists the reported todo IDs and explains when the replacement agent should read them. It writes `None.` when preparation found no warranted todo.

## Generated Handoff Actions

The generation protocol accepts exactly three action lines:

```text
HANDOFF_ACTION: CONTINUE
HANDOFF_ACTION: OFFER
HANDOFF_ACTION: WAIT
```

Action priority is:

1. `CONTINUE` when an explicit unfinished user request exists and the replacement agent can make progress without more user input.
2. `OFFER` when no executable request takes priority and at least one recommendation remains open.
3. `WAIT` when neither condition applies.

Open recommendations remain optional. They must not become implementation instructions or executable next actions.

### `CONTINUE`

The generated prompt contains:

- `Context`
- `Unfinished User Request`
- `Current State`
- `Continuity Todos`
- `Next Action`
- `Open Recommendations`

The replacement agent continues only the explicit unfinished request. It does not act on listed recommendations unless the user later accepts them.

### `OFFER`

The generated prompt contains:

- `Context`
- `Current State`
- `Continuity Todos`
- `Open Recommendations`
- `Instruction`

The instruction selects one presentation mode from the user conversation:

- **Direct re-ask:** Use this when an open offer was the final assistant message and no user message followed it. The replacement agent immediately repeats the offer, close to its original wording, and asks for the user's choice.
- **Contextual reminder:** Use this when one or more later user messages followed without accepting or declining the offer. The replacement agent starts with one short sentence that summarizes only the latest relevant user topic. It then lists every still-open recommendation and asks the user to respond.

The replacement response must not imply that the user approved a recommendation. It must not begin work on one.

### `WAIT`

The generated prompt keeps the existing context-only delivery and explicit instruction to wait for the user. With the action priority above, `WAIT` normally has no open recommendations.

## Recommendation Lifecycle

An assistant recommendation becomes open when it explicitly offers a choice, next step, or optional action to the user.

It remains open across later unrelated questions and answers. It closes only when the user:

- accepts it;
- declines it;
- chooses an incompatible alternative; or
- explicitly withdraws the need for a response.

A completion report, passing tests, a clean worktree, unpushed commits, residual risks, and possible follow-ups do not become open recommendations unless the assistant explicitly offered them to the user.

When multiple recommendations remain open, `OFFER` presents all of them concisely. The contextual introduction still summarizes only the latest relevant user topic.

## Delivery and Session Replacement

`GeneratedHandoff.action` becomes `continue | offer | wait`.

The replacement callback treats `offer` like `continue` for delivery: it calls `replacementCtx.sendUserMessage(stagedPrompt)` and waits for the resulting submission. The prompt tells the replacement agent to ask rather than act.

The callback treats `wait` as it does today: it calls `replacementCtx.sendMessage()` with `triggerTurn: false`.

Manual handoffs continue to open the generated prompt in the editor instead of submitting it.

## Error Handling

- If the countdown fails or is cancelled, disable automatic retries and show the existing re-enable guidance.
- If the preparation message cannot be sent, disable automatic retries and notify the user.
- If no todo is warranted, preparation succeeds and finalization continues.
- If the todo tool is unavailable or a todo call fails, the preparation agent reports the failure. Finalization continues with the best available inline context.
- If preparation settles without the requested report format, finalization still receives the available preparation transcript. The generator must not invent todo IDs.
- If internal finalization dispatch fails, disable automatic retries and notify the user.
- If generation returns an invalid action, including malformed `OFFER` output, use the existing invalid-action failure path.
- If `OFFER` or `CONTINUE` submission fails after session replacement, stage the generated prompt in the replacement editor and notify the user.
- If `WAIT` context injection fails, stage the checkpoint in the replacement editor and notify the user.
- If session replacement is cancelled or fails, keep the existing automatic failure behavior.

## Testing Strategy

Automated tests use the existing `node:test` harness and prove behavior rather than exact policy wording.

### State policy tests

- Threshold transition enters `countdown` only from `armed`.
- Accepted preparation enters `preparing`.
- Preparation settlement enters `finalizing` exactly once.
- Cancellation, dispatch failure, and explicit disable enter `disabled`.
- Re-enable selects `armed` or `countdown` from current usage.

### Orchestration tests

- An accepted automatic countdown starts preparation and does not generate a handoff yet.
- The preparation message is a custom internal message that starts an agent turn.
- The first valid preparation settlement dispatches finalization once.
- Final generation receives the pre-preparation user snapshot separately from preparation messages.
- A no-todo preparation report still proceeds.
- Preparation dispatch failure disables retries.
- Manual handoff does not run preparation.

### Generation contract tests

- `HANDOFF_ACTION: OFFER` parses to `offer`.
- Unknown action lines remain invalid.
- Existing `CONTINUE`, `WAIT`, abort, provider-error, truncation, and empty-output behavior remains.

### Replacement delivery tests

- `OFFER` submits the generated prompt and starts a replacement-agent turn.
- `CONTINUE` retains its current submitted behavior.
- `WAIT` retains context-only behavior.
- `OFFER` submission failure stages the prompt in the editor.

Exact prompt prose and todo-instruction text are static policy. The Testing Value Gate excludes brittle tests that merely assert those strings. Review and direct source inspection verify that wording, while behavioral tests verify the state and delivery contracts that make it effective.

## Verification

Run the focused handoff tests first, followed by the repository's extension-load and flake checks:

```sh
node --test --experimental-strip-types \
  tests/extensions/handoff-auto.test.ts \
  tests/extensions/handoff-generation.test.ts \
  tests/extensions/handoff.test.ts

nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

At design time, the full flake baseline has an unrelated `checks.x86_64-linux.jailed-github-broker` timeout. Another agent is addressing that failure. This task must still run the full check and report any remaining baseline or feature-related failures accurately.

## Acceptance Criteria

- Every accepted automatic handoff runs preparation before prompt generation.
- The preparation agent is explicitly instructed to use the todo tool when detailed context warrants durable storage.
- Preparation creates no placeholder todo when no detailed context warrants one.
- Handoff generation starts only after the preparation turn settles.
- Recommendation analysis ignores the internal preparation transcript.
- The replacement prompt carries every reported continuity todo ID without inventing IDs.
- A final unanswered offer is re-asked immediately in the replacement session.
- An older unanswered offer is preceded by a one-sentence summary of the latest relevant user topic.
- Every still-open recommendation is presented for a user response.
- The replacement agent does not act on a recommendation before acceptance.
- `OFFER` starts a replacement-agent turn.
- `WAIT` still starts no replacement-agent turn.
- Manual handoff behavior remains unchanged.
- Automatic failures retain a safe editor or notification fallback and do not retry repeatedly.
