# Interrupted Exchange Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The parent owns delegation and review.

**Goal:** Allow normal Pi aborted/error turns without paging errors, loss of raw history, or fabricated results.

**Architecture:** Raw projection accepts terminal failed responses with their actual matching results. Provider selection validates these exchanges, then excludes them before grouping and estimation. Other exchange validation and FIFO paging remain strict.

**Tech Stack:** TypeScript, Pi 0.87.1 extension APIs, Node 24 `node:test`.

## Global Constraints

- Spec: `docs/specs/2026-10-02-context-interrupted-exchanges-design.md`.
- Work only in `/home/roche/projects/pi/roche-pi/.worktrees/fix-context-interrupted-exchanges`.
- Base: `36d997fd368928c71bc88f19abe652cf460f3b1b`.
- Do not edit live session logs, main, other worktrees, token accounting, dependencies, or release artifacts.
- Do not fabricate tool results.
- Apply TDD and the Testing Value Gate to behavior tests.
- Baseline: `node --test extensions/context-paging/*.test.ts` passes 63 tests.
- The parent owns fresh adversarial review and integration decisions.

---

### Task 1: Interrupted-exchange handling across history and provider selection

**Files:**
- Modify: `extensions/context-paging/history.ts`.
- Modify: `extensions/context-paging/context-policy.ts`.
- Test: focused `extensions/context-paging/*.test.ts` files.
- Modify if needed for real boundary coverage: `extensions/context-paging/index.test.ts`.
- Create only if needed: a focused shared interrupted-state predicate or context normalization module.

**Interfaces:**
- Consume `projectActiveBranch(entries)` and `selectContext(input)` without changing their public inputs or outputs.
- Preserve `HistoryProjectionError` and `ContextSelectionError` contracts for existing invalid exchanges.
- Produce history items with original assistant/result messages and failed metadata.
- Produce provider-safe selections without terminal aborted/error exchanges.

- [x] **Step 1: Add failing behavioral tests.**

Use the existing fixture conventions. A representative fixture is:

```typescript
const failedAssistant = {
  role: "assistant" as const,
  content: [{ type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "src/a.ts" } }],
  api: "test", provider: "test", model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "aborted" as const,
  timestamp: 1,
};
const nextUser = { role: "user" as const, content: "continue", timestamp: 2 };
```

For each of `aborted` and `error`, assert these independent outcomes:

```typescript
const entries = [
  { type: "message", id: "failed-turn", parentId: null, timestamp: "2026-10-02T00:00:00.000Z", message: failedAssistant },
  { type: "message", id: "next-user", parentId: "failed-turn", timestamp: "2026-10-02T00:00:01.000Z", message: nextUser },
];
const before = structuredClone(entries);
const projected = projectActiveBranch(entries as any);
assert.deepEqual(projected.map(item => item.id), ["failed-turn", "next-user"]);
assert.equal(projected[0].kind, "modelTurn");
if (projected[0].kind === "modelTurn") {
  assert.equal(projected[0].metadata.failed, true);
  assert.deepEqual(projected[0].toolResults, []);
  assert.deepEqual(projected[0].assistantMessage, failedAssistant);
}
const selected = selectContext({
  messages: [failedAssistant, nextUser] as any,
  systemPrompt: "test", activeTools: [], modelContextWindow: 200000, tokenBudget: 128000,
});
assert.deepEqual(selected.messages, [nextUser]);
assert.deepEqual(entries, before);
```

Add table-driven multi-tool cases with zero, one, and two actual results.
Assert exact raw output, result identity/order, no synthetic results, and no provider orphan results.
Cover failed text-only responses, tail responses, prefix/active/completed turns, within-budget and paged selections.
Add strict-negative cases for duplicate/mismatched/orphan results and normal incomplete exchanges.
Add an extension lifecycle test using the existing registered-handler harness for session start/resume/navigation and context selection.
Use small hand-checked expectations instead of assertions on private helpers.

- [x] **Step 2: Observe the failures before implementation.**

