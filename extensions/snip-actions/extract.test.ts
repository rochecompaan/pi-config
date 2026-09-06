import test from "node:test";
import assert from "node:assert/strict";
import { extractCopyItems } from "./extract.ts";

test("extracts fenced and every inline code item in source order", () => {
	assert.deepEqual(
		extractCopyItems("Use `main`, then:\n```ts\nconst answer = 42;\n```\nRun `git status`."),
		[
			{ kind: "inline", content: "main", sourcePosition: 4 },
			{
				kind: "code",
				content: "const answer = 42;",
				language: "ts",
				sourcePosition: 18,
			},
			{ kind: "inline", content: "git status", sourcePosition: 51 },
		],
	);
});

test("ignores multi-backtick spans while preserving single-backtick positions", () => {
	assert.deepEqual(
		extractCopyItems("Use ``a ` character`` then `valid`."),
		[{ kind: "inline", content: "valid", sourcePosition: 27 }],
	);
});

test("does not extract inline or pipe items inside fenced code", () => {
	const items = extractCopyItems("```text\n`hidden`\n| hidden\n```\n`visible`\n| shown");
	assert.deepEqual(items.map(({ kind, content }) => ({ kind, content })), [
		{ kind: "code", content: "`hidden`\n| hidden" },
		{ kind: "inline", content: "visible" },
		{ kind: "pipe-message", content: "shown" },
	]);
});

test("groups consecutive pipe lines and removes newlines without replacement", () => {
	const items = extractCopyItems("Intro\n| Hello,\n| world\nBreak\n| Again");
	assert.deepEqual(
		items.filter((item) => item.kind === "pipe-message").map((item) => item.content),
		["Hello,world", "Again"],
	);
});

test("requires an exact pipe-space prefix and preserves remaining spaces", () => {
	const items = extractCopyItems(" | indented\n|missing-space\n|  kept \n| ");
	assert.deepEqual(
		items.filter((item) => item.kind === "pipe-message").map((item) => item.content),
		[" kept "],
	);
});

test("skips empty fenced and pipe items", () => {
	assert.deepEqual(extractCopyItems("```\n\n```\n| "), []);
});
