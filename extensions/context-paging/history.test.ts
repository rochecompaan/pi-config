import assert from "node:assert/strict";
import test from "node:test";
import {
	flattenHistoryItems,
	HistoryProjectionError,
	isPagingToolTurn,
	projectActiveBranch,
} from "./history.ts";

const userEntry = (id: string, content: string) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: `2026-09-21T00:00:0${id.length}.000Z`,
	message: { role: "user", content, timestamp: 1 },
});

const assistantEntry = (id: string, content: unknown[]) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-09-21T00:00:10.000Z",
	message: {
		role: "assistant",
		content,
		api: "test",
		provider: "provider-a",
		model: "model-a",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	},
});

const resultEntry = (id: string, toolCallId: string, text: string, isError = false) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-09-21T00:00:11.000Z",
	message: {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError,
		timestamp: 3,
	},
});

test("projects users and complete assistant tool exchanges as atomic items", () => {
	const entries = [
		userEntry("user-1", "inspect src/index.ts"),
		assistantEntry("turn-1", [
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } },
		]),
		resultEntry("result-1", "call-1", "file contents"),
		{ type: "label", id: "label-1", parentId: null, timestamp: "2026-09-21T00:00:12.000Z" },
	] as any;

	const items = projectActiveBranch(entries);
	assert.equal(items.length, 2);
	assert.equal(items[0].id, "user-1");
	assert.equal(items[0].sequence, 0);
	assert.equal(items[1].id, "turn-1");
	assert.equal(items[1].sequence, 1);
	assert.deepEqual(items[1].kind === "modelTurn" ? items[1].metadata : undefined, {
		tools: ["read"],
		files: ["src/index.ts"],
		failed: false,
	});
	assert.deepEqual(flattenHistoryItems(items), [
		entries[0].message,
		entries[1].message,
		entries[2].message,
	]);
});

test("classifies turns containing paging tools", () => {
	for (const toolName of ["search_history", "browse_history", "load_history", "read_context_output"]) {
		const [item] = projectActiveBranch([
			assistantEntry("turn-1", [{ type: "toolCall", id: "call-1", name: toolName, arguments: {} }]),
			resultEntry("result-1", "call-1", "result"),
		] as any);
		assert.equal(isPagingToolTurn(item), true, toolName);
	}

	const [mixed] = projectActiveBranch([
		assistantEntry("turn-1", [
			{ type: "toolCall", id: "call-1", name: "search_history", arguments: {} },
			{ type: "toolCall", id: "call-2", name: "read", arguments: {} },
		]),
		resultEntry("result-1", "call-1", "result"),
		resultEntry("result-2", "call-2", "result"),
	] as any);
	assert.equal(isPagingToolTurn(mixed), true);
});

test("omits only an incomplete newest assistant turn", () => {
	const entries = [
		userEntry("user-1", "search"),
		assistantEntry("turn-1", [
			{ type: "toolCall", id: "call-1", name: "search_history", arguments: { query: "x" } },
		]),
	] as any;
	assert.deepEqual(projectActiveBranch(entries).map((item) => item.id), ["user-1"]);
});

test("rejects incomplete older turns and orphan or duplicate results", () => {
	const incompleteOlder = [
		assistantEntry("turn-1", [
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } },
		]),
		userEntry("user-2", "continue"),
	] as any;
	assert.throws(
		() => projectActiveBranch(incompleteOlder),
		(error: unknown) => error instanceof HistoryProjectionError && error.code === "INCOMPLETE_TOOL_RESULTS",
	);

	assert.throws(
		() => projectActiveBranch([resultEntry("result-1", "missing", "x")] as any),
		(error: unknown) => error instanceof HistoryProjectionError && error.code === "ORPHAN_TOOL_RESULT",
	);

	const duplicate = [
		assistantEntry("turn-1", [
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } },
		]),
		resultEntry("result-1", "call-1", "first"),
		resultEntry("result-2", "call-1", "second"),
	] as any;
	assert.throws(
		() => projectActiveBranch(duplicate),
		(error: unknown) => error instanceof HistoryProjectionError && error.code === "DUPLICATE_TOOL_RESULT",
	);
});

test("keeps parallel results in source order and rejects results from another turn", () => {
	const entries = [
		assistantEntry("turn-1", [
			{ type: "toolCall", id: "call-1", name: "read", arguments: { options: { FILE_PATH: "a.ts" } } },
			{ type: "toolCall", id: "call-2", name: "read", arguments: { files: ["b.ts", "a.ts"] } },
		]),
		resultEntry("result-2", "call-2", "second", true),
		resultEntry("result-1", "call-1", "first"),
	] as any;
	const [turn] = projectActiveBranch(entries);
	assert.deepEqual(turn.kind === "modelTurn" ? turn.toolResults.map((result) => result.toolCallId) : [], ["call-2", "call-1"]);
	assert.deepEqual(turn.kind === "modelTurn" ? turn.metadata.files : [], ["a.ts", "b.ts"]);
	assert.equal(turn.kind === "modelTurn" ? turn.metadata.failed : false, true);

	assert.throws(
		() => projectActiveBranch([
			assistantEntry("turn-1", [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]),
			resultEntry("result-1", "other-call", "wrong turn"),
		] as any),
		(error: unknown) => error instanceof HistoryProjectionError && error.code === "ORPHAN_TOOL_RESULT",
	);
});