Run `node --test extensions/context-paging/*.test.ts`.
Confirm that failed-turn tests reproduce `INCOMPLETE_TOOL_RESULTS` or `INVALID_MESSAGE_STRUCTURE`, or expose unchanged replay behavior.
Keep the test command and its summary in the implementation report.
The existing negative tests must still pass.

- [x] **Step 3: Apply the smallest aligned implementation.**

History projection must allow missing results only when the assistant's final stop reason is `error` or `aborted`.
It must retain matching actual results and mark the failed response in metadata.
Keep validation of actual results before the missing-result decision.

Provider normalization must validate each failed exchange before excluding its assistant and contiguous actual results.
Run this normalization before grouping, estimation, and all return paths.
Retain unchanged input objects for surviving messages.
Keep all existing normal-exchange rules and complete-result protection.

A shared terminal-state predicate can use:

```typescript
message.stopReason === "aborted" || message.stopReason === "error"
```

Do not use Pi's generic missing-result synthesis to repair these records.
Raw storage must remain untouched.

- [x] **Step 4: Run complete verification.**

Run:

```sh
node --test extensions/context-paging/*.test.ts
git diff --check
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

The parent can own Nix checks to avoid duplicate builds.
Report environmental blockers without weakening the behavioral tests.
The parent will also run a read-only check against the original failed saved branch.

- [x] **Step 5: Commit only the patch and tests.**

Read the `commit` skill before committing.
Use `fix(context-paging): handle interrupted assistant exchanges`.
Do not push, merge, deploy, or publish.
Report the commit SHA, changed files, red/green evidence, remaining risks, and any skipped verification.

## Accounting integration

The effective integration base is `06f098706ab3155169f7c778e2c9834fd442257c`.
The original writer and fresh review completed before queued rebase guidance arrived.
The parent then resolved the overlap inside this task's worktree.

Added regressions for branch-tail preservation, aligned outgoing-only provenance, and measured-usage subtraction after omission.
The unnormalized accounting selector failed five behavior tests (91 passed, 5 failed).
After integration, all 96 paging tests passed.
The existing accounting APIs and tests remain intact.
Parent verification completed:

- Full repository Node suite: 523 passed, no failures or skips.
  Package-build tests used the real Pi source and packaged bridge modules with their required environment variables.
  `PI_PACKAGE_DIR` pointed to the fixture, not the installed Bun package.
- Real Pi 0.87.1 paging suite: 96 passed, no failures or skips.
  The fixture used the exact Nix source and offline npm dependency cache.
- Runtime extension-load check passed.
- Full flake check passed all seven checks.
- The original 58-entry failed branch passed projection and selection.
  Both interrupted turns remained in raw history; provider selection omitted them.
  Raw objects and saved-session bytes remained unchanged.
- Fresh accounting-overlap review `45e1c06c-bb26-4e11-9787-1584c824267a` approved source HEAD `dc49e60f50dc9d2bc94e26f5f3f664faa62d6a94` with no findings.

No new automated tests were added for documentation.
Documentation changes use diff hygiene and direct review instead.
At this checkpoint, main, deployment, the standalone source, and release tags were unchanged.

## Current-main compatibility verification

The user approved a local squash into `main`.
The integration base is `0d8c91b407bc44ed96e211ccc3e77ffcfd624a04`.
The latest `flake.lock` is unchanged.
Its `llm-agents` input selects Pi 1.0.0.

The preview patch failed because an upstream import added `formatToolCallWithArgs`.
The user approved adaptation of this patch.
Only the patch context changed.
The patch still adds the same preview bounds.

The SDK fixture used the current Nix source, offline npm cache, and preview patch.
Four existing preview tests failed without the patch and passed with it.
No new tests were added for this patch-context change.
Direct patch application and existing behavior tests provide verification instead.

Verification on the staged integration tree:

- Full repository Node suite: 523 passed, no failures or skips.
- Real Pi 1.0.0 paging suite: 96 passed, no failures or skips.
- Runtime extension-load check: passed.
- Explicit builds of all seven Linux checks: passed.
- Full flake check: passed.

Integration uses one local squash commit on `main`.
No push, deployment, standalone port, tag change, or npm publication is approved.
