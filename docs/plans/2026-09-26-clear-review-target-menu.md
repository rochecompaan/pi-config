# Clear Review Target Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/review` show six clear review targets and remove loop fixing plus all optional review guidance features.

**Architecture:** Keep the extension entry point in `extensions/review/index.ts` and remove the unused state and orchestration there. Add one pure command-option validator so removed `--extra` input has direct test coverage. Preserve the focused profile, model, finding-verification, summary, and todo modules.

**Tech Stack:** TypeScript, Node.js test runner, Pi extension API, `@mariozechner/pi-tui`, Nix flake checks

**Design:** `docs/specs/2026-09-26-clear-review-target-menu-design.md`

## Global Constraints

- Keep the six review targets in the approved order.
- Keep the current smart-default rules without reordering the menu.
- Keep review profiles and model selection unchanged.
- Keep fresh-session and current-session review modes unchanged.
- Keep the one-time `Return and fix findings` workflow unchanged.
- Remove automatic loop fixing from code, state, prompts, and UI.
- Remove persistent custom review instructions.
- Remove per-review `--extra` instructions.
- Remove `REVIEW_GUIDELINES.md` loading.
- Report `--extra` as unsupported. Do not ignore it or treat it as a review target.
- Ignore old session entries for removed review settings. Do not add a migration.
- Leave historical plans and specifications unchanged.
- Do not add an automated test that only asserts static UI text.

## File Structure

- Create `extensions/review/review-command-options.ts` for validation of unsupported review command options.
- Create `extensions/review/review-command-options.test.ts` for command-option behavior.
- Modify `extensions/review/review-profile.ts` to parse only profile options.
- Modify `extensions/review/review-profile.test.ts` to remove obsolete `--extra` composition cases.
- Modify `extensions/review/index.ts` to remove guidance and loop features, then update the target selector.

`extensions/review/index.ts` is already large. This work removes several responsibilities and many lines. Do not add an unrelated module split.

---

### Task 1: Remove Optional Review Guidance

**Files:**
- Create: `extensions/review/review-command-options.ts`
- Create: `extensions/review/review-command-options.test.ts`
- Modify: `extensions/review/review-profile.ts:58-115`
- Modify: `extensions/review/review-profile.test.ts:39-60,87-94`
- Modify: `extensions/review/index.ts:1-185,735-763,1104-1365,1730-1768,1894-2056,2106-2348`

**Interfaces:**
- Produces: `getUnsupportedReviewOptionError(parts: readonly string[]): string | undefined`
- Preserves: `parseReviewProfileOption(parts: string[]): ParsedReviewProfileOption`
- Consumes: the existing `tokenizeArgs()` result before profile parsing

- [ ] **Step 1: Add failing tests for the removed command option**

Create `extensions/review/review-command-options.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { getUnsupportedReviewOptionError } from "./review-command-options.ts";

test("getUnsupportedReviewOptionError rejects both --extra forms", () => {
	assert.equal(getUnsupportedReviewOptionError(["--extra", "focus on security"]), "--extra is no longer supported.");
	assert.equal(getUnsupportedReviewOptionError(["--extra=focus on security"]), "--extra is no longer supported.");
});

test("getUnsupportedReviewOptionError accepts supported review arguments", () => {
	assert.equal(
		getUnsupportedReviewOptionError(["branch", "main", "--profile", "thermo-nuclear"]),
		undefined,
	);
});
```

- [ ] **Step 2: Run the new test and observe the expected failure**

Run:

```sh
node --test --experimental-strip-types extensions/review/review-command-options.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `review-command-options.ts`.

- [ ] **Step 3: Add the minimal command-option validator**

Create `extensions/review/review-command-options.ts`:

```ts
const EXTRA_OPTION = "--extra";
const EXTRA_OPTION_ERROR = "--extra is no longer supported.";

