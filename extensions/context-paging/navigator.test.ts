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

const ids = (value: HistoryReference[]) => value.map((reference) => reference.historyId);

test("search ranks matching stored content and applies every supplied filter", () => {
	const navigator = new HistoryNavigator([
		userItem("u1", 0, "Parser discussion"),
		turnItem("m1", 1, "parser parser", ["read"], ["src/parser.ts"], false),
		turnItem("m2", 2, "parser failure", ["bash"], ["src/parser.ts"], true),
	]);

	assert.deepEqual(
		navigator.search({
			query: "PARSER",
			files: ["src/parser.ts"],
			tools: ["bash"],
			failed: true,
			limit: 5,
		}).map((reference) => reference.historyId),
		["m2"],
	);
	const relevance = new HistoryNavigator([
		userItem("lower", 0, "needle filler filler"),
		userItem("higher", 1, "needle needle filler"),
	]);
	assert.deepEqual(ids(relevance.search({ query: "NEEDLE" })), ["higher", "lower"]);

	const ties = new HistoryNavigator([
		userItem("older", 0, "same match"),
		userItem("newer", 1, "same match"),
	]);
	assert.deepEqual(ids(ties.search({ query: "MATCH" })), ["older", "newer"]);
});

test("search indexes assistant content, calls, results, and file path segments", () => {
	const item = turnItem("m1", 0, "assistant marker", ["lookup"], ["src/nested/file.ts"], false);
	if (item.kind === "modelTurn") {
		item.assistantMessage.content = [
			{ type: "text", text: "assistant marker" },
			{ type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "argument-marker" } },
		] as any;
		item.toolResults = [{ role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "result-marker" }] }] as any;
	}
	const navigator = new HistoryNavigator([item]);
	for (const query of ["ASSISTANT", "lookup", "argument-marker", "result-marker", "nested"]) {
		assert.deepEqual(ids(navigator.search({ query })), ["m1"], query);
	}
});

test("references have compact previews and only visible adjacent IDs", () => {
	const navigator = new HistoryNavigator([
		userItem("u1", 0, "  first\n\trequest  "),
		turnItem("paging", 1, "hidden", ["read_context_output"], [], false),
		userItem("u2", 2, ` ${"word ".repeat(40)} `),
	]);

	const [first, second] = navigator.browse({ direction: "forward", count: 2 });
	assert.equal(first.preview, "first request");
	assert.equal(first.previousHistoryId, undefined);
	assert.equal(first.nextHistoryId, "u2");
	assert.equal(second.previousHistoryId, "u1");
	assert.equal(second.nextHistoryId, undefined);
	assert.equal(second.preview.includes("\n"), false);
	assert.ok(second.preview.length <= 160);
});

test("load resolves the complete request atomically in requested order", () => {
	const navigator = new HistoryNavigator([
		userItem("u1", 0, "one"),
		userItem("u2", 1, "two"),
	]);
	assert.deepEqual(navigator.load(["u2", "u1"]).map((item) => item.id), ["u2", "u1"]);
	assert.throws(() => navigator.load(["u1", "missing"]), /Unknown history ID missing/);
});

test("paging turns stay out of every navigator operation", () => {
	const navigator = new HistoryNavigator([
		userItem("u1", 0, "request"),
		turnItem("paging", 1, "private paging result marker", ["read_context_output"], [], false),
		turnItem("normal", 2, "normal result marker", ["read"], ["src/a.ts"], false),
	]);

	assert.deepEqual(navigator.search({ query: "marker" }).map((ref) => ref.historyId), ["normal"]);
	assert.deepEqual(navigator.browse({ direction: "forward", count: 10 }).map((ref) => [ref.historyId, ref.sequence]), [
		["u1", 0],
		["normal", 1],
	]);
	assert.throws(() => navigator.load(["paging"]), /Unknown history ID paging/);
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
	assert.deepEqual(ids(navigator.browse({ historyId: "h0", direction: "backward", count: 2 })), []);
	assert.deepEqual(ids(navigator.browse({ historyId: "h4", direction: "forward", count: 2 })), []);
});

test("browse handles empty history and rejects invalid anchors", () => {
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
