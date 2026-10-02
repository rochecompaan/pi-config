# Interrupted assistant exchanges in context paging

## Approved scope

Correct the diagnosed paging error after an aborted or errored assistant response.
The user approved the patch on 2026-10-02.
Change history projection and provider-context selection, with regression tests.
Do not change token accounting, configuration, dependencies, or release versions.

## Cause

Pi can persist an assistant response with partial tool calls and `stopReason: "aborted"` or `"error"`.
Pi ends that turn before tool execution, so missing results do not prove lost execution records.
Current paging validators require all results after a later user message.
This causes `INCOMPLETE_TOOL_RESULTS` in history and `INVALID_MESSAGE_STRUCTURE` in context selection.
The context event then aborts the provider request.

Pi applies `transformContext` before `convertToLlm` and provider normalization.
Paging therefore sees these raw assistant responses.
Pi's provider transform skips aborted/error assistant messages because partial response content cannot safely replay.

References:

- `https://raw.githubusercontent.com/earendil-works/pi/v0.87.1/packages/agent/src/agent-loop.ts`
- `https://raw.githubusercontent.com/earendil-works/pi/v0.87.1/packages/ai/src/api/transform-messages.ts`

## Behavior

### Raw history

A terminal aborted/error assistant response is a history item, including at the branch tail.
Its tool calls and actual results remain unchanged and recoverable.
Zero, some, or all matching results are valid for this terminal response.
The failed-search metadata marks the response as failed.
No result is created for an unexecuted tool.

Normal incomplete exchanges retain their existing rules.
Projection can omit the newest pending exchange, but rejects older incomplete normal exchanges.
Duplicate, mismatched, and orphan results remain errors, including near interrupted responses.

### Provider context

Validate actual matching results before omission.
Exclude aborted/error assistant responses and their contiguous matching results from provider selection.
This avoids replay of partial reasoning/tool calls and prevents orphan results after the assistant is omitted.
Raw history still holds every actual result.

Normalize before grouping, selection-token estimation, the within-budget return, and paging.
Keep outgoing-only provenance aligned with each surviving message.
If measured usage describes the incoming snapshot, preserve its calibration offset and subtract the estimates of omitted messages.
Apply the same behavior to prefix messages, completed turns, and the active turn.
An interrupted response cannot receive unread-result overflow protection.
Do not change FIFO eviction or protection of genuine complete tool exchanges.
Keep surviving message objects unchanged.

### Module boundaries

Use a small shared predicate for the terminal interrupted state only if both paths need it.
Keep context-only normalization beside its validation boundary or in a focused module.
Do not reorganize unrelated policy code.

## Regression checks

- Aborted/error tool calls followed by a user message no longer fail either path.
- Failed responses with no tool calls also remain in raw history and leave provider context.
- Zero, some, and all actual results remain recoverable without synthetic results.
- Duplicate, mismatched, and orphan results still fail validation.
- Genuine incomplete non-interrupted exchanges still fail or retain the existing pending-tail behavior.
- Provider normalization works within budget and during paging.
- The newest genuine complete result still receives its one-follow-up protection.
- Session start, resume, and branch navigation do not rewrite raw history.
- All paging tests and the configured extension-load check pass.

## Isolation and integration

The patch uses branch `fix/context-interrupted-exchanges` in its own roche-pi worktree.
The accounting-fix session owns a different worktree and receives the reviewed patch before integration.
The standalone package maintainer receives a handoff for a later release.
Do not change the published `v0.1.0` artifact or any live session.
Local merge, deployment, and release require separate approval.

The accounting fix landed separately at `06f098706ab3155169f7c778e2c9834fd442257c`.
Rebase this patch onto that commit and retain its APIs, tests, provenance protection, and accounting rules.
