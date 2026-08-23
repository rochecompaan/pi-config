# Review Prompt Footer Correlated Arming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Append the selected `/review` prompt name only to the completed assistant response produced by the matching accepted review prompt.

**Architecture:** The focused footer helper will hold separate scheduled and armed state. `/review` will schedule the exact full prompt and selected profile before dispatch; `before_agent_start` will promote that schedule only when Pi emits the same prompt after accepting the agent run. `message_end` will continue to transform only armed, completed assistant messages before persistence.

**Tech Stack:** TypeScript, Pi 0.84.2 extension lifecycle events, Node test runner, TypeScript 5.9, Nix flake checks, Pi reviewer subagent.

## Global Constraints

- Format the standard profile footer as `review prompt: codex`.
- Format the thermo-nuclear profile footer as `review prompt: thermo-nuclear`.
- Add one blank line before the footer.
- Collapse contiguous trailing standalone footer candidates across trailing text blocks for either known profile to one canonical footer for the selected profile; preserve prose suffixes and non-text blocks.
- Modify the saved assistant message. Do not add a separate TUI entry.
- Append only to assistant messages with `stopReason: "stop"` and nonempty text.
- Schedule before `pi.sendUserMessage(fullPrompt)`, but arm only when `before_agent_start` receives that exact prompt.
- Never append a scheduled but unarmed footer to an assistant response.
- A second `/review` attempt must not replace an armed footer for a review already in progress.
- Keep armed state across `toolUse`, `length`, and `error` messages because Pi can continue through tool execution, automatic retry, or compact-and-retry without another `before_agent_start` event.
- Clear state after a synchronous dispatch throw, `aborted`, or `agent_settled`; clear an unarmed schedule when a different prompt reaches `before_agent_start`.
- Do not change review rubrics, profile identifiers, target selection, model selection, or `/end-review` behavior.
- Use automated tests for lifecycle and transformation behavior. No screenshot test is needed because this changes persisted text, not TUI layout.
- Run the focused footer tests, all review tests, focused TypeScript checking, the Pi extension-load check, and the full flake check before completion.
- Repeat task-scoped and whole-branch reviews until neither reports a Critical nor Important finding.

## Starting Point

- Worktree: `/home/roche/projects/pi/roche-pi/.worktrees/review-prompt-footer`
- Branch: `feat/review-prompt-footer`
- Whole-branch review base: `6ee9b1708895a6a4d57df45edc35d29012e376a3`
- Correction-plan base: `7f3eed8`
- Existing implementation: profile mapping, footer transformation, one-shot pending state, `message_end` persistence, terminal cleanup, and 12 focused tests.
- Verified defect: Pi 0.84.2 extension `pi.sendUserMessage()` returns `void` and catches asynchronous rejection internally, so dispatch-time `try/catch` cannot prevent stale early-armed state.

---

### Task 1: Correlate footer state with the accepted review prompt

**Files:**
- Modify: `extensions/review/review-output-footer.test.ts`
- Modify: `extensions/review/review-output-footer.ts`
- Create: `extensions/review/review-output-footer-lifecycle.test.ts`
- Create: `extensions/review/review-output-footer-lifecycle.ts`
- Modify: `extensions/review/index.ts:64-69,1121-1165,1746-1784`
- Update after verification: `.superpowers/sdd/2026-08-22-review-prompt-footer/task-1-report.md`
- Update after reviews: `.superpowers/sdd/2026-08-22-review-prompt-footer/final-review.md`
- Update after reviews: `.superpowers/sdd/2026-08-22-review-prompt-footer/progress.md`

**Interfaces:**
- Consumes: `ReviewProfileId` from `extensions/review/review-profile.ts` and `before_agent_start.event.prompt` from Pi 0.84.2.
- Produces: `ReviewPromptFooterState`, `createReviewPromptFooterState()`, `scheduleReviewPromptFooter()`, `armScheduledReviewPromptFooter()`, `clearReviewPromptFooter()`, `applyPendingReviewPromptFooter()`, `registerReviewPromptFooterLifecycle()`, and `sendReviewPromptWithFooter()`.
- State shape:

```ts
export type ReviewPromptFooterState = {
  scheduledPrompt?: {
    promptText: string;
    promptName: ReviewPromptName;
  };
  armedPrompt?: ReviewPromptName;
};
```

- [ ] **Step 1: Replace direct arming in the focused tests and add failing lifecycle coverage**

In `extensions/review/review-output-footer.test.ts`, replace the `armReviewPromptFooter` import with:

```ts
import {
  applyPendingReviewPromptFooter,
  armScheduledReviewPromptFooter,
  clearReviewPromptFooter,
  createReviewPromptFooterState,
  scheduleReviewPromptFooter,
} from "./review-output-footer.ts";
```

Add one shared prompt and a helper for existing transformation tests:

```ts
const REVIEW_PROMPT = "review rubric\n\n---\n\nreview target";

function scheduleAndArm(
  state: ReviewPromptFooterState,
  profile: ReviewProfileId = "standard",
  prompt = REVIEW_PROMPT,
): void {
  scheduleReviewPromptFooter(state, prompt, profile);
  assert.equal(armScheduledReviewPromptFooter(state, prompt), true);
}
```

Import `ReviewPromptFooterState` from `review-output-footer.ts` and `ReviewProfileId` from `review-profile.ts` as type-only imports. Replace each existing `armReviewPromptFooter(state, profile)` setup with `scheduleAndArm(state, profile)`. Update state assertions to inspect `armedPrompt` instead of `pendingPrompt`.

Add these lifecycle tests:

```ts
test("arms a scheduled footer only for the exact review prompt", () => {
  const state = createReviewPromptFooterState();
  scheduleReviewPromptFooter(state, REVIEW_PROMPT, "standard");

  assert.equal(armScheduledReviewPromptFooter(state, REVIEW_PROMPT), true);
  assert.equal(state.scheduledPrompt, undefined);
  assert.equal(state.armedPrompt, "codex");
});

test("an asynchronous dispatch rejection cannot label a later unrelated response", () => {
  const state = createReviewPromptFooterState();
  scheduleReviewPromptFooter(state, REVIEW_PROMPT, "standard");

  // Rejection occurs before before_agent_start. The next accepted prompt is unrelated.
  assert.equal(armScheduledReviewPromptFooter(state, "ordinary user prompt"), false);
  const result = applyPendingReviewPromptFooter(state, {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "Ordinary answer" }],
  });

  assert.equal(result, undefined);
  assert.deepEqual(state, {});
});

test("a review attempted during streaming cannot label the active unrelated response", () => {
  const state = createReviewPromptFooterState();
  scheduleReviewPromptFooter(state, REVIEW_PROMPT, "thermo-nuclear");

  // The active response reaches message_end before this scheduled prompt can start.
  const result = applyPendingReviewPromptFooter(state, {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "Already-streaming answer" }],
  });

  assert.equal(result, undefined);
  assert.equal(state.scheduledPrompt?.promptText, REVIEW_PROMPT);
  assert.equal(state.armedPrompt, undefined);
});

test("a second review attempt does not replace an armed footer", () => {
  const state = createReviewPromptFooterState();
  scheduleAndArm(state, "standard", REVIEW_PROMPT);
  scheduleReviewPromptFooter(state, "second review prompt", "thermo-nuclear");

  const result = applyPendingReviewPromptFooter(state, {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "Review result" }],
  });

  assert.equal(result?.content[0].text, "Review result\n\nreview prompt: codex");
});
```

Keep the existing tests for mapping, whitespace, final text-block selection, duplicate prevention, `toolUse`, retryable `length` and `error` responses, `aborted`, non-assistant messages, empty text, and explicit cleanup. Add wrong-profile, alternating, and split-block trailing-footer cases that prove all known standalone candidates collapse to the selected footer while non-text blocks remain unchanged. Add `length → stop` and `error → stop` sequences that prove the successful retry receives the footer.

Create `extensions/review/review-output-footer-lifecycle.test.ts` with a fake `on()`/`sendUserMessage()` boundary. Verify that the registered adapter schedules before send, arms through the exact registered `before_agent_start` callback, returns `{ message }` from the registered `message_end` callback after a retry, and clears both scheduled-but-unarmed and armed state through the registered `agent_settled` callback.

- [ ] **Step 2: Run the focused test and verify the lifecycle tests fail**

Run:

```bash
node --test extensions/review/review-output-footer.test.ts
```

Expected: FAIL because `scheduleReviewPromptFooter`, `armScheduledReviewPromptFooter`, `scheduledPrompt`, and `armedPrompt` do not exist yet. The failure must demonstrate the new lifecycle contract rather than a test syntax error.

- [ ] **Step 3: Implement scheduled and armed state in the helper**

In `extensions/review/review-output-footer.ts`, replace the single `pendingPrompt` field and direct-arm function with:

```ts
export type ReviewPromptFooterState = {
  scheduledPrompt?: {
    promptText: string;
    promptName: ReviewPromptName;
  };
  armedPrompt?: ReviewPromptName;
};

export function scheduleReviewPromptFooter(
  state: ReviewPromptFooterState,
  promptText: string,
  profile: ReviewProfileId,
): void {
  if (state.armedPrompt) {
    return;
  }

  state.scheduledPrompt = {
    promptText,
    promptName: REVIEW_PROMPT_NAMES[profile],
  };
}

export function armScheduledReviewPromptFooter(
  state: ReviewPromptFooterState,
  promptText: string,
): boolean {
  const scheduledPrompt = state.scheduledPrompt;
  if (!scheduledPrompt || state.armedPrompt) {
    return false;
  }

  state.scheduledPrompt = undefined;
  if (scheduledPrompt.promptText !== promptText) {
    return false;
  }

  state.armedPrompt = scheduledPrompt.promptName;
  return true;
}

export function clearReviewPromptFooter(state: ReviewPromptFooterState): void {
  state.scheduledPrompt = undefined;
  state.armedPrompt = undefined;
}
```

Change `applyPendingReviewPromptFooter()` to read only `state.armedPrompt`. Preserve armed state for `toolUse`, `length`, and `error`, because Pi may continue the same run without another `before_agent_start`. Clear state for `aborted` and completed `stop` messages; rely on `agent_settled` to clear final `length` or `error` failures after retries are exhausted. Do not let `message_end` consume or transform `scheduledPrompt`.

The helper must preserve these invariants:

1. Only exact prompt equality promotes scheduled state.
2. A mismatch clears the unarmed schedule.
3. Scheduling may replace an older unarmed schedule.
4. Scheduling never replaces an armed prompt.
5. Message transformation reads only armed state.
6. Contiguous trailing standalone footer candidates across trailing text blocks for either profile collapse to one canonical footer for the armed profile.
7. Lifecycle registration and schedule-before-send ordering are exercised through a fake Pi boundary.

- [ ] **Step 4: Run the focused tests and verify the helper is green**

Run:

```bash
node --test extensions/review/review-output-footer.test.ts
```

Expected: all focused footer tests pass. Node may print the existing module-type warning.

- [ ] **Step 5: Extract and wire the tested lifecycle adapter**

Create `extensions/review/review-output-footer-lifecycle.ts`. Export `registerReviewPromptFooterLifecycle()` to register `before_agent_start`, `message_end`, and `agent_settled` against one state object. Export `sendReviewPromptWithFooter()` to schedule the exact finalized prompt immediately before `pi.sendUserMessage()`, retaining the synchronous rollback `try/catch` without relying on it for asynchronous rejection.

In `extensions/review/index.ts`, import the adapter and register it once after state creation:

```ts
const reviewPromptFooterState = createReviewPromptFooterState();
registerReviewPromptFooterLifecycle(pi, reviewPromptFooterState);
```

In `dispatchReviewPrompt()`, delegate the finalized prompt send:

```ts
sendReviewPromptWithFooter(pi, reviewPromptFooterState, fullPrompt, profile);
```

Remove the duplicate inline footer lifecycle handlers and direct schedule/send block from `index.ts`. Do not alter `fullPrompt`, either rubric, review model selection, target selection, fresh-session behavior, or `/end-review`.

- [ ] **Step 6: Run focused behavior, all review tests, TypeScript checking, and whitespace validation**

Run:

```bash
node --test extensions/review/review-output-footer*.test.ts
node --test extensions/review/*.test.ts
nix shell nixpkgs#typescript -c sh -c 'tsc --version && tsc --noEmit --target esnext --module nodenext --moduleResolution nodenext --allowImportingTsExtensions extensions/review/review-output-footer.ts'
git diff --check
```

Expected:

- Focused footer tests: all pass, including asynchronous rejection and unrelated streaming-response coverage.
- All review tests: all pass.
- TypeScript: version prints and no diagnostics follow.
- `git diff --check`: no output.

- [ ] **Step 7: Commit the lifecycle correction**

Review `git status --short` and `git diff -- extensions/review/index.ts extensions/review/review-output-footer.ts extensions/review/review-output-footer.test.ts extensions/review/review-output-footer-lifecycle.ts extensions/review/review-output-footer-lifecycle.test.ts`. Stage only the implementation files and commit:

```bash
git add extensions/review/index.ts \
  extensions/review/review-output-footer.ts \
  extensions/review/review-output-footer.test.ts \
  extensions/review/review-output-footer-lifecycle.ts \
  extensions/review/review-output-footer-lifecycle.test.ts
git commit -m "fix(review): correlate footer with accepted prompt"
```

- [ ] **Step 8: Run task-scoped review until it has no Critical or Important findings**

Resolve the active canonical `reviewer` model and thinking settings, then dispatch it with fresh context. Give it:

- Task base: `7f3eed8`.
- Task head: the current `git rev-parse HEAD`.
- The approved design: `docs/specs/2026-08-22-review-prompt-footer-design.md`.
- The implementation plan: this file.
- The three implementation files.
- The verified Pi 0.84.2 `sendUserMessage()` behavior.
- Acceptance criteria from Global Constraints.

Use this task description:

```text
Review the correlated lifecycle correction for the /review prompt footer. Check that footer state is only armed when the exact scheduled review prompt reaches before_agent_start; asynchronous dispatch rejection and attempts during unrelated streaming cannot label unrelated assistant messages; an active review footer cannot be overwritten; persistence and existing review behavior remain unchanged. Report findings by severity and include file/line references. Do not edit files.
```

If the reviewer reports a Critical or Important finding:

1. Verify the finding against Pi 0.84.2 and the current code.
2. Add or update a failing behavior test when the finding changes production behavior.
3. Apply the smallest correction as the sole writer.
4. Rerun Step 6.
5. Commit the correction with a focused Conventional Commit subject.
6. Dispatch a fresh task-scoped reviewer again.

Repeat until no Critical or Important finding remains. Record the correction, commands, results, commit IDs, and final scoped-review assessment under a new `## Correlated arming correction` section in `.superpowers/sdd/2026-08-22-review-prompt-footer/task-1-report.md`.

- [ ] **Step 9: Run the required packaged runtime and full flake checks**

Run from the worktree root:

```bash
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

Expected: both commands exit with status 0. The extension-load check must not report `Failed to load extension`, `No such built-in module`, or `Cannot find package`.

If either command fails, diagnose the failure before changing code. Apply a correction only when the failure is caused by this branch, then rerun Step 6 and both commands in this step.

- [ ] **Step 10: Run final whole-branch review until it has no Critical or Important findings**

Dispatch the canonical `reviewer` with fresh context over the complete branch:

- Base: `6ee9b1708895a6a4d57df45edc35d29012e376a3`.
- Head: current `git rev-parse HEAD`.
- Requirements: every completed `/review` response has the selected footer; `standard` maps to `codex`; `thermo-nuclear` maps to itself; one blank line precedes the footer; the extension modifies the persisted assistant message; no separate TUI entry; existing rubrics, targets, model selection, and `/end-review` remain unchanged; failed or overlapping dispatches cannot label unrelated responses.
- Evidence: focused tests, all review tests, focused TypeScript check, extension-load check, and full flake check.

Use this review request:

```text
Perform an adversarial whole-branch review of the /review prompt footer feature from the supplied base to head. Verify the product requirements, exact-prompt before_agent_start correlation, asynchronous rejection safety, unrelated-response isolation, active-review overwrite protection, message persistence, state cleanup, TypeScript correctness, and preservation of existing review behavior. Report findings by severity with file/line references. Do not edit files.
```

If the reviewer reports a Critical or Important finding, use the same verify, test-first, fix, Step 6, Step 9, commit, and fresh-review loop from Step 8. Continue until the final reviewer reports no Critical or Important findings.

Replace `.superpowers/sdd/2026-08-22-review-prompt-footer/final-review.md` with the final whole-branch review result. Update `.superpowers/sdd/2026-08-22-review-prompt-footer/progress.md` so it records the correction commit, all verification commands, scoped-review result, final-review result, and any residual Minor findings.

- [ ] **Step 11: Finalize local review evidence and confirm a clean worktree**

The `.superpowers/sdd/` reports are intentionally local and excluded by `.git/info/exclude`. Update them in place, but do not force-add them. Commit any tracked plan correction found during review, then verify status:

```bash
git add docs/plans/2026-08-22-review-prompt-footer.md
git commit -m "docs(review): fix lifecycle plan staging"
git status --short --branch
git status --short --ignored .superpowers/sdd/2026-08-22-review-prompt-footer
```

Expected: the tracked worktree is clean, the local reports appear only as ignored `.superpowers/` artifacts, and no Critical or Important finding remains.
