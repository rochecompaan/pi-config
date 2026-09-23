# Context Paging Design

## Goal

Keep the full model input near 64,000 estimated tokens without summarizing normal session history.

The extension removes the oldest coherent context first. It keeps recent messages and tool results unchanged when they fit.

The raw session remains the source for search and exact recovery.

## Fixed requirements

- The normal input budget is exactly 64,000 estimated tokens.
- The budget covers the system prompt, active tool definitions, messages, tool calls, tool results, and the paging notice.
- Token estimates use Pi's exported `estimateTokens` function.
- Context removal is oldest-first.
- A tool call and its results are atomic.
- Completed old user turns leave with their answers.
- The active user request remains available during a long tool-driven turn.
- A tool result stays unchanged when the complete input fits.
- The newest unread tool-result batch can exceed the normal budget for one follow-up model call.
- Raw session entries never change.
- The model receives a clear notice when context leaves the rolling window.

## Scope

This change restores the no-ledger context-paging extension with a corrected context policy.

The extension provides these tools:

- `search_history`
- `browse_history`
- `load_history`
- `read_context_output`

The change also restores the required Nix packaging and runtime checks.

## Exclusions

This change does not add:

- a persistent paging ledger
- a task-state tool
- provider-specific tokenizers
- model-specific token settings
- a managed `loadout.json`
- an optional named loadout profile
- special integration with automatic handoff.

Automatic handoff has a higher token trigger than the paging budget. The context-paging extension does not add coupling to it.

## Architecture

The extension uses two separate context views.

```text
Raw active branch  -> navigator and exact history recovery
Pi event.messages  -> rolling model context
```

Pi remains responsible for canonical context construction. The extension filters the deep copy in the `context` event.

The raw active branch supplies stable history IDs. It also supplies the original content for history tools.

The extension does not persist a second index. It rebuilds the in-memory navigator from raw session records.

## Module layout

The extension uses these focused modules:

- `history.ts` projects raw branch records into stable history items.
- `navigator.ts` implements search and browse operations.
- `context-policy.ts` groups canonical messages and selects the rolling context.
- `output-pages.ts` reads exact pages from raw evicted output.
- `tools.ts` defines the four public tools.
- `index.ts` connects settings, lifecycle hooks, compaction policy, and context replacement.

`output-pages.ts` does not replace normal output based on a fixed byte threshold.

## Configuration

Package this setting:

```json
{
  "contextPaging": {
    "enabled": true
  }
}
```

Global settings provide the default. A trusted project setting can override `contextPaging.enabled`.

An untrusted project setting cannot override the global value. A missing or non-boolean value uses the global or packaged value.

The extension always registers the four tools. When paging is disabled, each tool returns a clear disabled error.

When paging is disabled, the extension does not replace context or intercept compaction.

## Token accounting

### Budget

The normal full-input budget is:

```ts
const CONTEXT_TOKEN_BUDGET = 64_000;
```

The active model can declare a smaller context window. The normal budget is `Math.min(64_000, ctx.model.contextWindow)`.

### Pi estimator

Import Pi's existing estimator:

```ts
import { estimateTokens } from "@earendil-works/pi-coding-agent";
```

Use `estimateTokens` for each canonical message.

Convert the system prompt into a temporary user-text message for estimation. Do not add this temporary message to outbound context.

Serialize active tool definitions as `{ name, description, parameters }`. Convert the serialized value into another temporary user-text message for estimation.

The complete estimate is:

```text
system-prompt estimate
+ active-tool estimate
+ retained-message estimates
+ paging-notice estimate
```

The UI and errors call this value an estimate. The extension does not claim exact provider tokenization.

### Active tools

Get active tool names from `pi.getActiveTools()`. Resolve definitions through `pi.getAllTools()`.

Inactive tool schemas do not consume the budget.

## Context units

### Tool exchange

An assistant message with tool calls and all matching tool results forms one atomic tool exchange.

The selector never emits an assistant tool call without every matching result. It never emits an orphaned tool result.

Parallel tool calls and their results stay in one exchange.

### Completed user turn

A completed user turn contains:

1. its user message
2. all assistant messages and tool exchanges after it
3. all content before the next user message.

The selector removes a completed turn as one unit during normal oldest-first eviction.

### Active user turn

The newest user message starts the active turn. The selector keeps this user message while the model works on that request.

If the active turn exceeds the budget, the selector removes its oldest completed assistant exchanges first. It keeps the newest exchanges.

This split prevents an old completed request from surviving without its answer. It also preserves the current task during a long tool-driven run.

### Canonical prefix messages

Pi can place a compaction summary or branch summary before normal user turns. Treat each summary as an oldest prefix unit.

The selector can remove a prefix unit through normal oldest-first eviction.

## Normal selection algorithm

For each `context` event:

