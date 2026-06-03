# Branch Review Preset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/review` preset and direct command syntax for reviewing a target branch/ref against a selectable base branch/ref without checking out the target.

**Architecture:** Add a narrow pure helper module for compare-target parsing and prompt construction, then wire it into the existing `extensions/review.ts` command selector and parser. The extension remains responsible for TUI flows and git execution; the helper keeps new parsing/prompt behavior testable without loading the full extension.

**Tech Stack:** TypeScript, Node `node:test`, Git CLI via existing `pi.exec` wrapper.

---

## File Structure

- Create `extensions/review-compare.ts`: pure compare-branch target types, direct-arg parser helper, and prompt builder helper.
- Create `extensions/review-compare.test.ts`: focused Node tests for parser and prompt text.
- Modify `extensions/review.ts`: add `compareBranches` target handling, selector preset, target/base branch selectors, direct `/review compare` parsing, prompt delegation, and user-facing hint.

---

### Task 1: Add pure compare helper tests

**Files:**
- Create: `extensions/review-compare.test.ts`
- Create later: `extensions/review-compare.ts`

- [ ] **Step 1: Write the failing tests**

Create `extensions/review-compare.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
	buildCompareBranchesPrompt,
	parseCompareBranchArgs,
} from "./review-compare.ts";

test("parseCompareBranchArgs accepts a target branch without explicit base", () => {
	assert.deepEqual(parseCompareBranchArgs(["feature/worktree-review"]), {
		targetBranch: "feature/worktree-review",
	});
});

test("parseCompareBranchArgs accepts target and base branches", () => {
	assert.deepEqual(parseCompareBranchArgs(["feature/worktree-review", "main"]), {
		targetBranch: "feature/worktree-review",
		baseBranch: "main",
	});
});

test("parseCompareBranchArgs rejects a missing target branch", () => {
	assert.equal(parseCompareBranchArgs([]), null);
});

test("buildCompareBranchesPrompt uses resolved merge base when available", () => {
	const prompt = buildCompareBranchesPrompt({
		targetBranch: "feature/worktree-review",
		baseBranch: "main",
		mergeBaseSha: "abc1234",
	});

	assert.match(prompt, /Review the code changes on 'feature\/worktree-review' against the base branch 'main'/);
	assert.match(prompt, /merge base commit for this comparison is abc1234/);
	assert.match(prompt, /git diff abc1234 feature\/worktree-review/);
	assert.doesNotMatch(prompt, /git merge-base feature\/worktree-review main/);
});

test("buildCompareBranchesPrompt provides fallback commands when merge base is unavailable", () => {
	const prompt = buildCompareBranchesPrompt({
		targetBranch: "feature/worktree-review",
		baseBranch: "main",
	});

	assert.match(prompt, /Review the code changes on 'feature\/worktree-review' against the base branch 'main'/);
	assert.match(prompt, /git merge-base feature\/worktree-review main/);
	assert.match(prompt, /git diff <mergeBaseSha> feature\/worktree-review/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test --experimental-strip-types extensions/review-compare.test.ts
```

Expected: FAIL because `extensions/review-compare.ts` does not exist yet.

---

### Task 2: Implement pure compare helper

**Files:**
- Create: `extensions/review-compare.ts`
- Test: `extensions/review-compare.test.ts`

- [ ] **Step 1: Add minimal implementation**

Create `extensions/review-compare.ts`:

```ts
export type CompareBranchesTarget = {
	targetBranch: string;
	baseBranch?: string;
};

export type CompareBranchesPromptInput = {
	targetBranch: string;
	baseBranch: string;
	mergeBaseSha?: string | null;
};

export function parseCompareBranchArgs(parts: string[]): CompareBranchesTarget | null {
	const targetBranch = parts[0]?.trim();
	if (!targetBranch) return null;

	const baseBranch = parts[1]?.trim() || undefined;
	return baseBranch ? { targetBranch, baseBranch } : { targetBranch };
}

export function buildCompareBranchesPrompt(input: CompareBranchesPromptInput): string {
	const { targetBranch, baseBranch, mergeBaseSha } = input;
	if (mergeBaseSha?.trim()) {
		return `Review the code changes on '${targetBranch}' against the base branch '${baseBranch}'. The merge base commit for this comparison is ${mergeBaseSha.trim()}. Run \`git diff ${mergeBaseSha.trim()} ${targetBranch}\` to inspect the changes on ${targetBranch} without checking it out. Provide prioritized, actionable findings.`;
	}

	return `Review the code changes on '${targetBranch}' against the base branch '${baseBranch}' without checking out ${targetBranch}. Start by finding the merge base with \`git merge-base ${targetBranch} ${baseBranch}\`, then run \`git diff <mergeBaseSha> ${targetBranch}\` to inspect the changes on ${targetBranch}. Provide prioritized, actionable findings.`;
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run:

```bash
node --test --experimental-strip-types extensions/review-compare.test.ts
```

Expected: PASS.

---

### Task 3: Wire compare target into `review.ts`

**Files:**
- Modify: `extensions/review.ts`
- Test: `extensions/review-compare.test.ts`

- [ ] **Step 1: Add imports and target type**

In `extensions/review.ts`, import the helper:

```ts
import {
	buildCompareBranchesPrompt,
	parseCompareBranchArgs,
	type CompareBranchesTarget,
} from "./review-compare.ts";
```

Extend `ReviewTarget` with:

```ts
| { type: "compareBranches"; targetBranch: string; baseBranch: string }
```

