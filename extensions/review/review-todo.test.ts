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

test("getReviewSummaryText reads the persisted branch summary when navigateTree omits it", () => {
	assert.equal(
		getReviewSummaryText(
			{ cancelled: false },
			{
				type: "branch_summary",
				id: "summary-entry",
				parentId: "origin-entry",
				timestamp: "2026-08-22T11:19:43.358Z",
				fromId: "review-leaf",
				summary: SUMMARY,
				details: {},
				usage: {
					input: 100,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 120,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
				},
				fromHook: false,
			},
		),
		SUMMARY.trim(),
	);
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
