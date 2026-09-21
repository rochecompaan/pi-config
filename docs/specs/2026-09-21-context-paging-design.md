# Context Paging Design

**Status:** Approved

## Goal

Add a production Pi extension that keeps long sessions useful without a task ledger. The extension ports the promoted no-ledger paging behavior associated with `113e1d629f6dd556d97e920146f9830dd3a864f7` from `tiny-llm-context`, adapts it to normal Pi sessions, and enables it in the packaged Roche Pi configuration.

The extension must expose exactly these paging tools:

- `search_history`
- `browse_history`
- `load_history`
- `read_context_output`

It must not expose `update_task_state` or maintain any equivalent ledger.

## Scope

The implementation will live under `extensions/context-paging/` as a normal Pi extension factory. Supporting changes will update packaged settings, automatic handoff defaults, and the runtime extension-load probe. The packaged configuration will not manage the user's pi-loadout selection.

The reference repository supplies proven paging semantics, not a package to import. The Roche Pi port will use local focused modules and current Pi 0.85.1 APIs.

## Explicit exclusions

Do not port or add:

- `update_task_state`, a task ledger, ledger revisions, todo tools, todo state, or a bounded user-state register
- experiment runners, fixtures, graders, campaign code, experiment telemetry, or campaign manifests
- GLM-only checks, a pinned tokenizer, a provider gateway, spend accounting, or final-wire admission
- experiment environment variables, callbacks, fatal-state objects, or experiment-specific custom entries
- a compatibility shim that copies the experiment layout unchanged
- an external context-paging package or new pinned dependency

The extension must not rewrite raw session entries. Paging changes only the outbound context view.

## Package layout

Use focused modules with one responsibility each:

- `extensions/context-paging/index.ts`: extension factory, settings resolution, Pi lifecycle hooks, tool registration, and user notices
- `extensions/context-paging/history.ts`: active-branch projection into atomic history items and paging-tool-turn classification
- `extensions/context-paging/navigator.ts`: search, browse, exact load, validation, and compact references
- `extensions/context-paging/context-policy.ts`: budget accounting, history selection, complete-turn retention, and outbound message construction
- `extensions/context-paging/output-pages.ts`: large-output placeholders and exact page recovery
- `extensions/context-paging/tools.ts`: the four public Pi tool definitions

Tests may use a local fixture helper, but production modules must not contain test-only seams or experiment abstractions.

## Configuration

Add this packaged setting:

```json
{
  "contextPaging": {
    "enabled": true
  }
}
```

Global settings are the default. A trusted project setting can override `contextPaging.enabled`; an untrusted project setting cannot. A missing or non-boolean value falls back to the packaged/global value. When disabled, the extension still registers the four tools so Pi and pi-loadout can discover a stable tool catalog, but their executions fail with a clear disabled message and the extension does not replace context or cancel compaction. Tool activation order therefore cannot bypass the setting.

No model, provider, tokenizer, or context-window value is stored in configuration.

## History model

### Source of truth

Use `ctx.sessionManager.getBranch()` as the source for navigation, selection, and output recovery. This is the raw active path from the current leaf to the root. Do not use compacted context as the recovery source because compaction can discard the exact predecessor record.

Only session `message` entries become searchable history. Ignore custom entries, loadout state, model changes, labels, branch summaries, and compaction summaries.

Project the active branch into ordered atomic items:

- A user item contains one stored user message.
- A model-turn item contains one stored assistant message and all following tool-result messages that resolve tool calls from that assistant message.
- Assistant/tool-result exchanges remain atomic. Never emit a tool result without its tool call or split a complete turn during selection.
- Stable history IDs come from stored session entry IDs. Sequence numbers are recomputed from active-branch order after each rebuild.
- An incomplete newest assistant turn may be absent until `turn_end`; malformed older exchanges produce a clear projection error rather than a disconnected context.

### Paging-tool turn exclusion

