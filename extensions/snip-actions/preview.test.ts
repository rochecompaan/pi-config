import test from "node:test";
import assert from "node:assert/strict";
import type { CopyItem } from "./copy-items.ts";

const copyItems: CopyItem[] = [
	{
		id: "message",
		kind: "message",
		content: "Complete assistant message",
		messageId: "m1",
		sourceLabel: "10:00:00",
		sourcePosition: -1,
	},
	{
		id: "quote",
		kind: "quote",
		content: "First line\nSecond line",
		messageId: "m1",
		sourceLabel: "10:00:00",
		sourcePosition: 10,
	},
	{
		id: "code",
		kind: "code",
		content: "const answer = 42;",
		messageId: "m1",
		sourceLabel: "10:00:00",
		sourcePosition: 40,
		language: "typescript",
	},
];

test("builds a preview for the selected snippet", async () => {
	const previewModule = await import("./preview.ts").catch(() => undefined);
	assert.ok(previewModule, "the preview model must exist");

	assert.deepEqual(previewModule.buildCopyItemPreview(copyItems, "1"), {
		title: "Preview — quote",
		content: "First line\nSecond line",
		item: copyItems[1],
	});
	assert.deepEqual(previewModule.buildCopyItemPreview(copyItems, "2"), {
		title: "Preview — code (typescript)",
		content: "const answer = 42;",
		item: copyItems[2],
	});
});

test("builds an empty preview when filtering removes every option", async () => {
	const previewModule = await import("./preview.ts").catch(() => undefined);
	assert.ok(previewModule, "the preview model must exist");

	assert.deepEqual(previewModule.buildCopyItemPreview(copyItems, undefined), {
		title: "Preview",
		content: "No matching item.",
	});
});

test("limits the rendered preview height", async () => {
	const previewModule = await import("./preview.ts");
	assert.equal(typeof previewModule.limitPreviewLines, "function");
	assert.deepEqual(
		previewModule.limitPreviewLines(["one", "two", "three", "four"], 3),
		["one", "two", "…"],
	);
	assert.deepEqual(previewModule.limitPreviewLines(["one", "two"], 3), ["one", "two"]);
});
