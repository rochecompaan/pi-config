# Review Findings Todo Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `/end-review` option that returns from a review branch and creates one aggregate file-based todo containing the full review findings summary without triggering a follow-up agent turn.

**Architecture:** Keep review command wiring in `extensions/review/index.ts`, but move todo-file creation and summary parsing into a focused `extensions/review/review-todo.ts` module. The helper mirrors the existing file-based todo format from `extensions/todos.ts` and exposes narrow functions for directory resolution, title derivation, summary extraction, serialization, and todo creation.

**Tech Stack:** TypeScript, Pi extension APIs, Node.js `fs/promises`, `path`, `crypto`, `node:test`.

## Global Constraints

- Create one aggregate todo containing the full review summary, not one todo per finding.
- Do not send a follow-up user message or ask the agent to fix findings for the new option.
- Store todos under `.pi/todos` unless `PI_TODO_PATH` is set, matching `extensions/todos.ts` behavior.
- Use JSON front matter followed by markdown body, matching `extensions/todos.ts` serialization style.
- Preserve existing `/end-review` behavior for `Return only`, `Return and fix findings`, `Return and summarize`, and loop fixing.
- Keep `extensions/review/index.ts` changes small because it is already large; add focused code to `extensions/review/review-todo.ts`.

---

## File Structure

- Create `extensions/review/review-todo.ts`
  - Responsibility: create review-findings todos and provide pure helpers for title derivation, summary extraction, directory resolution, and serialization.
- Create `extensions/review/review-todo.test.ts`
  - Responsibility: prove the helper behavior that can regress meaningfully without relying on Pi TUI/session runtime.
- Modify `extensions/review/index.ts`
  - Responsibility: add the `/end-review` choice and call the helper after summary navigation succeeds.

---

### Task 1: Review todo helper and tests

**Files:**
- Create: `extensions/review/review-todo.ts`
- Create: `extensions/review/review-todo.test.ts`

**Interfaces:**
- Consumes: `ctx.cwd` from `ExtensionCommandContext` and the branch summary returned by `ctx.navigateTree(..., { summarize: true })`.
- Produces:
  - `getReviewTodosDir(cwd: string, env?: NodeJS.ProcessEnv): string`
  - `deriveReviewTodoTitle(summary: string): string`
  - `getReviewSummaryText(result: unknown): string | null`
  - `serializeReviewTodo(todo: ReviewTodoRecord): string`
  - `createReviewFindingsTodo(cwd: string, summary: string, options?: CreateReviewFindingsTodoOptions): Promise<CreatedReviewTodo>`

- [ ] **Step 1: Write the failing helper tests**

Create `extensions/review/review-todo.test.ts` with this content:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createReviewFindingsTodo,
	deriveReviewTodoTitle,
	getReviewSummaryText,
	getReviewTodosDir,
	serializeReviewTodo,
} from "./review-todo.ts";

const SUMMARY = `## Review Scope
- extensions/review/index.ts end-review flow

## Verdict
- needs attention

## Findings
- [P1] Missing todo output mode
  - File location: extensions/review/index.ts:2450
  - Why it matters: findings are lost after returning.
  - What should change: add an aggregate todo option.

## Fix Queue
1. Add helper.
2. Wire /end-review.
`;

test("deriveReviewTodoTitle uses the review scope when present", () => {
	assert.equal(
		deriveReviewTodoTitle(SUMMARY),
		"Review findings: extensions/review/index.ts end-review flow",
	);
});

test("deriveReviewTodoTitle falls back when review scope is missing", () => {
	assert.equal(deriveReviewTodoTitle("## Findings\n- [P1] Issue"), "Review findings");
});

test("getReviewSummaryText reads summaryEntry.summary from navigateTree results", () => {
	assert.equal(
		getReviewSummaryText({ cancelled: false, summaryEntry: { summary: SUMMARY } }),
		SUMMARY.trim(),
	);
	assert.equal(getReviewSummaryText({ cancelled: false }), null);
	assert.equal(getReviewSummaryText({ cancelled: false, summaryEntry: { summary: "   " } }), null);
});

test("getReviewTodosDir honors PI_TODO_PATH relative to cwd", () => {
	const cwd = path.resolve("/tmp/example-project");
	assert.equal(getReviewTodosDir(cwd, {}), path.join(cwd, ".pi/todos"));
	assert.equal(getReviewTodosDir(cwd, { PI_TODO_PATH: "custom/todos" }), path.join(cwd, "custom/todos"));
});