Exclude a complete model turn from the navigator when its assistant message calls any of the four paging tools. The excluded set is:

```text
search_history
browse_history
load_history
read_context_output
```

This prevents searches and output reads from recursively indexing their own results. The user request that caused a paging-tool turn remains a retained user item.

Paging-tool turns remain eligible for outbound context selection as ordinary atomic complete turns. In particular, the provider request immediately after a paging tool runs must include that assistant tool call and its result when the newest-contiguous-suffix policy retains the turn. Exclusion affects only navigator indexing, search, browse, and exact history loading.

`read_context_output` resolves against every raw predecessor model turn on the active branch, including predecessor paging-tool turns. This permits sequential reads when a large paging-tool result was replaced with an output reference.

## Lifecycle and restoration

Maintain one in-memory navigator for the active session runtime.

Rebuild it from the raw active branch on:

- `session_start` for `startup`, `new`, `resume`, `fork`, and `reload`
- `turn_end`
- `session_tree` after navigation succeeds

The `context` hook also derives the current selection from the raw active branch, so stale in-memory state cannot change provider input if an event ordering edge case occurs.

Tree navigation remains available. Do not cancel `session_before_tree`. After `session_tree`, searches, loads, output references, and sequence numbers must describe only the newly active branch.

The extension does not persist a secondary index. Resume, fork, reload, and tree changes are restored entirely from raw session records.

## Context budget

Budget against the active model on every `context` event. Use `ctx.model.contextWindow`; do not key behavior by provider or model name.

The measured input includes:

- the current chained system prompt from `ctx.getSystemPrompt()`
- the name, description, and JSON schema of every currently active tool
- the selected outbound messages

Use a conservative, model-agnostic estimator: the UTF-8 byte length of the serialized resident context and selected messages is the accounting value. One byte is treated as one token-equivalent unit so dense, non-ASCII, or machine-generated data cannot be undercounted by a characters-divided-by-four heuristic.

The maximum measured input is 60 percent of `ctx.model.contextWindow`, rounded down. This preserves 40 percent for provider framing, hidden input, tokenizer variance, reasoning, and output without relying on `maxTokens` or provider-specific rules.

If there is no active model, `contextWindow` is not a positive finite integer, or mandatory content exceeds the budget, abort that provider turn and show a clear notice. Do not set an injected fatal-state marker. Do not silently discard user requests.

## Selection policy

The mandatory set contains every user request on the active branch. Preserve each stored user message exactly and in chronological order.

After the mandatory set fits, add model turns from newest to oldest until the next older complete turn would exceed the budget. The selected model turns therefore form one newest contiguous suffix. Do not skip a large intervening turn to include disconnected older turns.

Before evicting a turn only because one assistant block or tool result is large, use its paged outbound view. If the turn still cannot fit, replace all pageable outputs in that turn with bounded references. If it still cannot fit, stop at that boundary and keep the newer suffix.

The output messages must remain a valid Pi conversation with complete tool exchanges. Raw stored messages and the navigator's exact load data remain unchanged.

## Output paging and recovery

Use the promoted reference semantics:

- Page an assistant content block or a tool-result message when its serialized JSON exceeds 16,000 UTF-8 bytes.
- Replace only the outbound value with a compact notice and a stable `read_context_output` reference.
- Preserve tool-call ID, tool name, namespace, tool-result error state, and turn ordering in the outbound view.
- `read_context_output` reads the original JSON from the raw predecessor turn, not from a cached placeholder or the current outbound context.
- Page offsets count JavaScript UTF-16 code units because concatenating returned `text` values must reproduce `JSON.stringify(original)` exactly.
- A page contains at most 2,000 characters.

A reference is one of:

```ts
{ historyId: string; source: "assistant"; contentIndex: number }
{ historyId: string; source: "toolResult"; toolCallId: string }
```

A read adds optional `offset` and `limit`. `offset` defaults to `0`; `limit` defaults to `2_000` and must be in `1..2_000`. The result is:

```ts
{
  offset: number;
  nextOffset: number | null;
  totalCharacters: number;
  text: string;
}
```

Reject unknown history IDs, unknown content indexes/tool-call IDs, negative or non-integer offsets, invalid limits, and offsets past the serialized value. The reference must remain usable after its turn leaves the working context, after reload/resume, and after any tree navigation that still contains that turn.

## Tool contracts

All tool schemas are strict root objects with `additionalProperties: false`. Use Google-compatible string enums where needed. Do not use a top-level schema union; providers must be able to see every root property.

### `search_history`

Parameters:

```ts
{
  query: string;          // at most 200 characters
  files?: string[];       // at most 10, each at most 200 characters
  tools?: string[];       // at most 10, each at most 200 characters
  failed?: boolean;
  limit?: number;         // integer 1..10, default 5
  load?: boolean;
}
```

Search case-insensitively across exact stored message content plus extracted tool names and file-like arguments. Apply all supplied filters. Sort useful matches by relevance with stable chronological tie-breaking.

Without `load`, return compact references whose previews are at most 160 characters. A reference includes history ID, kind, sequence, timestamp, preview, adjacent IDs, tool names, file names, and failure state. Bound the serialized reference response to 8,000 characters and fail clearly rather than truncate invalid JSON.

With `load: true`, load the first three matching atomic items exactly in the same call. Exact loaded items are not subject to the 8,000-character reference-response limit.

### `browse_history`

Parameters:

```ts
{
  historyId?: string;     // at most 128 characters
  sequence?: number;      // integer 0..1_000_000
  direction: "backward" | "forward" | "around";
  count?: number;         // integer 1..10, default 5
  stride?: number;        // integer 1..10, default 1
}
```

Accept `historyId` or `sequence`, never both. Exact browse behavior is:

- With an explicit anchor, `backward` and `forward` exclude the anchor. `backward` returns older items newest-first; `forward` returns newer items oldest-first.
- With no anchor, `backward` starts with and includes the newest item; `forward` starts with and includes the oldest item.
- `around` includes its anchor and returns items in chronological order. With no anchor, it uses the newest item. It centers the stride-aligned window on the anchor when possible and shifts at either boundary to return up to `count` items.
- `stride` is the distance in navigator items between returned references. Boundary requests return fewer than `count` items without wrapping.
- An unanchored browse over empty history returns an empty reference list. An unknown explicit anchor remains an error.

Return compact references and enforce the same 8,000-character response bound as search.

### `load_history`

Parameters:

```ts
{
  historyIds: string[];   // 1..3 IDs, each at most 128 characters
}
```

Resolve the whole request atomically. If any ID is missing, return an error and no partial items. Otherwise return the exact atomic items in requested order with no character limit.

### `read_context_output`

Parameters use one root object:

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

For `source: "assistant"`, require `contentIndex` and reject `toolCallId`. For `source: "toolResult"`, require `toolCallId` and reject `contentIndex`. Resolve against raw active-branch predecessor records and return the exact page result defined above.

## Compaction behavior

Context paging owns context selection while enabled. Cancel `session_before_compact` so automatic or manual compaction cannot replace the raw recovery path that paging depends on. Show a concise warning that context paging kept raw history and cancelled compaction.

Cancellation is a correctness guard, not a fatal state. Do not append an infrastructure marker or permanently disable the session.

When `contextPaging.enabled` is false, do not intercept compaction.

## Automatic handoff

Extend handoff settings with:

```json
{
  "handoff": {
    "autoEnabled": false,
    "autoThresholdTokens": 150000
  }
}
```

`autoEnabled` follows the same global/trusted-project precedence and validation as the threshold. Its default is `false`.

Each `session_start` resets automatic handoff from settings:

- `false` starts in `disabled`
- `true` starts in `armed`

