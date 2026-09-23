import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryItem } from "./history.ts";
import { HistoryNavigator, HistoryNavigatorError, type HistoryReference } from "./navigator.ts";

function userItem(id: string, sequence: number, text: string): HistoryItem {
	return {
		id,
		kind: "user",
		sequence,
		timestamp: `2026-09-21T00:00:${String(sequence).padStart(2, "0")}.000Z`,
		userMessage: { role: "user", content: text, timestamp: sequence } as any,
	};
}

function turnItem(
	id: string,
	sequence: number,
	text: string,
	tools: string[],
	files: string[],
	failed: boolean,
): HistoryItem {
	return {
		id,
		kind: "modelTurn",
		sequence,
		timestamp: `2026-09-21T00:01:${String(sequence).padStart(2, "0")}.000Z`,
		assistantMessage: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
			timestamp: sequence,
		} as any,
		toolResults: [],
		metadata: { tools, files, failed },
	};
}

const ids = (references: HistoryReference[]) => references.map((reference) => reference.historyId);

test("search returns compact exact-loadable references", () => {
	const items = [
		userItem("user-1", 0, "Please find the needle"),
		turnItem("turn-2", 1, "needle ".repeat(40), ["read"], ["src/a.ts"], false),
	];
	const navigator = new HistoryNavigator(items);

	const references = navigator.search({
		query: "needle",
		files: ["src/a.ts"],
		tools: ["read"],
		failed: false,
		limit: 5,
	});

	assert.equal(references[0].historyId, "turn-2");
	assert.ok(references[0].preview.length <= 160);
	assert.deepEqual(
		navigator.load(["turn-2", "user-1"]).map((item) => item.id),
		["turn-2", "user-1"],
	);
});

test("search is case-insensitive, ranks content, tool names, and file-like arguments, and applies all filters", () => {
	const content = turnItem("content", 0, "needle needle", [], [], false);
	const toolAndFile = turnItem("tool-and-file", 1, "other", ["read"], ["src/nested/needle.ts"], true);
	if (toolAndFile.kind === "modelTurn") {
		toolAndFile.assistantMessage.content = [
			{ type: "text", text: "other" },
			{ type: "toolCall", id: "call-1", name: "needle-tool", arguments: { path: "src/needle.ts" } },
		] as any;
		toolAndFile.toolResults = [
			{ role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "needle result" }] },
		] as any;
	}
	const navigator = new HistoryNavigator([content, toolAndFile]);

	assert.deepEqual(ids(navigator.search({ query: "NEEDLE" })), ["content", "tool-and-file"]);
	for (const query of ["needle-tool", "src/needle.ts", "nested", "result"]) {
		assert.deepEqual(ids(navigator.search({ query })), ["tool-and-file"], query);
	}
	assert.deepEqual(
		ids(navigator.search({ query: "needle", files: ["src/nested/needle.ts"], tools: ["read"], failed: true })),
		["tool-and-file"],
	);
	assert.deepEqual(
		ids(navigator.search({ query: "needle", files: ["src/nested/needle.ts"], tools: ["read"], failed: false })),
		[],
	);
});

test("search handles Unicode terms and never treats tokenless input as a match-all query", () => {
	const navigator = new HistoryNavigator([
		userItem("unicode", 0, "请分页显示历史记录"),
		userItem("ascii", 1, "unrelated history"),
	]);

	assert.deepEqual(ids(navigator.search({ query: "分页" })), ["unicode"]);
	for (const query of ["!!!", " ", "\t"]) {
		assert.deepEqual(ids(navigator.search({ query })), [], JSON.stringify(query));
	}
});

