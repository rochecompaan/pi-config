# Context Paging Performance Fix Implementation Plan

> **For implementers:** Follow `test-driven-development` and `verification-before-completion`. Keep public paging behavior unchanged except that the context hook may return the original canonical message objects when no paging transform is needed.

**Goal:** Remove the multi-second `context` hook delay on large sessions and stop rebuilding the full-text history index after every turn or recovery-tool call.

**Architecture:** Replace repeated whole-history deep comparisons with a per-selection history-message lookup that uses stable tool-call IDs first and exact, timestamp-bucketed serialization only as a fallback. Track retained token totals incrementally during FIFO paging. Remove the defensive full-context clone because `selectContext` already constructs new arrays/objects only where it transforms output. Keep projected history current on lifecycle/context events, but rebuild navigator structures only when a recovery tool needs them; build the expensive BM25 corpus only on the first search after a navigator rebuild.

**Tech Stack:** TypeScript, Node test runner, Pi extension API, Nix development shell.

## Global Constraints

- Preserve FIFO paging, active-request protection, atomic tool exchanges, protected unread tool-result behavior, recovery references, error codes, and automatic-compaction policy.
- Never mutate `event.messages`, raw session history items, or message objects supplied to `selectContext`.
- A stable tool-call ID must map assistant calls and tool results to their model-turn history ID without serializing payloads.
- Fallback message matching must remain exact; role/timestamp buckets may narrow candidates but may not by themselves count as equality.
- Paging budget checks must use Pi's exported `estimateTokens`; do not replace it with byte or character counts.
- Navigator search results, ranking, filters, references, browsing, and exact loads must remain unchanged.
- No time-based assertion in the unit suite. Use deterministic instrumentation for the repeated-serialization and lazy-index regressions.
- Do not change the extension's four public tool schemas or names.

### Task 1: Make context selection linear in retained history

**Files:**
- Modify: `extensions/context-paging/context-policy.ts`
- Modify: `extensions/context-paging/context-policy.test.ts`
- Modify if useful: `extensions/context-paging/context-policy.regression.test.ts`

**Steps:**
1. Add a failing deterministic regression test that supplies many unrelated raw history messages with serialization instrumentation, evicts a late canonical message, and proves matching does not repeatedly serialize unrelated payloads. Cover tool-call/tool-result lookup without payload serialization.
2. Add a failing test or strengthen existing tests to prove inputs remain unchanged when `selectContext` pages or recovers.
3. Implement a selection-local history lookup. Index raw messages by object identity, tool-call ID, and a role/timestamp fallback bucket. Cache fallback serializations and require exact serialized equality before returning a history ID.
4. Use the lookup for paging notices, tool recovery references, and protected trailing exchange detection instead of rescanning `rawHistoryItems`.
5. Cache message/unit token estimates and maintain the retained token total as FIFO units are removed. Recompute only the small notice estimate when its contents change. Build the final message array once per return path.
6. Run the focused context-policy tests and commit.

### Task 2: Make navigation and search indexing lazy and cached

**Files:**
- Modify: `extensions/context-paging/index.ts`
- Modify: `extensions/context-paging/navigator.ts`
- Modify: `extensions/context-paging/index.test.ts`
- Modify: `extensions/context-paging/navigator.test.ts`
- Modify if needed: `extensions/context-paging/tools.ts`
- Modify if needed: `extensions/context-paging/tools.test.ts`

**Steps:**
1. Add failing tests proving lifecycle events can refresh projected raw history without invoking `HistoryNavigator.rebuild`, repeated snapshots for the same visible history reuse the navigator, and paging-tool-only turns do not invalidate the visible navigator.
2. Add a failing deterministic navigator test proving `rebuild()` does not serialize/tokenize full tool-result payloads and that the BM25 corpus is built once on the first `search()` and reused until the next rebuild.
3. Split navigator rebuild into cheap visible-item/maps/reference setup and lazy search-index construction. Invalidate the search corpus on rebuild and create it only in `search()`.
4. In the extension, replace unconditional navigator rebuilds with projected-history refresh plus visible-history identity tracking. Rebuild navigator state only when a recovery tool snapshot needs it and visible history IDs changed. Keep `allItems` current for exact output reads even when only paging-tool turns were added.
5. Remove `structuredClone(event.messages)` from the context hook. Pass the canonical array directly to `selectContext`; return its selected array. Preserve fail-closed behavior and mutation guarantees.
6. Update lifecycle/context tests for the lazy contract and original-reference within-budget result. Run focused tests and commit.

### Task 3: Benchmark and verify the integrated fix

**Files:**
- Add: `extensions/context-paging/context-policy.bench.ts`
- Modify only if a benchmark exposes a defect: files from Tasks 1-2

**Steps:**
1. Add a manually invoked benchmark that constructs a session-shaped history with hundreds of turns and roughly 15 MB of tool output. It must time at least: raw projection, `selectContext`, navigator rebuild, first search, and cached search. It must print retained mode/token data so dead-code or behavior mistakes are visible.
2. Run the benchmark in the Nix development shell. The 15 MB `selectContext` case must complete comfortably below one second on this machine; investigate rather than weakening the workload if it does not.
3. Run all context-paging tests and the repository validation commands relevant to TypeScript/flake checks.
4. Review the final diff for accidental behavior changes, then commit the benchmark/verification task.
