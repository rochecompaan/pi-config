import assert from "node:assert/strict";
import test from "node:test";
import {
	findModelTurnByToolCallId,
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

const assistantEntry = (id: string, content: unknown[], stopReason = "toolUse") => ({
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
		stopReason,
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

test("projects complete raw exchanges in branch order without changing stored entries", () => {
	const entries = [
		userEntry("user-1", "inspect src/index.ts"),
		assistantEntry("assistant-1", [
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } },
			{ type: "toolCall", id: "call-2", name: "read", arguments: { files: ["src/other.ts"] } },
		]),
		resultEntry("result-2", "call-2", "second", true),
		resultEntry("result-1", "call-1", "first"),
	];
	const before = structuredClone(entries);
	const items = projectActiveBranch(entries as any);

	assert.deepEqual(items.map((item) => item.id), ["user-1", "assistant-1"]);
	assert.equal(items[0].kind, "user");
	assert.equal(items[1].kind, "modelTurn");
	assert.deepEqual(
		items[1].kind === "modelTurn"
			? items[1].toolResults.map((result) => result.toolCallId)
			: [],
		["call-2", "call-1"],
	);
	assert.deepEqual(
		items[1].kind === "modelTurn" ? items[1].metadata : undefined,
		{ tools: ["read", "read"], files: ["src/index.ts", "src/other.ts"], failed: true },
	);
	assert.deepEqual(entries, before);
});

test("finds the model turn that owns a tool call", () => {
	const items = projectActiveBranch([
		assistantEntry("assistant-1", [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]),
		resultEntry("result-1", "call-1", "contents"),
	] as any);

	assert.equal(findModelTurnByToolCallId(items, "call-1")?.id, "assistant-1");
	assert.equal(findModelTurnByToolCallId(items, "missing"), undefined);
});

test("finds the newest model turn when a tool-call ID is reused", () => {
	const items = projectActiveBranch([
		assistantEntry("assistant-old", [{ type: "toolCall", id: "reused-call", name: "read", arguments: {} }]),
		resultEntry("result-old", "reused-call", "old contents"),
		assistantEntry("assistant-new", [{ type: "toolCall", id: "reused-call", name: "read", arguments: {} }]),
		resultEntry("result-new", "reused-call", "new contents"),
	] as any);

	assert.equal(findModelTurnByToolCallId(items, "reused-call")?.id, "assistant-new");
});

test("recognizes paging-tool turns without classifying normal tool turns", () => {
	const [pagingTurn] = projectActiveBranch([
		assistantEntry("assistant-1", [{ type: "toolCall", id: "call-1", name: "search_history", arguments: {} }]),
		resultEntry("result-1", "call-1", "contents"),
	] as any);
	const [normalTurn] = projectActiveBranch([
		assistantEntry("assistant-2", [{ type: "toolCall", id: "call-2", name: "read", arguments: {} }]),
		resultEntry("result-2", "call-2", "contents"),
	] as any);

	assert.equal(isPagingToolTurn(pagingTurn), true);
	assert.equal(isPagingToolTurn(normalTurn), false);
});

test("rejects a tool result that no assistant batch owns", () => {
	const orphanResultBranch = [resultEntry("result-1", "call-1", "contents")];

	assert.throws(
		() => projectActiveBranch(orphanResultBranch as any),
		(error: unknown) => error instanceof HistoryProjectionError
			&& error.code === "ORPHAN_TOOL_RESULT",
	);
});

test("rejects a duplicate result within an assistant batch", () => {
	const duplicateResultBranch = [
		assistantEntry("assistant-1", [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]),
		resultEntry("result-1", "call-1", "first"),
		resultEntry("result-2", "call-1", "second"),
	];

	assert.throws(
		() => projectActiveBranch(duplicateResultBranch as any),
		(error: unknown) => error instanceof HistoryProjectionError
			&& error.code === "DUPLICATE_TOOL_RESULT",
	);
});

test("rejects an incomplete assistant exchange before a later item", () => {
	const incompleteOlderBranch = [
		assistantEntry("assistant-1", [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]),
		userEntry("user-1", "continue"),
	];

	assert.throws(
		() => projectActiveBranch(incompleteOlderBranch as any),
		(error: unknown) => error instanceof HistoryProjectionError
			&& error.code === "INCOMPLETE_TOOL_RESULTS",
	);
});

test("rejects a result assigned to the wrong assistant batch", () => {
	const mismatchedResultBranch = [
		assistantEntry("assistant-1", [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]),
		resultEntry("result-1", "other-call", "contents"),
	];

	assert.throws(
		() => projectActiveBranch(mismatchedResultBranch as any),
		(error: unknown) => error instanceof HistoryProjectionError
			&& error.code === "MISMATCHED_TOOL_RESULT",
	);
});

test("omits only the newest incomplete assistant exchange", () => {
	const entries = [
		userEntry("user-1", "first request"),
		assistantEntry("assistant-1", [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]),
		resultEntry("result-1", "call-1", "complete"),
		userEntry("user-2", "second request"),
		assistantEntry("assistant-2", [
			{ type: "toolCall", id: "call-2", name: "read", arguments: {} },
			{ type: "toolCall", id: "call-3", name: "read", arguments: {} },
		]),
		resultEntry("result-2", "call-2", "not complete"),
	];

	assert.deepEqual(
		projectActiveBranch(entries as any).map((item) => item.id),
		["user-1", "assistant-1", "user-2"],
	);
});

test("projects interrupted exchanges with every actual result and marks them failed", () => {
	for (const stopReason of ["aborted", "error"]) {
		for (const resultCount of [0, 1, 2]) {
			const entries = [
				assistantEntry("failed-turn", [
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } },
					{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "src/b.ts" } },
				], stopReason),
				...[
					resultEntry("result-1", "call-1", "first"),
					resultEntry("result-2", "call-2", "second"),
				].slice(0, resultCount),
				userEntry("next-user", "continue"),
			];
			const before = structuredClone(entries);
			const projected = projectActiveBranch(entries as any);

			assert.deepEqual(projected.map((item) => item.id), ["failed-turn", "next-user"]);
			assert.equal(projected[0].kind, "modelTurn");
			if (projected[0].kind === "modelTurn") {
				assert.equal(projected[0].metadata.failed, true);
				assert.equal(projected[0].assistantMessage, entries[0].message);
				assert.deepEqual(projected[0].toolResults, entries.slice(1, 1 + resultCount).map((entry) => entry.message));
			}
			assert.deepEqual(entries, before);
		}
	}
});