test("serializeReviewTodo writes JSON front matter and markdown body", () => {
	const serialized = serializeReviewTodo({
		id: "deadbeef",
		title: "Review findings: demo",
		tags: ["review", "findings"],
		status: "open",
		created_at: "2026-07-04T00:00:00.000Z",
		body: "## Findings\n- [P1] Demo\n",
	});

	assert.equal(
		serialized,
		`{
  "id": "deadbeef",
  "title": "Review findings: demo",
  "tags": [
    "review",
    "findings"
  ],
  "status": "open",
  "created_at": "2026-07-04T00:00:00.000Z"
}

## Findings
- [P1] Demo
`,
	);
});

test("createReviewFindingsTodo creates one aggregate todo file", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "review-todo-"));
	const created = await createReviewFindingsTodo(cwd, SUMMARY, {
		env: {},
		now: new Date("2026-07-04T00:00:00.000Z"),
		idFactory: () => "deadbeef",
	});

	assert.equal(created.id, "deadbeef");
	assert.equal(created.displayId, "TODO-deadbeef");
	assert.equal(created.title, "Review findings: extensions/review/index.ts end-review flow");
	assert.deepEqual(created.tags, ["review", "findings"]);
	assert.equal(created.status, "open");

	const raw = await fs.readFile(path.join(cwd, ".pi/todos/deadbeef.md"), "utf8");
	assert.match(raw, /"title": "Review findings: extensions\/review\/index\.ts end-review flow"/);
	assert.match(raw, /"tags": \[\n    "review",\n    "findings"\n  \]/);
	assert.match(raw, /## Findings\n- \[P1\] Missing todo output mode/);
	assert.equal(raw, await fs.readFile(created.path, "utf8"));
});

test("createReviewFindingsTodo rejects empty summaries", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "review-todo-empty-"));
	await assert.rejects(
		() => createReviewFindingsTodo(cwd, "   ", { env: {}, idFactory: () => "deadbeef" }),
		/Cannot create review findings todo without summary text/,
	);
});
```

- [ ] **Step 2: Run the helper tests to verify they fail**

Run:

```bash
node --test extensions/review/review-todo.test.ts
```

Expected: FAIL with an import error like `Cannot find module './review-todo.ts'` because the helper does not exist yet.

- [ ] **Step 3: Implement the helper module**

Create `extensions/review/review-todo.ts` with this content:

```ts
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

const TODO_DIR_NAME = ".pi/todos";
const TODO_PATH_ENV = "PI_TODO_PATH";
const REVIEW_TODO_TAGS = ["review", "findings"] as const;
const DEFAULT_REVIEW_TODO_TITLE = "Review findings";
const MAX_TITLE_LENGTH = 96;

type NavigateTreeSummaryResult = {
	summaryEntry?: {
		summary?: unknown;
	};
};

export type ReviewTodoRecord = {
	id: string;
	title: string;
	tags: string[];
	status: string;
	created_at: string;
	body: string;
};

export type CreatedReviewTodo = ReviewTodoRecord & {
	path: string;
	displayId: string;
};

export type CreateReviewFindingsTodoOptions = {
	env?: NodeJS.ProcessEnv;
	now?: Date;
	idFactory?: () => string;
};

export function getReviewTodosDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const overridePath = env[TODO_PATH_ENV];
	if (overridePath?.trim()) {
		return path.resolve(cwd, overridePath.trim());
	}

	return path.resolve(cwd, TODO_DIR_NAME);
}

function getSectionLines(markdown: string, expectedTitle: string): string[] {
	const lines = markdown.split(/\r?\n/);
	const sectionLines: string[] = [];
	let inSection = false;
	let sectionLevel = 0;

	for (const line of lines) {
		const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
		if (heading) {
			const level = heading[1].length;
			const title = heading[2].trim().toLowerCase();
			if (inSection && level <= sectionLevel) {
				break;
			}
			if (title === expectedTitle.toLowerCase()) {
				inSection = true;
				sectionLevel = level;
				continue;
			}
		}

		if (inSection) {
			sectionLines.push(line);
		}
	}

	return sectionLines;
}