test("browse follows the anchored, unanchored, stride, and boundary matrix", () => {
	const navigator = new HistoryNavigator(Array.from({ length: 5 }, (_, sequence) => userItem(`h${sequence}`, sequence, `item ${sequence}`)));

	assert.deepEqual(ids(navigator.browse({ direction: "backward", count: 2 })), ["h4", "h3"]);
	assert.deepEqual(ids(navigator.browse({ direction: "forward", count: 2 })), ["h0", "h1"]);
	assert.deepEqual(ids(navigator.browse({ direction: "around", count: 3 })), ["h2", "h3", "h4"]);
	assert.deepEqual(ids(navigator.browse({ historyId: "h2", direction: "backward", count: 2 })), ["h1", "h0"]);
	assert.deepEqual(ids(navigator.browse({ sequence: 2, direction: "forward", count: 2 })), ["h3", "h4"]);
	assert.deepEqual(ids(navigator.browse({ historyId: "h2", direction: "around", count: 3 })), ["h1", "h2", "h3"]);
	assert.deepEqual(ids(navigator.browse({ historyId: "h4", direction: "backward", count: 2, stride: 2 })), ["h2", "h0"]);
	assert.deepEqual(ids(navigator.browse({ historyId: "h2", direction: "around", count: 3, stride: 2 })), ["h0", "h2", "h4"]);
});

test("browse handles empty unanchored history and rejects invalid anchors", () => {
	const empty = new HistoryNavigator([]);
	for (const direction of ["backward", "forward", "around"] as const) {
		assert.deepEqual(empty.browse({ direction }), []);
	}

	const navigator = new HistoryNavigator([userItem("h0", 0, "item")]);
	for (const input of [
		{ historyId: "missing", direction: "around" as const },
		{ sequence: 99, direction: "around" as const },
		{ historyId: "h0", sequence: 0, direction: "around" as const },
	]) {
		assert.throws(
			() => navigator.browse(input),
			(error: unknown) => error instanceof HistoryNavigatorError && error.code === "UNKNOWN_HISTORY_ANCHOR",
		);
	}
});

test("load is atomic and paging-tool turns never appear in navigator results", () => {
	const navigator = new HistoryNavigator([
		userItem("user-1", 0, "request"),
		turnItem("paging", 1, "private paging marker", ["read_context_output"], [], false),
		turnItem("turn-2", 2, "normal marker", ["read"], ["src/a.ts"], false),
	]);

	assert.deepEqual(ids(navigator.search({ query: "marker" })), ["turn-2"]);
	assert.deepEqual(ids(navigator.browse({ direction: "forward", count: 10 })), ["user-1", "turn-2"]);
	assert.throws(
		() => navigator.load(["turn-2", "paging"]),
		(error: unknown) => error instanceof HistoryNavigatorError && error.code === "UNKNOWN_HISTORY_ID",
	);
});

test("references use adjacent visible IDs and rebuild replaces the old branch index", () => {
	const navigator = new HistoryNavigator([
		userItem("old-1", 0, "first"),
		turnItem("paging", 1, "hidden", ["browse_history"], [], false),
		userItem("old-2", 2, "second"),
	]);

	assert.deepEqual(
		navigator.browse({ direction: "forward", count: 2 }).map((reference) => [
			reference.historyId,
			reference.previousHistoryId,
			reference.nextHistoryId,
		]),
		[["old-1", null, "old-2"], ["old-2", "old-1", null]],
	);

	navigator.rebuild([userItem("new-1", 0, "replacement")]);
	assert.deepEqual(ids(navigator.search({ query: "replacement" })), ["new-1"]);
	assert.throws(
		() => navigator.load(["old-1"]),
		(error: unknown) => error instanceof HistoryNavigatorError && error.code === "UNKNOWN_HISTORY_ID",
	);
});

test("navigator validates bounded inputs", () => {
	const navigator = new HistoryNavigator([userItem("h0", 0, "item")]);
	for (const action of [
		() => navigator.search({ query: "x".repeat(201) }),
		() => navigator.search({ query: "", files: Array(11).fill("a") }),
		() => navigator.search({ query: "", tools: ["x".repeat(201)] }),
		() => navigator.search({ query: "", limit: 0 }),
		() => navigator.browse({ direction: "forward", count: 11 }),
		() => navigator.browse({ direction: "forward", stride: 0 }),
		() => navigator.browse({ historyId: "x".repeat(129), direction: "forward" }),
		() => navigator.browse({ sequence: 1.5, direction: "forward" }),
		() => navigator.load([]),
		() => navigator.load(["h0", "h0", "h0", "h0"]),
		() => navigator.load(["x".repeat(129)]),
	]) {
		assert.throws(action, HistoryNavigatorError);
	}
});