- [ ] **Step 2: Add merge-base helper for arbitrary refs**

Add near `getMergeBase`:

```ts
async function getMergeBaseBetweenRefs(
	pi: ExtensionAPI,
	leftRef: string,
	rightRef: string,
): Promise<string | null> {
	try {
		const { stdout, code } = await pi.exec("git", ["merge-base", leftRef, rightRef]);
		if (code === 0 && stdout.trim()) {
			return stdout.trim();
		}
		return null;
	} catch {
		return null;
	}
}
```

- [ ] **Step 3: Add prompt handling**

In `buildReviewPrompt`, add this switch case:

```ts
case "compareBranches": {
	const mergeBase = await getMergeBaseBetweenRefs(pi, target.targetBranch, target.baseBranch);
	return buildCompareBranchesPrompt({
		targetBranch: target.targetBranch,
		baseBranch: target.baseBranch,
		mergeBaseSha: mergeBase,
	});
}
```

- [ ] **Step 4: Add user-facing hint**

In `getUserFacingHint`, add:

```ts
case "compareBranches":
	return `branch '${target.targetBranch}' against '${target.baseBranch}'`;
```

- [ ] **Step 5: Run helper tests**

Run:

```bash
node --test --experimental-strip-types extensions/review-compare.test.ts
```

Expected: PASS.

---

### Task 4: Add selector and direct command support

**Files:**
- Modify: `extensions/review.ts`
- Test: `extensions/review-compare.test.ts`

- [ ] **Step 1: Add preset**

Add this item to `REVIEW_PRESETS` after `baseBranch`:

```ts
{ value: "compareBranches", label: "Review another branch against base", description: "(no checkout)" },
```

- [ ] **Step 2: Add selector flow**

Add a function:

```ts
async function showCompareBranchesSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
	const targetBranch = await showBranchOrRefSelector(ctx, {
		title: "Select target branch/ref to review",
		excludeCurrentBranch: false,
		defaultToDefaultBranch: false,
	});
	if (!targetBranch) return null;

	const defaultBranch = await getDefaultBranch(pi);
	const baseBranch = await showBranchOrRefSelector(ctx, {
		title: "Select base branch/ref",
		excludeCurrentBranch: false,
		defaultToDefaultBranch: true,
		excludeBranches: [targetBranch],
	});
	if (!baseBranch) return null;

	return { type: "compareBranches", targetBranch, baseBranch: baseBranch || defaultBranch };
}
```

If the existing branch selector cannot support free-form refs cleanly, implement `showBranchOrRefSelector` as a small wrapper around the current branch list selector plus editor fallback:

```ts
type BranchOrRefSelectorOptions = {
	title: string;
	excludeCurrentBranch?: boolean;
	defaultToDefaultBranch?: boolean;
	excludeBranches?: string[];
};
```

The selector should sort default branch first, allow filtering, and return the selected branch. If no branches are available, use `ctx.ui.editor(options.title, defaultValue)` to allow a free-form ref.

- [ ] **Step 3: Handle preset result**

In the selector switch, add:

```ts
case "compareBranches": {
	const target = await showCompareBranchesSelector(ctx);
	if (target) return target;
	break;
}
```

- [ ] **Step 4: Parse direct command syntax**

In `parseArgs`, add:

```ts
case "compare": {
	const parsed = parseCompareBranchArgs(parts.slice(1));
	if (!parsed) return { target: null, extraInstruction };
	return {
		target: {
			type: "compareBranches",
			targetBranch: parsed.targetBranch,
			baseBranch: parsed.baseBranch || "",
		},
		extraInstruction,
	};
}
```

After parsing direct args and before executing review, resolve an empty compare base with `getDefaultBranch(pi)`:

```ts
if (target?.type === "compareBranches" && !target.baseBranch) {
	target = { ...target, baseBranch: await getDefaultBranch(pi) };
}
```

- [ ] **Step 5: Run helper tests**

Run:

```bash
node --test --experimental-strip-types extensions/review-compare.test.ts
```

Expected: PASS.

---

### Task 5: Verify integration and update usage docs

**Files:**
- Modify: `extensions/review.ts`
- Test: `extensions/review-compare.test.ts`

- [ ] **Step 1: Update header usage comment**

Add to the top usage block:

```ts
 * - `/review compare feature/my-branch main` - review another branch/ref against a base branch without checkout
```

Add to the supported modes list:

```ts
 * - Review another branch/ref against a base branch without checkout
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
node --test --experimental-strip-types extensions/review-compare.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run all local extension tests**

Run:

```bash
node --test --experimental-strip-types extensions/**/*.test.ts
```

Expected: PASS for `extensions/answer/answer-parser.test.ts` and `extensions/review-compare.test.ts`.

- [ ] **Step 4: Inspect diff**

Run:

```bash
git diff -- extensions/review.ts extensions/review-compare.ts extensions/review-compare.test.ts docs/specs/2026-06-03-branch-review-preset-design.md docs/plans/2026-06-03-branch-review-preset.md
```

Expected: diff only includes the new compare-review preset, helper/tests, and docs.

---

## Self-Review

- Spec coverage: UI preset, direct syntax, selectable base, no checkout, merge-base prompt behavior, fallback prompt behavior, existing instructions, and testing are covered by Tasks 1-5.
- Placeholder scan: The plan contains no TBD/TODO/FIXME placeholders.
- Type consistency: The plan consistently uses `compareBranches`, `targetBranch`, `baseBranch`, `parseCompareBranchArgs`, and `buildCompareBranchesPrompt`.