1. Read the canonical deep copy from `event.messages`.
2. Group the messages into prefix units, completed user turns, and the active user turn.
3. Identify a protected newest tool exchange, if one exists.
4. Estimate the resident system prompt and active tools.
5. Estimate the full unmodified candidate.
6. Return the unmodified messages when the candidate fits.
7. Remove the oldest completed units until the candidate fits.
8. If necessary, remove the oldest completed exchanges inside the active turn.
9. Add one generated paging notice when removal occurs.
10. Include the notice in the token estimate.
11. Continue removal until the candidate and notice fit.
12. Return messages in their original order after the notice.

The selector recalculates this result for every model call. It does not store a rolling boundary.

## Newest tool-result overflow

### Protected first follow-up

A trailing assistant tool call and its matching trailing tool results form the newest unread tool exchange.

The selector keeps this complete exchange for the first follow-up model call. It removes older context before it considers an overflow.

If the protected exchange causes the input to exceed 64,000 tokens, the selector permits one temporary overflow.

The overflow notice tells the model:

- that the newest result is present in full
- that the normal budget is 64,000 tokens
- that the result can leave context after this call
- which history tools can retrieve it later.

The raw branch position determines whether the exchange is unread. No persistent marker is necessary.

### Subsequent calls

After the model responds, the exchange loses protection. Normal oldest-first selection can remove it on a subsequent call.

If removal occurs, the paging notice includes:

- the tool name
- the history ID
- the tool-call ID
- exact `read_context_output` arguments.

### Actual model limit

The temporary overflow cannot exceed the active model's declared context window.

If the protected exchange cannot fit within that window, replace the required result payloads with compact recovery notices.

Preserve the assistant tool calls and result envelopes.

This replacement is an emergency provider-limit guard. It is not a normal size threshold.

## Paging notice

The extension creates at most one paging notice per provider call.

The notice is a synthetic user message and is not stored in session history. Its label states that the extension generated it.

The notice starts with this label:

```text
[Context paging notice — generated by the extension]
```

A normal eviction notice states:

- that older context left the 64,000-token rolling window
- that the raw history remains available
- how to use `search_history` or `browse_history`
- how to use `load_history` or `read_context_output`.

A specific oversized-result notice also includes its stable recovery reference.

The selector places the notice before the retained conversational messages. The notice counts against the budget.

The extension rebuilds the notice on each call. Notices never accumulate.

## Raw history model

### Source of truth

Use `ctx.sessionManager.getBranch()` for navigation and recovery only.

Project these stored roles:

- user
- assistant
- tool result.

A user entry forms one user history item. An assistant entry and its contiguous matching tool results form one model-turn history item.

Keep the complete stored message objects. Do not rewrite their content or metadata.

### Stable identity

Use the stored assistant entry ID as the history ID for a model turn. Use the stored user entry ID for a user item.

References remain valid after the source content leaves model context. They also remain valid after reload or resume on the same active branch.

### Paging-tool exclusion

Exclude a model turn from the navigator when its assistant message calls one of the four paging tools.

The user request that caused the paging-tool turn remains searchable.

This rule prevents recursive indexing. It does not remove the paging-tool exchange from normal canonical context.

## Tool contracts

All schemas use strict root objects with `additionalProperties: false`.

### `search_history`

Parameters:

```ts
{
  query: string;
  files?: string[];
  tools?: string[];
  failed?: boolean;
  limit?: number;
  load?: boolean;
}
```

The query is at most 200 characters. Each filter list contains at most 10 values.

`limit` is an integer from 1 through 10. Its default is 5.

Search stored content, tool names, and file-like arguments without case sensitivity. Apply all supplied filters.

Without `load`, return bounded references with previews of at most 160 characters. Bound the serialized response to 8,000 characters.

With `load: true`, load the first three matching atomic items exactly.

### `browse_history`

Parameters:

```ts
{
  historyId?: string;
  sequence?: number;
  direction: "backward" | "forward" | "around";
  count?: number;
  stride?: number;
}
```

Accept `historyId` or `sequence`, but not both.

With an explicit anchor, `backward` and `forward` exclude the anchor. `around` includes its anchor.

Without an anchor, `backward` starts at the newest item. `forward` starts at the oldest item.

Return bounded references. Apply the same 8,000-character response limit as `search_history`.

### `load_history`

Parameters:

```ts
{
  historyIds: string[];
}
```

Accept one through three IDs. Resolve the request atomically.

If one ID is invalid, return an error and no partial items. Otherwise, return exact items in the requested order.

### `read_context_output`

Parameters:

```ts
{
  historyId: string;
  source: "assistant" | "toolResult";
  contentIndex?: number;
  toolCallId?: string;
  offset?: number;
  limit?: number;
}
```

For `source: "assistant"`, require `contentIndex` and reject `toolCallId`.