export function getUnsupportedReviewOptionError(parts: readonly string[]): string | undefined {
	const hasExtraOption = parts.some((part) => part === EXTRA_OPTION || part.startsWith(`${EXTRA_OPTION}=`));
	return hasExtraOption ? EXTRA_OPTION_ERROR : undefined;
}
```

- [ ] **Step 4: Run the validator tests**

Run:

```sh
node --test --experimental-strip-types extensions/review/review-command-options.test.ts
```

Expected: 2 tests pass and 0 tests fail.

- [ ] **Step 5: Make profile parsing independent of removed options**

In `extensions/review/review-profile.ts`, remove the two `--extra` branches from `parseReviewProfileOption()`.

The loop must start with profile handling:

```ts
for (let i = 0; i < parts.length; i++) {
	const part = parts[i];

	if (part === "--profile") {
		profileSpecified = true;
		const next = parts[i + 1];
		if (!next || next.startsWith("--")) {
			error = error ?? "Missing value for --profile";
			continue;
		}

		const parsed = parseProfileValue(next);
		if (parsed.error) {
			error = error ?? parsed.error;
		} else if (!error) {
			profile = parsed.profile;
		}
		i += 1;
		continue;
	}

	if (part.startsWith("--profile=")) {
		profileSpecified = true;
		const parsed = parseProfileValue(part.slice("--profile=".length));
		if (parsed.error) {
			error = error ?? parsed.error;
		} else if (!error) {
			profile = parsed.profile;
		}
		continue;
	}

	remainingParts.push(part);
}
```

Delete these obsolete tests from `extensions/review/review-profile.test.ts`:

- `parseReviewProfileOption preserves --extra args for the existing parser`
- `parseReviewProfileOption preserves --extra values that look like profile flags`

- [ ] **Step 6: Reject `--extra` before profile and target parsing**

Import the validator in `extensions/review/index.ts`:

```ts
import { getUnsupportedReviewOptionError } from "./review-command-options.ts";
```

Remove `extraInstruction` from `ParsedReviewArgs`.

After `tokenizeArgs()`, return a parse error before profile parsing:

```ts
const rawParts = tokenizeArgs(args.trim());
const unsupportedOptionError = getUnsupportedReviewOptionError(rawParts);
if (unsupportedOptionError) {
	return {
		target: null,
		profile: DEFAULT_REVIEW_PROFILE_ID,
		profileSpecified: false,
		error: unsupportedOptionError,
	};
}

const profileParse = parseReviewProfileOption(rawParts);
```

Use `profileParse.parts` directly. Remove the loop that extracts `--extra` values.

The common parse result must contain only profile data:

```ts
const parts = profileParse.parts;
const baseResult = {
	profile: profileParse.profile,
	profileSpecified: profileParse.profileSpecified,
};
```

Remove `extraInstruction` from the `/review` command handler and from every call to `executeReview()`.

- [ ] **Step 7: Remove persistent and project review guidance**

In `extensions/review/index.ts`:

1. Remove the `node:path` and `node:fs` imports.
2. Remove `reviewCustomInstructions` from module state.
3. Remove `customInstructions` from `ReviewSettingsState`.
4. Remove custom-instruction reads and writes from review settings.
5. Remove `setReviewCustomInstructions()`.
6. Remove the custom-instruction selector item and its editor flow.
7. Remove `loadProjectReviewGuidelines()`.
8. Remove `extraInstruction` from `ExecuteReviewOptions`.
9. Remove custom, per-run, and project additions from `dispatchReviewPrompt()`.
10. Remove guidance references from the file header and command usage comments.

Until Task 2 removes loop fixing, the settings type contains only this field:

```ts
type ReviewSettingsState = {
	loopFixingEnabled?: boolean;
};
```

Until Task 2 removes loop fixing, `ReviewPresetValue` contains only target values and the loop toggle:

```ts
type ReviewPresetValue =
	| (typeof REVIEW_PRESETS)[number]["value"]
	| typeof TOGGLE_LOOP_FIXING_VALUE;
```

The final prompt assembly for this task is:

```ts
const profile = options?.profile ?? DEFAULT_REVIEW_PROFILE_ID;
const rubric = REVIEW_PROFILE_RUBRICS[profile];
const fullPrompt = `${rubric}\n\n---\n\nPlease perform a code review with the following focus:\n\n${prompt}`;
```

Also remove `extraInstruction` from `runLoopFixingReview()` and its `executeReview()` call. Task 2 removes the complete loop runner.

- [ ] **Step 8: Run focused tests and source checks**

Run:

```sh
node --test --experimental-strip-types \
  extensions/review/review-command-options.test.ts \
  extensions/review/review-profile.test.ts

