# Review Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add selectable `/review` profiles so users can choose the existing standard rubric or a separate thermo-nuclear code-quality rubric.

**Architecture:** Keep `/review` target/session behavior unchanged and add a narrow profile layer. Put pure profile parsing in a small tested module, keep the two rubric constants separate, and pass the selected profile into the existing review execution path.

**Tech Stack:** TypeScript Pi extension, Node built-in test runner (`node:test`), `node --test --experimental-strip-types`.

---

## File Structure

- Create `extensions/review/review-profile.ts`
  - Owns review profile IDs, labels/descriptions, default profile, validation, profile-list formatting, and `--profile` option extraction from tokenized args.
  - Pure logic only; no Pi extension imports and no rubric prompt text.
- Create `extensions/review/review-profile.test.ts`
  - Tests default profile behavior, `--profile value`, `--profile=value`, unknown profile errors, missing value errors, and preserving existing args such as `--extra`.
- Modify `extensions/review/index.ts`
  - Imports profile helpers.
  - Adds a new `THERMO_NUCLEAR_RUBRIC` constant separate from `REVIEW_RUBRIC`.
  - Adds a profile-to-rubric registry local to the review extension.
  - Adds an interactive profile selector that runs before target selection when no explicit target was provided.
  - Parses `--profile` before existing `--extra` and target parsing.
  - Passes the selected profile into `executeReview()` and loop-fixing review calls.

`extensions/review/index.ts` is already large, but this plan keeps behavior extraction limited to pure profile parsing. The rubric constant stays beside the existing rubric to avoid a broader prompt-file refactor.

---

### Task 1: Add failing tests for review profile parsing

**Files:**
- Create: `extensions/review/review-profile.test.ts`

- [ ] **Step 1: Create the failing test file**

Create `extensions/review/review-profile.test.ts` with this content:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_REVIEW_PROFILE_ID,
	REVIEW_PROFILE_IDS,
	formatReviewProfileList,
	parseReviewProfileOption,
} from "./review-profile.ts";

test("known review profiles are listed in user-facing order", () => {
	assert.deepEqual(REVIEW_PROFILE_IDS, ["standard", "thermo-nuclear"]);
	assert.equal(formatReviewProfileList(), "standard, thermo-nuclear");
});

test("parseReviewProfileOption defaults to standard when no profile is supplied", () => {
	assert.deepEqual(parseReviewProfileOption(["branch", "main"]), {
		profile: DEFAULT_REVIEW_PROFILE_ID,
		profileSpecified: false,
		parts: ["branch", "main"],
	});
});

test("parseReviewProfileOption accepts separated --profile value", () => {
	assert.deepEqual(parseReviewProfileOption(["branch", "main", "--profile", "thermo-nuclear"]), {
		profile: "thermo-nuclear",
		profileSpecified: true,
		parts: ["branch", "main"],
	});
});

test("parseReviewProfileOption accepts equals --profile value", () => {
	assert.deepEqual(parseReviewProfileOption(["--profile=thermo-nuclear", "uncommitted"]), {
		profile: "thermo-nuclear",
		profileSpecified: true,
		parts: ["uncommitted"],
	});
});

test("parseReviewProfileOption preserves --extra args for the existing parser", () => {
	assert.deepEqual(
		parseReviewProfileOption(["branch", "main", "--extra", "focus on API boundaries", "--profile", "thermo-nuclear"]),
		{
			profile: "thermo-nuclear",
			profileSpecified: true,
			parts: ["branch", "main", "--extra", "focus on API boundaries"],
		},
	);
});

test("parseReviewProfileOption rejects unknown profile names", () => {
	assert.deepEqual(parseReviewProfileOption(["--profile", "extreme", "branch", "main"]), {
		profile: DEFAULT_REVIEW_PROFILE_ID,
		profileSpecified: true,
		parts: ["branch", "main"],
		error: "Unknown review profile: extreme. Available profiles: standard, thermo-nuclear",
	});
});