For `source: "toolResult"`, require `toolCallId` and reject `contentIndex`.

Resolve the value from the raw active branch. Return exact serialized JSON pages.

Keep the existing maximum page size of 2,000 characters. Return `offset`, `nextOffset`, `totalCharacters`, and `text`.

## Lifecycle

Maintain one in-memory navigator for the active session runtime.

Rebuild it on:

- `session_start`, including startup, new, resume, fork, and reload
- `turn_end`
- successful `session_tree` navigation.

The `context` hook uses `event.messages` even when the navigator is stale or unavailable.

Tree navigation remains available. Do not cancel `session_before_tree`.

After navigation, history tools describe only the new active branch.

## Compaction

Context paging prevents normal context growth from reaching Pi's automatic compaction threshold.

While paging is enabled:

- cancel `session_before_compact` when the reason is `threshold`
- cancel `session_before_compact` when the reason is `overflow`
- allow manual `/compact`.

If the session already contains a compaction, use Pi's canonical summary from `event.messages`.

Do not rebuild model context from messages before the compaction boundary. Those raw messages remain available through the history tools.

When paging is disabled, do not intercept compaction.

## Error handling

### Resident input overflow

If the system prompt and active tools exceed the usable budget, abort the provider call.

Show the estimated resident token count and the active budget.

### Active request overflow

If the resident input and active user request exceed the usable budget, abort the provider call.

Do not discard part of the current user request.

### History failure isolation

A raw-history projection or navigator error disables history retrieval for that operation. Show a clear error.

The error does not abort a valid context-selection operation. Context selection uses canonical messages independently.

### Invalid message structure

If canonical messages contain an orphaned tool result or an incomplete older exchange, abort the provider call.

Do not send a malformed tool protocol to the model.

### Storage safety

Never mutate stored session entries. Never write paging placeholders into raw history.

## Default loadout

Do not package or manage `~/.pi/agent/loadout.json`.

With no saved loadout, pi-loadout enables all available tools and skills. The runtime check verifies that the four paging tools are active.

A user-managed loadout can disable individual paging tools. The extension keeps a stable registered tool catalog.

## Testing

Use test-driven development for all production behavior.

Required behavioral tests cover:

1. The extension registers exactly the four paging tools.
2. The extension does not register `update_task_state`.
3. The budget is exactly 64,000 estimated tokens.
4. System prompt and active tool schemas consume the budget.
5. All token estimates use Pi's exported `estimateTokens` behavior.
6. The selector removes oldest completed turns first.
7. The active user request remains during a split active turn.
8. Tool calls and matching results remain atomic.
9. Parallel tool batches remain atomic.
10. Old user requests do not remain without their completed answers.
11. A result larger than 16,000 bytes remains unchanged when it fits.
12. The newest unread tool batch remains complete for one follow-up call.
13. The selector permits only that protected batch to exceed the normal budget.
14. The protected batch becomes evictable after the model responds.
15. The eviction notice contains a usable raw-history reference.
16. A protected result above the model limit becomes a recovery notice.
17. A paging notice counts against the normal budget.
18. Paging notices do not accumulate in stored history.
19. Existing compaction summaries in canonical messages remain available until FIFO eviction removes them.
20. Automatic compaction is cancelled while manual compaction remains available.
21. Navigator errors do not abort valid context selection.
22. Stored raw messages remain unchanged.
23. Search, browse, exact load, and output-page validation retain their existing contracts.
24. Resume, reload, fork, and tree navigation rebuild the active-branch navigator.
25. A regression fixture based on the observed session keeps recent task state coherent.

The regression fixture includes old completed requirements, a recent simple request, and repeated tool exchanges.

The selected context must not expose old requests without their answers.

## Direct verification

Do not add tests that assert static JSON, Nix text, or package-lock content.

Use these direct checks:

- parse `settings.json`
- inspect package contents
- run the focused context-paging test suite
- run the full TypeScript test suite
- run `nix build .#checks.x86_64-linux.pi-config-extension-load --no-link`
- run `nix flake check --accept-flake-config --print-build-logs`
- reload a live Pi session
- execute all four paging tools
- inspect context usage as history grows.

The live context must grow toward approximately 64,000 estimated tokens. It must not remain near the previous 30,000-token ceiling.

## Acceptance criteria

The change is complete when:

- the rolling full-input budget is 64,000 estimated tokens
- Pi's `estimateTokens` implementation supplies all estimates
- the selector operates on canonical `event.messages`
- normal output remains complete when it fits
- oldest coherent context leaves first
- the active request remains coherent
- the newest unread tool batch receives one full follow-up call
- evicted output has clear recovery instructions
- raw history remains unchanged and searchable
- automatic compaction does not replace the paging window
- manual compaction remains available
- the default loadout remains unmanaged
- all automated and direct checks pass.