function normalizeScopeLine(line: string): string {
	return line
		.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
		.replace(/^\*\*(.+?)\*\*:\s*/, "$1: ")
		.replace(/^(?:what was reviewed|review scope|scope):\s*/i, "")
		.trim();
}

function truncateTitle(value: string): string {
	if (value.length <= MAX_TITLE_LENGTH) return value;
	return `${value.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

function extractReviewScope(summary: string): string | null {
	for (const line of getSectionLines(summary, "Review Scope")) {
		const normalized = normalizeScopeLine(line);
		if (!normalized || normalized === "(none)") continue;
		return normalized;
	}

	return null;
}

export function deriveReviewTodoTitle(summary: string): string {
	const scope = extractReviewScope(summary);
	if (!scope) return DEFAULT_REVIEW_TODO_TITLE;
	return `${DEFAULT_REVIEW_TODO_TITLE}: ${truncateTitle(scope)}`;
}

export function getReviewSummaryText(result: unknown): string | null {
	const summary = (result as NavigateTreeSummaryResult | null | undefined)?.summaryEntry?.summary;
	if (typeof summary !== "string") return null;
	const trimmed = summary.trim();
	return trimmed || null;
}

export function serializeReviewTodo(todo: ReviewTodoRecord): string {
	const frontMatter = JSON.stringify(
		{
			id: todo.id,
			title: todo.title,
			tags: todo.tags ?? [],
			status: todo.status,
			created_at: todo.created_at,
			assigned_to_session: undefined,
		},
		null,
		2,
	);

	const body = todo.body.replace(/^\n+/, "").replace(/\s+$/, "");
	if (!body) return `${frontMatter}\n`;
	return `${frontMatter}\n\n${body}\n`;
}

function getTodoPath(todosDir: string, id: string): string {
	return path.join(todosDir, `${id}.md`);
}

function createId(idFactory?: () => string): string {
	return idFactory ? idFactory() : crypto.randomBytes(4).toString("hex");
}

export async function createReviewFindingsTodo(
	cwd: string,
	summary: string,
	options: CreateReviewFindingsTodoOptions = {},
): Promise<CreatedReviewTodo> {
	const body = summary.trim();
	if (!body) {
		throw new Error("Cannot create review findings todo without summary text.");
	}

	const todosDir = getReviewTodosDir(cwd, options.env);
	await fs.mkdir(todosDir, { recursive: true });

	for (let attempt = 0; attempt < 10; attempt += 1) {
		const id = createId(options.idFactory);
		const filePath = getTodoPath(todosDir, id);
		if (existsSync(filePath)) continue;

		const todo: ReviewTodoRecord = {
			id,
			title: deriveReviewTodoTitle(body),
			tags: [...REVIEW_TODO_TAGS],
			status: "open",
			created_at: (options.now ?? new Date()).toISOString(),
			body,
		};

		try {
			await fs.writeFile(filePath, serializeReviewTodo(todo), { encoding: "utf8", flag: "wx" });
			return { ...todo, path: filePath, displayId: `TODO-${id}` };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
	}

	throw new Error("Failed to generate unique review findings todo id.");
}
```

- [ ] **Step 4: Run the helper tests to verify they pass**

Run:

```bash
node --test extensions/review/review-todo.test.ts
```

Expected: PASS for all tests in `review-todo.test.ts`.

- [ ] **Step 5: Commit the helper and tests**

Run:

```bash
git add extensions/review/review-todo.ts extensions/review/review-todo.test.ts
git commit -m "feat(review): add findings todo helper"
```

---

### Task 2: Wire `/end-review` to create an aggregate todo

**Files:**
- Modify: `extensions/review/index.ts`
- Test: `extensions/review/review-todo.test.ts`
- Test existing: `extensions/review/review-compare.test.ts`, `extensions/review/review-profile.test.ts`

**Interfaces:**
- Consumes:
  - `createReviewFindingsTodo(cwd: string, summary: string): Promise<CreatedReviewTodo>` from Task 1.
  - `getReviewSummaryText(result: unknown): string | null` from Task 1.
  - Existing `navigateWithSummary(ctx, originId, showLoader)` flow in `extensions/review/index.ts`.
- Produces:
  - New end-review action value: `"returnAndTodo"`.
  - New UI choice text: `"Return and add findings to todo"`.

- [ ] **Step 1: Import the helper**

In `extensions/review/index.ts`, add this import beside the other local review imports:

```ts
import {
	createReviewFindingsTodo,
	getReviewSummaryText,
} from "./review-todo.ts";
```

- [ ] **Step 2: Preserve summary text from navigation results**

Find the existing end-review type block:

```ts
	type EndReviewAction = "returnOnly" | "returnAndFix" | "returnAndSummarize";
	type EndReviewActionResult = "ok" | "cancelled" | "error";
	type EndReviewActionOptions = {
		showSummaryLoader?: boolean;
		notifySuccess?: boolean;
	};
```

Replace it with:

```ts
	type EndReviewAction = "returnOnly" | "returnAndFix" | "returnAndSummarize" | "returnAndTodo";
	type EndReviewActionResult = "ok" | "cancelled" | "error";
	type EndReviewActionOptions = {
		showSummaryLoader?: boolean;
		notifySuccess?: boolean;
	};
	type NavigateWithSummaryResult = {
		cancelled: boolean;
		error?: string;
		summaryEntry?: {
			summary?: string;
		};
	};
```

Then change the `navigateWithSummary(...)` return type from:

```ts
	): Promise<{ cancelled: boolean; error?: string } | null> {
```

to:

```ts
	): Promise<NavigateWithSummaryResult | null> {
```

Inside the loader path, change the successful navigation handler from:

```ts
				ctx.navigateTree(originId, {
					summarize: true,
					customInstructions: REVIEW_SUMMARY_PROMPT,
					replaceInstructions: true,
				})
					.then(done)
					.catch((err) => done({ cancelled: false, error: err instanceof Error ? err.message : String(err) }));
```

to:

```ts
				ctx.navigateTree(originId, {
					summarize: true,
					customInstructions: REVIEW_SUMMARY_PROMPT,
					replaceInstructions: true,
				})
					.then((result) => done(result as NavigateWithSummaryResult))
					.catch((err) => done({ cancelled: false, error: err instanceof Error ? err.message : String(err) }));
```

Inside the non-loader path, change:

```ts
			return await ctx.navigateTree(originId, {
				summarize: true,
				customInstructions: REVIEW_SUMMARY_PROMPT,
				replaceInstructions: true,
			});
```

to:

```ts
			const result = await ctx.navigateTree(originId, {
				summarize: true,
				customInstructions: REVIEW_SUMMARY_PROMPT,
				replaceInstructions: true,
			});
			return result as NavigateWithSummaryResult;
```

- [ ] **Step 3: Add the todo action after summary navigation succeeds**

In `executeEndReviewAction(...)`, find this block after successful summary navigation:

```ts
		clearReviewState(ctx);

		if (action === "returnAndSummarize") {
			if (!ctx.ui.getEditorText().trim()) {
				ctx.ui.setEditorText("Act on the review findings");
			}
			if (notifySuccess) {
				ctx.ui.notify("Review complete! Returned and summarized.", "info");
			}
			return "ok";
		}

		pi.sendUserMessage(REVIEW_FIX_FINDINGS_PROMPT, { deliverAs: "followUp" });
		if (notifySuccess) {
			ctx.ui.notify("Review complete! Returned and queued a follow-up to fix findings.", "info");
		}
		return "ok";
```

Replace it with:

```ts
		if (action === "returnAndTodo") {
			const summaryText = getReviewSummaryText(summaryResult);
			if (!summaryText) {
				ctx.ui.notify(
					"Review summary did not contain text; todo was not created. Use /end-review to try again.",
					"error",
				);
				return "error";
			}

			try {
				const todo = await createReviewFindingsTodo(ctx.cwd, summaryText);
				clearReviewState(ctx);
				if (notifySuccess) {
					ctx.ui.notify(`Review complete! Created ${todo.displayId} with review findings.`, "info");
				}
				return "ok";
			} catch (error) {
				ctx.ui.notify(
					`Failed to create review findings todo: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return "error";
			}
		}

		clearReviewState(ctx);

		if (action === "returnAndSummarize") {
			if (!ctx.ui.getEditorText().trim()) {
				ctx.ui.setEditorText("Act on the review findings");
			}
			if (notifySuccess) {
				ctx.ui.notify("Review complete! Returned and summarized.", "info");
			}
			return "ok";
		}

		pi.sendUserMessage(REVIEW_FIX_FINDINGS_PROMPT, { deliverAs: "followUp" });
		if (notifySuccess) {
			ctx.ui.notify("Review complete! Returned and queued a follow-up to fix findings.", "info");
		}
		return "ok";