test("parseReviewProfileOption rejects missing separated profile values", () => {
	assert.deepEqual(parseReviewProfileOption(["branch", "main", "--profile"]), {
		profile: DEFAULT_REVIEW_PROFILE_ID,
		profileSpecified: true,
		parts: ["branch", "main"],
		error: "Missing value for --profile",
	});
});

test("parseReviewProfileOption rejects empty equals profile values", () => {
	assert.deepEqual(parseReviewProfileOption(["--profile=", "branch", "main"]), {
		profile: DEFAULT_REVIEW_PROFILE_ID,
		profileSpecified: true,
		parts: ["branch", "main"],
		error: "Missing value for --profile",
	});
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run:

```bash
node --test --experimental-strip-types extensions/review/review-profile.test.ts
```

Expected: FAIL because `extensions/review/review-profile.ts` does not exist yet. The failure should mention a missing module or unresolved import for `./review-profile.ts`.

- [ ] **Step 3: Commit the failing test**

```bash
git add extensions/review/review-profile.test.ts
git commit -m "test(review): cover review profile parsing"
```

---

### Task 2: Implement the pure review profile parser

**Files:**
- Create: `extensions/review/review-profile.ts`
- Test: `extensions/review/review-profile.test.ts`

- [ ] **Step 1: Create the profile parser module**

Create `extensions/review/review-profile.ts` with this content:

```ts
export const REVIEW_PROFILE_IDS = ["standard", "thermo-nuclear"] as const;

export type ReviewProfileId = (typeof REVIEW_PROFILE_IDS)[number];

export type ReviewProfileOption = {
	id: ReviewProfileId;
	label: string;
	description: string;
};

export type ParsedReviewProfileOption = {
	profile: ReviewProfileId;
	profileSpecified: boolean;
	parts: string[];
	error?: string;
};

export const DEFAULT_REVIEW_PROFILE_ID: ReviewProfileId = "standard";

export const REVIEW_PROFILE_OPTIONS: readonly ReviewProfileOption[] = [
	{
		id: "standard",
		label: "Standard review",
		description: "Default correctness, security, and maintainability review",
	},
	{
		id: "thermo-nuclear",
		label: "Thermo-nuclear code quality review",
		description: "Strict structural maintainability and abstraction review",
	},
] as const;

export function isReviewProfileId(value: string): value is ReviewProfileId {
	return (REVIEW_PROFILE_IDS as readonly string[]).includes(value);
}

export function formatReviewProfileList(): string {
	return REVIEW_PROFILE_IDS.join(", ");
}

function profileError(value: string): string {
	return `Unknown review profile: ${value}. Available profiles: ${formatReviewProfileList()}`;
}

function parseProfileValue(value: string | undefined): { profile: ReviewProfileId; error?: string } {
	if (!value?.trim()) {
		return { profile: DEFAULT_REVIEW_PROFILE_ID, error: "Missing value for --profile" };
	}

	const trimmed = value.trim();
	if (!isReviewProfileId(trimmed)) {
		return { profile: DEFAULT_REVIEW_PROFILE_ID, error: profileError(trimmed) };
	}

	return { profile: trimmed };
}

export function parseReviewProfileOption(parts: string[]): ParsedReviewProfileOption {
	let profile = DEFAULT_REVIEW_PROFILE_ID;
	let profileSpecified = false;
	let error: string | undefined;
	const remainingParts: string[] = [];

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];

		if (part === "--profile") {
			profileSpecified = true;
			const next = parts[i + 1];
			if (!next || next.startsWith("--")) {
				error = "Missing value for --profile";
				continue;
			}

			const parsed = parseProfileValue(next);
			profile = parsed.profile;
			error = parsed.error;
			i += 1;
			continue;
		}

		if (part.startsWith("--profile=")) {
			profileSpecified = true;
			const parsed = parseProfileValue(part.slice("--profile=".length));
			profile = parsed.profile;
			error = parsed.error;
			continue;
		}

		remainingParts.push(part);
	}

	return error
		? { profile, profileSpecified, parts: remainingParts, error }
		: { profile, profileSpecified, parts: remainingParts };
}
```

- [ ] **Step 2: Run the new profile tests**

Run:

```bash
node --test --experimental-strip-types extensions/review/review-profile.test.ts
```

Expected: PASS for all `review-profile.test.ts` tests. Node may print the existing `MODULE_TYPELESS_PACKAGE_JSON` warning; that warning is acceptable here.

- [ ] **Step 3: Run existing pure extension tests**

Run:

```bash
node --test --experimental-strip-types extensions/review/review-profile.test.ts extensions/review/review-compare.test.ts extensions/answer/answer-parser.test.ts
```

Expected: PASS for all tests.

- [ ] **Step 4: Commit the parser implementation**

```bash
git add extensions/review/review-profile.ts extensions/review/review-profile.test.ts
git commit -m "feat(review): add review profile parser"
```

---

### Task 3: Add the thermo-nuclear rubric and profile registry

**Files:**
- Modify: `extensions/review/index.ts`

- [ ] **Step 1: Add profile imports**

In `extensions/review/index.ts`, replace this import block:

```ts
import {
	buildCompareBranchesPrompt,
	parseCompareBranchArgs,
	type CompareBranchesTarget,
} from "./review-compare.ts";
```

with:

```ts
import {
	buildCompareBranchesPrompt,
	parseCompareBranchArgs,
	type CompareBranchesTarget,
} from "./review-compare.ts";
import {
	DEFAULT_REVIEW_PROFILE_ID,
	REVIEW_PROFILE_OPTIONS,
	parseReviewProfileOption,
	type ReviewProfileId,
} from "./review-profile.ts";
```

- [ ] **Step 2: Add the separate thermo-nuclear rubric constant**

In `extensions/review/index.ts`, locate the existing `const REVIEW_RUBRIC = ...` constant. Immediately after the closing backtick and semicolon of `REVIEW_RUBRIC`, insert this separate constant:

```ts
const THERMO_NUCLEAR_RUBRIC = `# Thermo-Nuclear Code Quality Review

You are acting as an extremely strict code-quality reviewer for a proposed code change made by another engineer.

This review is focused on implementation quality, maintainability, abstraction quality, and codebase health. Do not merely identify local cleanup opportunities. Actively search for code-judo moves: restructurings that preserve behavior while making the implementation dramatically simpler, smaller, more direct, and more elegant.

## Core Prompt

Perform a deep code quality audit of the current branch's changes.
Rethink how to structure and implement the changes to meaningfully improve code quality without impacting behavior.
Work to improve abstractions, modularity, reduce spaghetti code, improve succinctness, and improve legibility.
Be ambitious. If there is a clear path to improving the implementation that involves restructuring some of the codebase, push for it.
Be extremely thorough and rigorous. Measure twice, cut once.

## Non-Negotiable Standards

### 1. Be ambitious about structural simplification

- Do not stop at "this could be a bit cleaner."
- Look for opportunities to reframe the change so that whole branches, helpers, modes, conditionals, or layers disappear entirely.
- Prefer the solution that makes the code feel inevitable in hindsight.
- Assume there is often a code-judo move available: a reorganization that uses the existing architecture more effectively and makes the change dramatically simpler and more elegant.
- If you see a path to delete complexity rather than rearrange it, push hard for that path.

### 2. Do not let a change push a file from under 1k lines to over 1k lines without a very strong reason

- Treat this as a strong code-quality smell by default.
- Prefer extracting helpers, components, modules, or local abstractions instead of letting a file sprawl past 1000 lines.
- If the diff crosses that threshold, explicitly ask whether the code should be decomposed first.
- Only waive this if there is a compelling structural reason and the resulting file is still clearly organized.

### 3. Do not allow random spaghetti growth in existing code

- Be highly suspicious of new ad-hoc conditionals, scattered special cases, or one-off branches inserted into unrelated flows.
- If a change adds weird if statements in random places, treat that as a design problem, not a stylistic nit.
- Prefer pushing the logic into a dedicated abstraction, helper, state machine, policy object, or separate module instead of tangling an existing path.
- Call out changes that make the surrounding code harder to reason about, even if they technically work.

### 4. Bias toward cleaning the design, not just accepting working code

- If behavior can stay the same while the structure becomes meaningfully cleaner, push for the cleaner version.
- Do not rubber-stamp working implementations that leave the codebase messier.
- Strongly prefer simplifications that remove moving pieces altogether over refactors that merely spread the same complexity around.

### 5. Prefer direct, boring, maintainable code over hacky or magical code

- Treat brittle, ad-hoc, or magical behavior as a code-quality problem.
- Be skeptical of generic mechanisms that hide simple data-shape assumptions.
- Flag thin abstractions, identity wrappers, or pass-through helpers that add indirection without buying clarity.

### 6. Push hard on type and boundary cleanliness when they affect maintainability

- Question unnecessary optionality, \`unknown\`, \`any\`, or cast-heavy code when a clearer type boundary could exist.
- Prefer explicit typed models or shared contracts over loosely shaped ad-hoc objects.
- If a branch relies on silent fallback to paper over an unclear invariant, ask whether the boundary should be made explicit instead.

### 7. Keep logic in the canonical layer and reuse existing helpers

- Call out feature logic leaking into shared paths or implementation details leaking through APIs.
- Prefer existing canonical utilities and helpers over bespoke one-offs.
- Push code toward the right package, service, or module instead of normalizing architectural drift.

### 8. Treat unnecessary sequential orchestration and non-atomic updates as design smells when the cleaner structure is obvious

- If independent work is serialized for no good reason, ask whether the flow should run in parallel instead.
- If related updates can leave state half-applied, push for a more atomic structure.
- Do not over-index on micro-optimizations, but do flag avoidable orchestration complexity that makes the implementation more brittle.

## Primary Review Questions

For every meaningful change, ask:

- Is there a code-judo move that would make this dramatically simpler?
- Can this change be reframed so fewer concepts, branches, or helper layers are needed?
- Does this improve or worsen the local architecture?
- Did the diff add branching complexity where a better abstraction should exist?
- Did a previously cohesive module become more coupled, more stateful, or harder to scan?
- Is this logic living in the right file and layer?
- Did this change enlarge a file or component past a healthy size boundary?
- Are there repeated conditionals that signal a missing model or missing helper?
- Is the implementation direct and legible, or does it rely on special cases and incidental control flow?
- Is this abstraction actually earning its keep, or is it just a wrapper?
- Did the diff introduce casts, optionality, or ad-hoc object shapes that obscure the real invariant?
- Is this logic living in the canonical layer, or did the diff leak details across a boundary?
- Is this orchestration more sequential or less atomic than it needs to be?

## What to Flag Aggressively

Escalate findings when you see:

- A complicated implementation where a cleaner reframing could delete whole categories of complexity.
- Refactors that move code around but fail to reduce the number of concepts a reader must hold in their head.
- A file crossing 1000 lines due to the change, especially if the new code could be split out.
- New conditionals bolted onto unrelated code paths.
- One-off booleans, nullable modes, or flags that complicate existing control flow.
- Feature-specific logic leaking into general-purpose modules.
- Generic magic handling that hides simple structure and makes the code harder to reason about.
- Thin wrappers or identity abstractions that add indirection without simplifying anything.
- Unnecessary casts, \`any\`, \`unknown\`, or optional params that muddy the real contract.
- Copy-pasted logic instead of extracted helpers.
- Narrow edge-case handling implemented in the middle of an already busy function.
- Refactors that technically pass tests but make the code less modular or less readable.
- Temporary branching that is likely to become permanent debt.
- Bespoke helpers where the codebase already has a canonical utility for the job.
- Logic added in the wrong layer or package when it should live somewhere more central.
- Sequential async flow where obviously independent work could stay simpler and clearer with parallel execution.
- Partial-update logic that leaves state less atomic than necessary.

## Preferred Remedies

When you identify a code-quality problem, prefer suggestions like:

- Delete a whole layer of indirection rather than polishing it.
- Reframe the state model so conditionals disappear instead of getting centralized.
- Change the ownership boundary so the feature becomes a natural extension of an existing abstraction.
- Turn special-case logic into a simpler default flow with fewer exceptions.
- Extract a helper or pure function.
- Split a large file into smaller focused modules.
- Move feature-specific logic behind a dedicated abstraction.
- Replace condition chains with a typed model or explicit dispatcher.
- Separate orchestration from business logic.
- Collapse duplicate branches into a single clearer flow.
- Delete wrappers that do not meaningfully clarify the API.
- Reuse the existing canonical helper instead of introducing a near-duplicate.
- Make type boundaries more explicit so the control flow gets simpler.
- Move the logic to the package or module that already owns the concept.
- Parallelize independent work when that also simplifies the orchestration.
- Restructure related updates into a more atomic flow when partial state would be harder to reason about.

Do not be satisfied with rename-only feedback when the real issue is structural.
Do not be satisfied with a merely cleaner version of the same messy idea if there is a plausible path to a much simpler idea.

## Review Tone

Be direct, serious, and demanding about quality.
Do not be rude, but do not soften major maintainability issues into mild suggestions.
If the code is making the codebase messier, say so clearly.
If the implementation missed an opportunity for a dramatic simplification, say that clearly too.

## Output Expectations

Prioritize findings in this order:

1. Structural code-quality regressions
2. Missed opportunities for dramatic simplification / code-judo restructuring
3. Spaghetti / branching complexity increases
4. Boundary / abstraction / type-contract problems that make the code harder to reason about
5. File-size and decomposition concerns
6. Modularity and abstraction issues
7. Legibility and maintainability concerns

Do not flood the review with low-value nits if there are larger structural issues.
Prefer a smaller number of high-conviction comments over a long list of cosmetic notes.

Provide findings in a clear, structured format:

1. List each finding with a priority tag, file location, and explanation.
2. Use [P0] for drop-everything issues, [P1] for urgent issues, [P2] for normal issues, and [P3] for low-priority maintainability concerns.
3. Findings must reference locations that overlap with the actual diff whenever this is a diff review.
4. Keep line references short; choose the smallest useful range.
5. Provide an overall verdict: "correct" if there are no blocking structural issues, or "needs attention" if the change should be reworked before acceptance.
6. Ignore trivial style issues unless they obscure meaning or violate documented standards.
7. Do not generate a full fix; only flag issues and optionally provide short suggestion blocks.

## Approval Bar

Do not approve merely because behavior seems correct.
The bar for approval is:

- no clear structural regression
- no obvious missed opportunity to make the implementation dramatically simpler when such a path is visible
- no unjustified file-size explosion
- no obvious spaghetti growth from special-case branching
- no obviously hacky or magical abstraction that makes the code harder to reason about
- no unnecessary wrapper, cast, or optionality churn obscuring the real design
- no clear architecture-boundary leak or avoidable canonical-helper duplication
- no missed opportunity for an obvious decomposition that would materially improve maintainability

Treat these as presumptive blockers unless the author can justify them clearly:

- the change preserves a lot of incidental complexity when there is a plausible code-judo move that would delete it
- the change pushes a file from below 1000 lines to above 1000 lines
- the change adds ad-hoc branching that makes an existing flow more tangled
- the change solves a local problem by scattering feature checks across shared code
- the change adds an unnecessary abstraction, wrapper, or cast-heavy contract that makes the design more indirect
- the change duplicates an existing helper or puts logic in the wrong layer when there is a clear canonical home

If those conditions are not met, leave explicit, actionable feedback and push for a cleaner decomposition.`;
```

- [ ] **Step 3: Add the profile-to-rubric registry**

Immediately after `THERMO_NUCLEAR_RUBRIC`, insert:

```ts
const REVIEW_PROFILE_RUBRICS: Record<ReviewProfileId, string> = {
	standard: REVIEW_RUBRIC,
	"thermo-nuclear": THERMO_NUCLEAR_RUBRIC,
};
```

- [ ] **Step 4: Run pure tests to confirm no helper regression**

Run:

```bash
node --test --experimental-strip-types extensions/review/review-profile.test.ts extensions/review/review-compare.test.ts extensions/answer/answer-parser.test.ts
```

Expected: PASS for all tests. This task only adds extension prompt constants and imports, so these pure tests should remain green.

- [ ] **Step 5: Commit the rubric constants**

```bash
git add extensions/review/index.ts extensions/review/review-profile.ts extensions/review/review-profile.test.ts
git commit -m "feat(review): add thermo-nuclear review profile"
```

---

### Task 4: Wire `--profile` into direct `/review` parsing and execution

**Files:**
- Modify: `extensions/review/index.ts`
- Test: `extensions/review/review-profile.test.ts`

- [ ] **Step 1: Update `executeReview()` to accept a profile**

In `extensions/review/index.ts`, change the `executeReview()` options type from:

```ts
options?: { includeLocalChanges?: boolean; extraInstruction?: string },
```

to:

```ts
options?: { includeLocalChanges?: boolean; extraInstruction?: string; profile?: ReviewProfileId },
```

Then replace this prompt-construction line inside `executeReview()`:

```ts
let fullPrompt = `${REVIEW_RUBRIC}\n\n---\n\nPlease perform a code review with the following focus:\n\n${prompt}`;
```

with:

```ts
const profile = options?.profile ?? DEFAULT_REVIEW_PROFILE_ID;
const rubric = REVIEW_PROFILE_RUBRICS[profile];
let fullPrompt = `${rubric}\n\n---\n\nPlease perform a code review with the following focus:\n\n${prompt}`;
```

- [ ] **Step 2: Update parsed argument shape**

In `extensions/review/index.ts`, replace the `ParsedReviewArgs` type with:

```ts
type ParsedReviewArgs = {
	target: ReviewTarget | { type: "pr"; ref: string } | null;
	profile: ReviewProfileId;
	profileSpecified: boolean;
	extraInstruction?: string;
	error?: string;
};
```

- [ ] **Step 3: Replace `parseArgs()` with profile-aware parsing**

Replace the entire `parseArgs()` function with this version:

```ts
function parseArgs(args: string | undefined): ParsedReviewArgs {
	if (!args?.trim()) {
		return {
			target: null,
			profile: DEFAULT_REVIEW_PROFILE_ID,
			profileSpecified: false,
		};
	}

	const rawParts = tokenizeArgs(args.trim());
	const profileParse = parseReviewProfileOption(rawParts);
	if (profileParse.error) {
		return {
			target: null,
			profile: profileParse.profile,
			profileSpecified: profileParse.profileSpecified,
			error: profileParse.error,
		};
	}

	const parts: string[] = [];
	let extraInstruction: string | undefined;

	for (let i = 0; i < profileParse.parts.length; i++) {
		const part = profileParse.parts[i];
		if (part === "--extra") {
			const next = profileParse.parts[i + 1];
			if (!next) {
				return {
					target: null,
					profile: profileParse.profile,
					profileSpecified: profileParse.profileSpecified,
					error: "Missing value for --extra",
				};
			}
			extraInstruction = next;
			i += 1;
			continue;
		}

		if (part.startsWith("--extra=")) {
			extraInstruction = part.slice("--extra=".length);
			continue;
		}

		parts.push(part);
	}

	const baseResult = {
		profile: profileParse.profile,
		profileSpecified: profileParse.profileSpecified,
		extraInstruction,
	};

	if (parts.length === 0) {
		return { target: null, ...baseResult };
	}

	const subcommand = parts[0]?.toLowerCase();

	switch (subcommand) {
		case "uncommitted":
			return { target: { type: "uncommitted" }, ...baseResult };

		case "branch": {
			const branch = parts[1];
			if (!branch) return { target: null, ...baseResult };
			return { target: { type: "baseBranch", branch }, ...baseResult };
		}

		case "compare": {
			const parsed: CompareBranchesTarget | null = parseCompareBranchArgs(parts.slice(1));
			if (!parsed) return { target: null, ...baseResult };
			return {
				target: {
					type: "compareBranches",
					targetBranch: parsed.targetBranch,
					baseBranch: parsed.baseBranch || "",
				},
				...baseResult,
			};
		}

		case "commit": {
			const sha = parts[1];
			if (!sha) return { target: null, ...baseResult };
			const title = parts.slice(2).join(" ") || undefined;
			return { target: { type: "commit", sha, title }, ...baseResult };
		}

		case "folder": {
			const paths = parseReviewPaths(parts.slice(1).join(" "));
			if (paths.length === 0) return { target: null, ...baseResult };
			return { target: { type: "folder", paths }, ...baseResult };
		}

		case "pr": {
			const ref = parts[1];
			if (!ref) return { target: null, ...baseResult };
			return { target: { type: "pr", ref }, ...baseResult };
		}

		default:
			return { target: null, ...baseResult };
	}
}
```

- [ ] **Step 4: Add profile state in the command handler**

In the `/review` command handler, after this existing line:

```ts
let extraInstruction: string | undefined;
```

insert:

```ts
let profile: ReviewProfileId = DEFAULT_REVIEW_PROFILE_ID;
let profileSpecified = false;
```

Then after this existing line:

```ts
extraInstruction = parsed.extraInstruction?.trim() || undefined;
```

insert:

```ts
profile = parsed.profile;
profileSpecified = parsed.profileSpecified;
```

- [ ] **Step 5: Pass profile into loop-fixing reviews**

Change the `runLoopFixingReview()` signature from:

```ts
async function runLoopFixingReview(
	ctx: ExtensionCommandContext,
	target: ReviewTarget,
	extraInstruction?: string,
): Promise<void> {
```

to:

```ts
async function runLoopFixingReview(
	ctx: ExtensionCommandContext,
	target: ReviewTarget,
	profile: ReviewProfileId,
	extraInstruction?: string,
): Promise<void> {
```

Inside `runLoopFixingReview()`, update the `executeReview()` call from:

```ts
const started = await executeReview(ctx, target, true, {
	includeLocalChanges: true,
	extraInstruction,
});
```

to:

```ts
const started = await executeReview(ctx, target, true, {
	includeLocalChanges: true,
	extraInstruction,
	profile,
});
```

Then update the command handler call from:

```ts
await runLoopFixingReview(ctx, target, extraInstruction);
```

to:

```ts
await runLoopFixingReview(ctx, target, profile, extraInstruction);
```

- [ ] **Step 6: Pass profile into normal reviews**

Update the final `executeReview()` call in the command handler from:

```ts
await executeReview(ctx, target, useFreshSession, { extraInstruction });
```

to:

```ts
await executeReview(ctx, target, useFreshSession, { extraInstruction, profile });
```

- [ ] **Step 7: Run parser tests and existing tests**

Run:

```bash
node --test --experimental-strip-types extensions/review/review-profile.test.ts extensions/review/review-compare.test.ts extensions/answer/answer-parser.test.ts
```

Expected: PASS for all tests.

- [ ] **Step 8: Commit direct parser and execution wiring**

```bash
git add extensions/review/index.ts extensions/review/review-profile.ts extensions/review/review-profile.test.ts
git commit -m "feat(review): wire profile flag into reviews"
```

---

### Task 5: Add the interactive profile selector before target selection

**Files:**
- Modify: `extensions/review/index.ts`

- [ ] **Step 1: Add `showReviewProfileSelector()`**

In `extensions/review/index.ts`, inside `reviewExtension(pi)` and before `showReviewSelector()`, add this function:

```ts
async function showReviewProfileSelector(ctx: ExtensionContext): Promise<ReviewProfileId | null> {
	const items: SelectItem[] = REVIEW_PROFILE_OPTIONS.map((profile) => ({
		value: profile.id,
		label: profile.label,
		description: profile.description,
	}));

	return ctx.ui.custom<ReviewProfileId | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Select a review profile"))));

		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		selectList.onSelect = (item) => done(item.value as ReviewProfileId);
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to cancel")));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
```

- [ ] **Step 2: Call profile selector before target selector**

In the command handler `while (true)` block, replace this existing block:

```ts
if (!target && fromSelector) {
	target = await showReviewSelector(ctx);
}
```

with:

```ts
if (!target && fromSelector) {
	if (!profileSpecified) {
		const selectedProfile = await showReviewProfileSelector(ctx);
		if (!selectedProfile) {
			ctx.ui.notify("Review cancelled", "info");
			return;
		}
		profile = selectedProfile;
		profileSpecified = true;
	}

	target = await showReviewSelector(ctx);
}
```

This preserves direct `/review --profile thermo-nuclear` behavior: the profile is already specified, so the interactive flow skips the profile selector and proceeds to target selection.

- [ ] **Step 3: Include profile in the start notification**

Inside `executeReview()`, replace this line:

```ts
ctx.ui.notify(`Starting review: ${hint}${modeHint}`, "info");
```

with:

```ts
const profileLabel = REVIEW_PROFILE_OPTIONS.find((option) => option.id === profile)?.label ?? profile;
ctx.ui.notify(`Starting ${profileLabel}: ${hint}${modeHint}`, "info");
```

- [ ] **Step 4: Update top-of-file usage docs**

In the comment block at the top of `extensions/review/index.ts`, add these usage lines after the existing `--extra` usage line:

```ts
 * - `/review --profile thermo-nuclear` - choose the thermo-nuclear code-quality review profile
 * - `/review branch main --profile thermo-nuclear` - use a review profile with any target mode
```

Also add this supported-mode bullet near the top list:

```ts
 * - Selectable review profiles (standard or thermo-nuclear code quality)
```

- [ ] **Step 5: Run pure tests**

Run:

```bash
node --test --experimental-strip-types extensions/review/review-profile.test.ts extensions/review/review-compare.test.ts extensions/answer/answer-parser.test.ts
```

Expected: PASS for all tests.

- [ ] **Step 6: Run whitespace validation**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 7: Commit interactive profile selection**

```bash
git add extensions/review/index.ts
git commit -m "feat(review): select profile before review target"
```

---

### Task 6: Final verification and manual smoke check

**Files:**
- Verify: `extensions/review/index.ts`
- Verify: `extensions/review/review-profile.ts`
- Verify: `extensions/review/review-profile.test.ts`

- [ ] **Step 1: Run all repository tests currently present**

Run:

```bash
node --test --experimental-strip-types extensions/review/review-profile.test.ts extensions/review/review-compare.test.ts extensions/answer/answer-parser.test.ts
```

Expected: PASS for all tests. The `MODULE_TYPELESS_PACKAGE_JSON` warning is acceptable.

- [ ] **Step 2: Validate the diff has no whitespace errors**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 3: Inspect the final diff for accidental scope expansion**

Run:

```bash
git diff --stat HEAD~4..HEAD
git diff HEAD~4..HEAD -- extensions/review/index.ts extensions/review/review-profile.ts extensions/review/review-profile.test.ts
```

Expected:

- Only `extensions/review/index.ts`, `extensions/review/review-profile.ts`, and `extensions/review/review-profile.test.ts` contain implementation changes.
- No changes add a new review target.
- No changes add agent or subagent selection.
- `REVIEW_RUBRIC` and `THERMO_NUCLEAR_RUBRIC` are separate constants.
- Final prompt construction uses `REVIEW_PROFILE_RUBRICS[profile]`, not a concatenation of the two rubrics.

- [ ] **Step 4: Manual Pi smoke check after reload**

In an interactive Pi session for this repo, run:

```text
/reload
/review --profile thermo-nuclear
```

Expected:

- `/reload` completes without extension load errors.
- `/review --profile thermo-nuclear` skips the profile selector and opens the existing target selector.
- Cancelling the target selector reports `Review cancelled`.

Then run:

```text
/review
```

Expected:

- The first selector is `Select a review profile`.
- Choosing `Thermo-nuclear code quality review` opens the existing target selector.
- Cancelling the target selector reports `Review cancelled`.

- [ ] **Step 5: Final commit if manual smoke check required code changes**

If Step 4 revealed a small wiring issue and you fixed it, commit only those fixes:

```bash
git add extensions/review/index.ts extensions/review/review-profile.ts extensions/review/review-profile.test.ts
git commit -m "fix(review): stabilize profile selection"
```

If Step 4 passed without code changes, no final commit is needed because each implementation task already committed its changes.