! rg -n 'reviewCustomInstructions|custom review instructions|extraInstruction|REVIEW_GUIDELINES|loadProjectReviewGuidelines' extensions/review
rg -n -- '--extra' extensions/review
```

Expected:

- All focused tests pass.
- The negative `rg` command prints no matches.
- `--extra` appears only in `review-command-options.ts` and its test.

- [ ] **Step 9: Run the complete review test suite**

Run:

```sh
node --test --experimental-strip-types extensions/review/*.test.ts
```

Expected: all review tests pass.

- [ ] **Step 10: Commit the guidance removal**

```sh
git add \
  extensions/review/index.ts \
  extensions/review/review-command-options.ts \
  extensions/review/review-command-options.test.ts \
  extensions/review/review-profile.ts \
  extensions/review/review-profile.test.ts
git commit -m "refactor(review): remove optional review guidance"
```

---

### Task 2: Remove Automatic Loop Fixing

**Files:**
- Modify: `extensions/review/index.ts:88-399,411-415,959-1012,1085-1101,1104-1365,1730-1770,1774-1892,2058-2205,2207-2348`
- Test: `extensions/review/review-finding-verification.test.ts`
- Test: `extensions/review/review-verified-fix-workflow.test.ts`

**Interfaces:**
- Removes: all automatic loop-fixing state and orchestration
- Preserves: `runVerifiedFixWorkflow(summaryText, dependencies): Promise<VerifiedFixWorkflowResult>`
- Preserves: `executeEndReviewAction(ctx, "returnVerifyAndFix", options)`
- Preserves: `waitForAgentTurnToStart(ctx, previousAssistantId?)`

The Testing Value Gate excludes a new test that only scans for deleted loop symbols. Use existing behavioral tests plus direct source checks.

- [ ] **Step 1: Run the preserved finding and fix workflow tests**

Run:

```sh
node --test --experimental-strip-types \
  extensions/review/review-finding-verification.test.ts \
  extensions/review/review-verified-fix-workflow.test.ts
```

Expected: all tests pass before the deletion.

- [ ] **Step 2: Remove loop settings and simplify active review state**

In `extensions/review/index.ts`, remove:

- `reviewLoopFixingEnabled`
- `reviewLoopInProgress`
- `REVIEW_SETTINGS_TYPE`
- `REVIEW_LOOP_MAX_ITERATIONS`
- `ReviewSettingsState`
- `getReviewSettings()`
- `applyReviewSettings()`
- `persistReviewSettings()`
- `setReviewLoopFixingEnabled()`
- `applyAllReviewState()`

Make all three session handlers call `applyReviewState(ctx)` directly:

```ts
pi.on("session_start", (_event, ctx) => {
	applyReviewState(ctx);
});

pi.on("session_switch", (_event, ctx) => {
	applyReviewState(ctx);
});

pi.on("session_tree", (_event, ctx) => {
	applyReviewState(ctx);
});
```

Simplify the review widget message:

```ts
const message = "Review session active, return with /end-review";
```

Old `review-settings` entries remain in session history. No code reads them after this task.

- [ ] **Step 3: Keep turn-start timing for the one-time verified fix workflow**

Rename the two shared constants:

```ts
const REVIEW_TURN_START_TIMEOUT_MS = 15000;
const REVIEW_TURN_START_POLL_MS = 50;
```

Update `waitForAgentTurnToStart()` to use the renamed constants:

```ts
async function waitForAgentTurnToStart(ctx: ExtensionContext, previousAssistantId?: string): Promise<boolean> {
	const deadline = Date.now() + REVIEW_TURN_START_TIMEOUT_MS;

	while (Date.now() < deadline) {
		const lastAssistantId = getLastAssistantSnapshot(ctx)?.id;
		if (!ctx.isIdle() || ctx.hasPendingMessages() || (lastAssistantId && lastAssistantId !== previousAssistantId)) {
			return true;
		}
		await sleep(REVIEW_TURN_START_POLL_MS);
	}

	return false;
}
```

Do not remove this function. The one-time verified fix workflow uses it.

- [ ] **Step 4: Remove loop-only result parsing and prompt behavior**

Delete these loop-only functions from `extensions/review/index.ts`:

- `parseMarkdownHeading()`
- `getFindingsSectionBounds()`
- `isLikelyFindingLine()`
- `normalizeVerdictValue()`
- `isNeedsAttentionVerdictValue()`
- `hasNeedsAttentionVerdict()`
- `hasBlockingReviewFindings()`
- `isLoopCompatibleTarget()`
- `runLoopFixingReview()`

Remove `LOCAL_CHANGES_REVIEW_INSTRUCTIONS`.

Remove `includeLocalChanges` from `buildReviewPrompt()` and `ExecuteReviewOptions`.

Each affected target case in `buildReviewPrompt()` must return its normal prompt directly:

```ts
case "baseBranch": {
	const mergeBase = await getMergeBase(pi, target.branch);
	return mergeBase
		? BASE_BRANCH_PROMPT_WITH_MERGE_BASE.replace(/{baseBranch}/g, target.branch).replace(/{mergeBaseSha}/g, mergeBase)
		: BASE_BRANCH_PROMPT_FALLBACK.replace(/{branch}/g, target.branch);
}

case "compareBranches": {
	const mergeBase = await getMergeBaseBetweenRefs(pi, target.targetBranch, target.baseBranch);
	return buildCompareBranchesPrompt({
		targetBranch: target.targetBranch,
		baseBranch: target.baseBranch,
		mergeBaseSha: mergeBase,
	});
}

case "pullRequest": {
	const mergeBase = await getMergeBase(pi, target.baseBranch);
	return mergeBase
		? PULL_REQUEST_PROMPT
				.replace(/{prNumber}/g, String(target.prNumber))
				.replace(/{title}/g, target.title)
				.replace(/{baseBranch}/g, target.baseBranch)
				.replace(/{mergeBaseSha}/g, mergeBase)
		: PULL_REQUEST_PROMPT_FALLBACK
				.replace(/{prNumber}/g, String(target.prNumber))
				.replace(/{title}/g, target.title)
				.replace(/{baseBranch}/g, target.baseBranch);
}
```

- [ ] **Step 5: Remove the loop toggle from the target selector**

Remove:

- `TOGGLE_LOOP_FIXING_VALUE`
- the loop union member from `ReviewPresetValue`
- loop toggle labels and descriptions
- the loop toggle selector item
- the loop toggle handler
- the commit-target loop compatibility check

`ReviewPresetValue` becomes:

```ts
type ReviewPresetValue = (typeof REVIEW_PRESETS)[number]["value"];
```

Keep the selector loop that returns users to the target list after a child selector is cancelled. It is navigation, not loop fixing.

The item list contains only the six target items:

```ts
const items: SelectItem[] = REVIEW_PRESETS.map((preset) => ({
	value: preset.value,
	label: preset.label,
	description: preset.description,
}));
```

Use `items` for the smart-default index and `SelectList`.

- [ ] **Step 6: Remove loop branches from the `/review` command**

Remove:

- the `reviewLoopInProgress` guard
- target compatibility checks
- the `runLoopFixingReview()` branch
- loop-specific notifications

After target selection, the handler must continue directly to session-mode selection and optional model selection.

Keep the existing `while (true)` navigation. It returns to target selection when the user cancels a child flow.

- [ ] **Step 7: Prove that loop code is gone and the manual fix workflow remains**

Run:

```sh
! rg -n 'reviewLoop|loop fixing|Loop Fixing|LOOP_' extensions/review/index.ts
rg -n 'runVerifiedFixWorkflow|returnVerifyAndFix|waitForAgentTurnToStart' extensions/review/index.ts

node --test --experimental-strip-types \
  extensions/review/review-finding-verification.test.ts \
  extensions/review/review-verified-fix-workflow.test.ts
```

Expected:

- The negative source check prints no matches.
- The preserved workflow source check prints all three names.
- All finding and verified-fix tests pass.

- [ ] **Step 8: Run the complete review test suite**

Run:

```sh
node --test --experimental-strip-types extensions/review/*.test.ts
```

Expected: all review tests pass.

- [ ] **Step 9: Commit the loop removal**

```sh
git add extensions/review/index.ts
git commit -m "refactor(review): remove automatic loop fixing"
```

---

### Task 3: Clarify the Review Target Selector

**Files:**
- Modify: `extensions/review/index.ts:1-34,1104-1365,2207-2210`

**Interfaces:**
- Preserves: `showReviewSelector(ctx): Promise<ReviewTarget | null>`
- Preserves: `getSmartDefault(): Promise<"uncommitted" | "baseBranch" | "commit">`
- Changes: review target labels, descriptions, and selector heading only

The Testing Value Gate excludes an automated test for static UI copy. Use direct text checks and an interactive smoke test.

- [ ] **Step 1: Replace the target option copy**

Replace `REVIEW_PRESETS` with this exact value and order:

```ts
const REVIEW_PRESETS = [
	{
		value: "uncommitted",
		label: "Uncommitted changes",
		description: "Staged, unstaged, and untracked files",
	},
	{
		value: "baseBranch",
		label: "Current branch",
		description: "Compare the checked-out branch with a base branch",
	},
	{
		value: "compareBranches",
		label: "Another branch or ref",
		description: "Compare it with a base branch without checking it out",
	},
	{
		value: "commit",
		label: "Commit",
		description: "Changes introduced by one commit",
	},
	{
		value: "pullRequest",
		label: "GitHub pull request",
		description: "Check out and review a PR",
	},
	{
		value: "folder",
		label: "Files or folders",
		description: "Review current contents, not Git changes",
	},
] as const;
```

Keep this order stable. Do not sort by the smart default.

- [ ] **Step 2: Replace the selector heading and current help text**

Change the selector heading to:

```ts
container.addChild(new Text(theme.fg("accent", theme.bold("What do you want to review?"))));
```

Update the file header to describe the six current targets. Remove all obsolete guidance and loop references.

Use this command description:

```ts
description: "Review uncommitted changes, branches, commits, GitHub PRs, or files",
```

Do not change target subcommands or target-specific child selectors.

- [ ] **Step 3: Check the approved copy directly**

Run:

```sh
rg -n \
  'What do you want to review\?|Uncommitted changes|Current branch|Another branch or ref|GitHub pull request|Files or folders' \
  extensions/review/index.ts

! rg -n \
  'Select a review preset|Review against a base branch|Review another branch against base|snapshot, not diff|\(local\)|\(no checkout\)' \
  extensions/review/index.ts
```

Expected:

- The first command finds the approved heading and labels.
- The second command prints no matches.

- [ ] **Step 4: Run all automated verification**

Run:

```sh
node --test --experimental-strip-types extensions/review/*.test.ts
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
git diff --check
```

Expected: all commands exit with status 0.

- [ ] **Step 5: Smoke-test the selector in Pi**

Start Pi with only the worktree extension:

```sh
pi --no-extensions -e ./extensions/review/index.ts
```

In Pi, run `/review` and inspect the target selector.

Make sure that:

1. The heading is `What do you want to review?`.
2. The selector contains exactly six target rows.
3. The rows use the approved order, labels, and descriptions.
4. The smart default is selected without moving its row.
5. `Current branch` asks only for a base branch.
6. `Another branch or ref` asks for a target ref and then a base ref.
7. Cancelling a child selector returns to the target selector.
8. The menu has no guidance or loop settings.

Exit Pi without starting an unwanted review.

- [ ] **Step 6: Review the final diff and commit the selector change**

Run:

```sh
git status --short
git diff --stat HEAD~2
git diff --check
git log -3 --oneline
```

Expected: only the planned review extension files differ from the plan commit.

Commit the selector change:

```sh
git add extensions/review/index.ts
git commit -m "feat(review): clarify review target selection"
```

- [ ] **Step 7: Confirm a clean implementation state**

Run:

```sh
git status --short --branch
```

Expected: the branch is clean and contains the design, plan, and three implementation commits.