`/handoff auto on` enables automatic handoff for the current session and retains the existing threshold/countdown/preparation/finalization behavior. `/handoff auto off` disables it. `/handoff auto status` must clearly report `disabled` in the packaged default state. A new, resumed, forked, or reloaded session reads settings again rather than carrying an in-memory opt-in.

Manual `/handoff <goal>` and its prompt preparation remain available and unchanged while automatic handoff is disabled.

## Default loadout and runtime resources

Do not package or manage `~/.pi/agent/loadout.json`. Context paging must not replace the user's saved default tool and skill selection.

With no saved loadout, pi-loadout 0.0.35 enables every available tool and skill. The Home Manager-like runtime fixture uses that unconfigured default and asserts that all four paging tools are registered and active. It must also assert that `update_task_state` is absent. A user-managed saved loadout may choose a narrower active tool set; the paging tools remain registered and can be enabled through pi-loadout.

## Testing

Apply the Testing Value Gate. Add automated tests for production behavior and regressions; do not add tests that merely restate JSON or Nix text.

Required behavioral coverage:

1. The extension registers exactly the four paging tools and never registers `update_task_state`.
2. Search, browse, exact load, validation, response bounds, and atomic load failure work.
3. Paging-tool turns, including `read_context_output`, never enter the navigator, but each paging-tool call and result remains visible to the immediate follow-up provider request when retained by the context budget.
4. Every user request remains; selected model turns form the newest contiguous complete-turn suffix.
5. Resident system prompt and active tool schemas consume budget.
6. Large assistant content and large tool results become bounded references without mutating raw records.
7. Concatenating multiple output pages exactly reconstructs the original assistant block or tool-result JSON.
8. Output recovery still works after the source turn leaves selected context, and repeated `read_context_output` calls can page through a raw predecessor paging-tool result.
9. Startup, new session, resume, fork, reload, and successful tree navigation rebuild from the active raw branch.
10. The same policy works for at least two model/provider fixtures with different `contextWindow` values.
11. Missing/invalid model budgets and mandatory overflow abort clearly without a fatal-state entry.
12. Compaction is cancelled only while context paging is enabled.
13. Automatic handoff starts disabled, status reports disabled, explicit `auto on` works for that session, and manual handoff still works.
14. With no saved loadout, the packaged runtime fixture registers and activates all four paging tools while leaving default loadout state unmanaged.

For static settings and Nix wiring, use direct parsing/build verification rather than tests that assert source text.

## Verification

Before completion, run:

```sh
node --test --experimental-strip-types \
  extensions/context-paging/*.test.ts \
  tests/extensions/handoff-auto.test.ts \
  tests/extensions/handoff.test.ts \
  tests/extensions/handoff-generation.test.ts
```

Run the repository's full existing TypeScript test set.

Run the required Pi/Nix checks:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

The work is not complete if Pi reports an extension load failure, missing built-in module, missing package, inactive paging tool, or an unexpected `update_task_state` tool.

## Acceptance criteria

- The focused local port is under `extensions/context-paging/` and uses a standard default extension factory.
- The packaged configuration does not create or replace `~/.pi/agent/loadout.json`.
- New sessions with no saved loadout register and activate all four paging tools through pi-loadout's existing default behavior.
- Context selection is model-agnostic, budgeted from `ctx.model.contextWindow`, and accounts for the resident prompt and active tool schemas.
- All user requests and the newest contiguous suffix of complete model turns are preserved within budget.
- Large assistant/tool output remains exactly recoverable from raw session history.
- Resume, reload, fork, and tree navigation rebuild the correct active-branch navigator.
- Paging-tool turns are excluded from indexing.
- Compaction is cancelled without an injected fatal state while paging is enabled.
- Automatic handoff is disabled by default; manual handoff still works; explicit session opt-in still works.
- No ledger, todo, experiment, provider-gateway, tokenizer-pin, or spend-budget behavior is introduced.
- Required tests and Nix checks pass.