```

This keeps review state active if summary text is missing or todo creation fails, while avoiding any `pi.sendUserMessage(...)` call for the todo mode.

- [ ] **Step 4: Add the new selector choice and mapping**

In `runEndReview(...)`, replace the choice list:

```ts
			const choice = await ctx.ui.select("Finish review:", [
				"Return only",
				"Return and fix findings",
				"Return and summarize",
			]);
```

with:

```ts
			const choice = await ctx.ui.select("Finish review:", [
				"Return only",
				"Return and fix findings",
				"Return and summarize",
				"Return and add findings to todo",
			]);
```

Then replace the action mapping:

```ts
			const action: EndReviewAction =
				choice === "Return and fix findings"
					? "returnAndFix"
					: choice === "Return and summarize"
						? "returnAndSummarize"
						: "returnOnly";
```

with:

```ts
			const action: EndReviewAction =
				choice === "Return and fix findings"
					? "returnAndFix"
					: choice === "Return and summarize"
						? "returnAndSummarize"
						: choice === "Return and add findings to todo"
							? "returnAndTodo"
							: "returnOnly";
```

- [ ] **Step 5: Run review extension tests**

Run:

```bash
node --test extensions/review/*.test.ts
```

Expected: PASS for `review-compare.test.ts`, `review-profile.test.ts`, and `review-todo.test.ts`. The existing `MODULE_TYPELESS_PACKAGE_JSON` warning may appear and is not caused by this change.

- [ ] **Step 6: Run direct diff verification**

Run:

```bash
git diff --check
rg -n "Return and add findings to todo|returnAndTodo|createReviewFindingsTodo|getReviewSummaryText|sendUserMessage" extensions/review/index.ts extensions/review/review-todo.ts
```

Expected:
- `git diff --check` prints no whitespace errors.
- The `rg` output shows the new choice, action, helper import/use, and confirms that the todo action path does not add a new `sendUserMessage(...)` call.

- [ ] **Step 7: Commit the command wiring**

Run:

```bash
git add extensions/review/index.ts
git commit -m "feat(review): add findings todo end action"
```

---

### Task 3: Final verification and handoff

**Files:**
- Verify: `docs/specs/2026-07-04-review-findings-todo-design.md`
- Verify: `docs/plans/2026-07-04-review-findings-todo.md`
- Verify: `extensions/review/index.ts`
- Verify: `extensions/review/review-todo.ts`
- Verify: `extensions/review/review-todo.test.ts`

**Interfaces:**
- Consumes: completed Tasks 1 and 2.
- Produces: final evidence that the implementation matches the approved spec.

- [ ] **Step 1: Run the full relevant test suite**

Run:

```bash
node --test extensions/review/*.test.ts
```

Expected: all review extension tests pass.

- [ ] **Step 2: Verify spec coverage directly**

Run:

```bash
rg -n "one aggregate todo|Return and add findings to todo|PI_TODO_PATH|sendUserMessage|createReviewFindingsTodo" docs/specs/2026-07-04-review-findings-todo-design.md extensions/review/index.ts extensions/review/review-todo.ts
```

Expected:
- The spec still states one aggregate todo.
- `index.ts` includes `Return and add findings to todo` and `returnAndTodo`.
- `review-todo.ts` includes `PI_TODO_PATH` and `createReviewFindingsTodo`.
- The only `sendUserMessage` usage in the end-review completion path remains the existing `returnAndFix` path.

- [ ] **Step 3: Check repository status**

Run:

```bash
git status --short
```

Expected: only intentional committed changes are present. If the working tree is dirty, inspect with `git diff` and either commit intentional changes or revert accidental ones.

- [ ] **Step 4: Commit any final verification-only adjustments**

If Task 3 required small fixes, commit them:

```bash
git add extensions/review/index.ts extensions/review/review-todo.ts extensions/review/review-todo.test.ts
git commit -m "fix(review): polish findings todo output"
```

If Task 3 required no changes, do not create an empty commit.