test("retains interrupted exchanges at the branch tail with every actual result", () => {
	for (const stopReason of ["aborted", "error"]) {
		for (const resultCount of [0, 1, 2]) {
			const entries = [
				userEntry("request", "read files"),
				assistantEntry("failed-tail", [
					{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
					{ type: "toolCall", id: "call-2", name: "read", arguments: {} },
				], stopReason),
				...[resultEntry("result-1", "call-1", "first"), resultEntry("result-2", "call-2", "second")].slice(0, resultCount),
			];
			const before = structuredClone(entries);
			const projected = projectActiveBranch(entries as any);
			assert.deepEqual(projected.map((item) => item.id), ["request", "failed-tail"]);
			const tail = projected[1];
			assert.equal(tail.kind, "modelTurn");
			if (tail.kind === "modelTurn") {
				assert.equal(tail.metadata.failed, true);
				assert.equal(tail.assistantMessage, entries[1].message);
				assert.equal(tail.toolResults.length, resultCount);
				for (let index = 0; index < resultCount; index++) assert.equal(tail.toolResults[index], entries[index + 2].message);
			}
			assert.deepEqual(entries, before);
		}
	}
});

test("marks interrupted text responses failed without removing them from raw history", () => {
	for (const stopReason of ["aborted", "error"]) {
		const entries = [
			assistantEntry("failed-text", [{ type: "text", text: "partial response" }], stopReason),
			userEntry("next-user", "continue"),
		];
		const projected = projectActiveBranch(entries as any);

		assert.deepEqual(projected.map((item) => item.id), ["failed-text", "next-user"]);
		assert.equal(projected[0].kind, "modelTurn");
		assert.equal(projected[0].kind && projected[0].metadata.failed, true);
	}
});

test("rejects invalid actual results after interrupted exchanges", () => {
	for (const entries of [
		[
			assistantEntry("failed-turn", [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }], "aborted"),
			resultEntry("first", "call-1", "first"),
			resultEntry("duplicate", "call-1", "second"),
		],
		[
			assistantEntry("failed-turn", [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }], "error"),
			resultEntry("mismatched", "other-call", "wrong"),
		],
	]) {
		assert.throws(() => projectActiveBranch(entries as any), HistoryProjectionError);
	}
});
