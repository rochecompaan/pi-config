# Context Usage Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (parent orchestration) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align paging with Pi's provider-backed status-bar accounting without miscounting earlier evictions.

**Architecture:** A focused tracker links successful usage to the last selected outgoing context. The selector accepts a calibrated full-context estimate and applies estimated removal and notice deltas. Existing FIFO and recovery behavior stays unchanged.

**Tech Stack:** TypeScript, Pi ExtensionAPI, Pi `estimateTokens`, and Node's built-in test runner.

## Global Constraints

- The default budget remains `128_000` tokens.
- The effective budget remains the smaller of this budget and the model context window.
- The status bar itself does not change.
- Resident inputs contribute once.
- Only successful, nonzero usage can establish a measured anchor.
- Raw session history and recovery tools remain unchanged.
- No new session entries or external dependencies are necessary.
- A changed request remains an estimate until its provider response reports actual usage.

**Spec:** `docs/specs/2026-10-01-context-usage-accounting-design.md`.

## File responsibilities

- Create `extensions/context-paging/context-usage.ts`: per-request measured anchors and estimated deltas.
- Create `extensions/context-paging/context-usage.test.ts`: deterministic tracker regressions.
- Modify `extensions/context-paging/context-policy.ts`: optional calibrated full-context accounting across selection and recovery paths.
- Modify `extensions/context-paging/context-policy.test.ts`: calibrated selector regressions.
- Modify `extensions/context-paging/index.ts`: usage input, selected-request snapshots, and lifecycle invalidation.
- Modify `extensions/context-paging/index.test.ts`: public event harness and integration regressions.
- Modify the existing paging documentation if it describes token estimation incorrectly.

The policy already exceeds 400 lines. Keep the new stateful accounting logic in the new module.
A small shared resident-estimation helper can move with it if necessary. Do not refactor unrelated selection code.

### Task 1: Align per-request paging accounting

**Interfaces:**

- Consume `ctx.getContextUsage()` and canonical `context` event messages.
- Produce an optional finite, nonnegative full-context token estimate for `selectContext`.
- Use an optional `contextTokens?: number` field on `ContextSelectionInput` for this estimate.
- Keep `estimatedTokens`, `budgetTokens`, and selection modes backward compatible.
- Keep tracker internals private. Its entry points prepare accounting for one event, record a successful selection, and clear incompatible state.

- [ ] **Step 1: Run the clean baseline.**

Run:

```sh
node --test --test-reporter=tap extensions/context-paging/context-policy.test.ts extensions/context-paging/context-policy.regression.test.ts extensions/context-paging/index.test.ts
```

Expected: exit 0 and no failed tests.

- [ ] **Step 2: Write and run calibrated selector regressions before implementation.**

Add `contextTokens` to the test helper overrides and selector input.
Use existing `user`, `assistant`, `repeat`, and `selected` fixtures.
The following first test must fail under the old selector:

```ts
test("keeps measured within-budget input despite a larger heuristic", () => {
  const messages = [
    user(repeat("old request", 300_000)),
    assistant(repeat("old answer", 300_000)),
    user("active request"),
  ];
  const selection = selected(messages, {
    modelContextWindow: 272_000,
    tokenBudget: 128_000,
    contextTokens: 119_430,
  });
  assert.equal(selection.mode, "within-budget");
  assert.equal(selection.estimatedTokens, 119_430);
  assert.deepEqual(selection.messages, messages);
});
```

Add the reverse case: a measured total above the budget must evict an old completed turn even if its heuristic total is below budget.
Add checks that an observed within-budget input bypasses an incorrectly large raw resident estimate.
Cover calibrated protected-overflow and recovery decisions, not only the fast path.

Run the policy tests and record the expected assertion failures.

- [ ] **Step 3: Write tracker and integration regressions before implementation.**

Extend the harness with `getContextUsage` and controllable successful assistant usage.
Use a sequence of actual `context` events, selected messages, and appended assistant/tool-result entries.

The sequence must demonstrate this behavior:

```ts
// Request A selects a suffix from large raw history.
// Response A reports measured usage for that suffix plus its assistant output.
// Request B receives the complete raw history again and a new tool result.
// Estimate B = measured anchor + estimates of genuine additions/restorations
//              - estimates of removed snapshot messages/notices.
// Selection B must not restore older context through a shrinking global ratio.
```

Add separate tests for cached tokens, repeated events without new usage, structurally equal reconstructed messages, and duplicates.
Cover new sessions, branch switches, model switches, manual compaction, and context edits.
Cover missing usage and error/aborted responses, including a later fresh successful response.
If the last usage basis is unknown, assert estimator fallback until a tracked response establishes an anchor.
Record meaningful RED evidence for each new behavior group.

- [ ] **Step 4: Implement the tracker and selector accounting.**

The calibrated estimate follows this relationship:

```ts
candidateTokens = measuredAnchorTokens
  + estimatedCandidateMessageTokens
  - estimatedAnchorMessageTokens
  + estimatedCurrentResidentTokens
  - estimatedAnchorResidentTokens;
```

Use Pi's successful usage rules, including output and cached tokens.
Pair a response with the tracked request actually sent, not the whole raw branch.
Use the status-bar total only when its current usage basis is valid and matched.
Guard malformed or stale data before supplying `contextTokens`.

Inside the selector, cache raw message estimates as today.
Apply one calibration adjustment to totals across FIFO removals, notice updates, resident and active-request checks, overflow, and recovery.
Do not repeatedly rescan all retained messages after every eviction.
Do not clamp away additive information during removals. Clamp only the reported final estimate or a completed boundary calculation.

The following validation shape is suitable at the external usage boundary:

```ts
function validUsageTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
```

Wire state clearing into supported lifecycle hooks and detect invalidating branch entries.
Do not clear a valid anchor at every normal turn end.
Do not use tool-only content matches as proof that a provider response belongs to the tracked request.

- [ ] **Step 5: Verify the complete paging suite and update documentation.**

Run:

```sh
node --test --test-reporter=tap extensions/context-paging/*.test.ts
```

Expected: all tests pass.

Read the existing documentation's accounting section.
Describe the measured anchor, estimator fallback, unchanged budget, and pre-request accuracy limit in plain language.
Do not add automated tests for documentation text.

- [ ] **Step 6: Verify runtime startup and packaging.**

Stage only task files so Nix includes new imported modules.
Run:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

Expected: both commands exit 0.
If a command fails, preserve its evidence and diagnose the cause before any completion claim.
Do not alter unrelated dependencies or external extension sources to repair an unrelated check.

- [ ] **Step 7: Commit and provide the review handoff.**

Run `git diff --check` and inspect the task diff.
Commit only the implementation, tests, and accounting documentation with a concise `fix(context-paging): ...` subject.
Return the full Base/Head references, changed files, RED/GREEN evidence, verification commands, and any residual risks.
Do not push, merge, or deploy.
