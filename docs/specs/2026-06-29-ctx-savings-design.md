# ctx-savings design

## Goal

Add a small Pi extension that makes context-mode savings easy to understand for the current worktree.

The user-facing command is:

```text
/ctx-savings
```

The command reports approximate token savings for:

1. the current Pi session
2. all context-mode sessions for the current project/worktree

## Output

Use comparative, human-readable output:

```text
ctx saved ~21k tokens (~$0.06) this session
4k used / 25k without · 84% reduction

this worktree: ~180k saved (~$0.54)
31k used / 211k without · 85% reduction
```

Also add a compact status/footer form:

```text
ctx: 4k / 25k · saved 21k (~$0.06) · 84%
```

Cost savings are projected from observed session costs when available. If no cost data is available, omit the dollar amount instead of showing a fake `$0.00`.

## Scope

In scope:

- a local Pi directory extension at `extensions/ctx-savings/index.ts`
- supporting core and test files inside `extensions/ctx-savings/`, not as top-level `extensions/*.ts` files
- a `/ctx-savings` command
- read-only aggregation from context-mode SQLite databases
- current-session and current-worktree summaries
- approximate token counts from recorded byte counts
- projected cost savings when Pi session cost data is available
- compact status/footer display

Out of scope for the first version:

- global/lifetime stats across every Pi project
- dashboards, exporters, or new persistent storage
- upstream context-mode changes
- exact model-token accounting
- hook-based custom metrics collection
- hard-coded model pricing tables

## Data source

Read context-mode session databases directly, read-only:

```text
~/.pi/context-mode/sessions/*.db
```

Use these existing tables and columns:

- `session_meta.session_id`
- `session_meta.project_dir`
- `session_meta.started_at`
- `session_meta.last_event_at`
- `session_meta.event_count`
- `session_events.session_id`
- `session_events.bytes_avoided`
- `session_events.bytes_returned`
- `tool_calls.tool`
- `tool_calls.calls`
- `tool_calls.bytes_returned`

Do not write to context-mode databases.

For projected cost savings, reuse the approach from `extensions/session-breakdown.ts`: read Pi session JSONL files under `~/.pi/agent/sessions`, extract `usage.cost` and token totals from message records, and derive an observed dollars-per-token rate for the same scope. Do not add a pricing table in v1.

## Session and worktree matching

Worktree aggregation filters rows where `session_meta.project_dir` matches `ctx.cwd`, after normalizing path separators and trimming trailing slashes.

Current-session matching should use the same stable ID derivation context-mode uses for Pi:

```text
sha256(ctx.sessionManager.getSessionFile()).slice(0, 16)
```

If the session file is unavailable, fall back to the newest matching session for the current worktree and label the value as inferred.

## Calculations

For any scope:

```text
saved bytes = sum(session_events.bytes_avoided)
used bytes  = sum(session_events.bytes_returned)
without     = saved bytes + used bytes
reduction   = saved bytes / without
```

Approximate tokens with:

```text
tokens = round(bytes / 4)
```

Projected cost savings:

```text
observed rate = actual session cost / actual session tokens
projected savings = saved tokens * observed rate
```

Use current-session cost data for the current-session line and current-worktree cost data for the worktree line. If a scope has no usable cost or token data, omit only the dollar amount for that scope.

This is deliberately approximate. The extension should say "~" in output and avoid claiming exact tokenizer-level numbers or exact billing numbers.

## Formatting rules

- Use short units: `4k`, `21k`, `5.8M`.
- Show saved tokens first.
- Show projected cost savings in parentheses after saved tokens when available.
- Show the comparison as `used / without`.
- Show reduction as a whole percent.
- Avoid noisy decimals except for large `M` values where one decimal helps.
- Format USD like `session-breakdown.ts`: `$1.23` for dollars, `$0.123` for dimes, `$0.0123` for smaller values.

Zero-data output:

```text
No context-mode savings data found for this worktree yet.
```

## Error handling

The command should be best-effort:

- missing context-mode session directory: show no-data message
- no matching `project_dir`: show no-data message
- unreadable or corrupt database: skip it and include a small warning count
- missing expected table/column in one DB: skip that DB
- zero `saved + used`: show `0 saved` without dividing by zero
- missing Pi session cost data: omit projected cost savings only

The extension should never block Pi startup or fail the command because one old database is malformed.

## Testing and verification

Automated tests should cover only reusable pure logic:

- byte-to-token approximation
- compact number formatting
- reduction calculation
- projected cost calculation when an observed rate is available
- USD formatting
- output text for normal, costless, and zero-data cases

SQLite integration can be verified directly against local context-mode databases for the first version. Avoid large fake context-mode fixtures unless the query logic becomes more complex.

## Future work

Possible later additions:

- all-project/global savings mode
- exact tokenizer-specific accounting if context-mode records token counts upstream
- model-specific projected pricing if context-mode records enough reliable model metadata
- top tool breakdown when useful for debugging
