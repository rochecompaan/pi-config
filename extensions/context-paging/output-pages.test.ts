import assert from "node:assert/strict";
import test from "node:test";
import type { ModelTurnHistoryItem } from "./history.ts";
import {
	MAXIMUM_INLINE_OUTPUT_BYTES,
	MAXIMUM_OUTPUT_PAGE_CHARACTERS,
	pageAllTurnOutputs,
	pageTurnOutputs,
	readContextOutput,
} from "./output-pages.ts";

function turnWithLargeOutputs(): ModelTurnHistoryItem {
	return {
		id: "source-turn",
		kind: "modelTurn",
		sequence: 0,
		timestamp: "2026-09-21T00:00:00.000Z",
		assistantMessage: {
			role: "assistant",
			content: [
				{ type: "text", text: "a".repeat(200) },
				{
					type: "toolCall",
					id: "call-1",
					name: "bash",
					namespace: "functions",
					arguments: {},
				},
			],
			stopReason: "toolUse",
			timestamp: 1,
		} as any,
		toolResults: [{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "b".repeat(200) }],
			details: { stderr: "failed" },
			isError: true,
			timestamp: 2,
		}],
		metadata: { tools: ["bash"], files: [], failed: true },
	};
}

test("pages large assistant blocks and tool results without mutating raw history", () => {
	const sourceTurn = turnWithLargeOutputs();
	const sourceBefore = structuredClone(sourceTurn);
	const view = pageTurnOutputs(sourceTurn, 100);

	assert.deepEqual(sourceTurn, sourceBefore);
	assert.equal(view.references.length, 2);
	assert.match(view.item.assistantMessage.content[0].type === "text"
		? view.item.assistantMessage.content[0].text
		: "", /read_context_output/);
	assert.equal(view.item.assistantMessage.content[1].type, "toolCall");
	assert.equal(view.item.assistantMessage.content[1].id, "call-1");
	assert.equal(view.item.assistantMessage.content[1].name, "bash");
	assert.equal(view.item.assistantMessage.content[1].namespace, "functions");
	assert.equal(view.item.toolResults[0].toolCallId, "call-1");
	assert.equal(view.item.toolResults[0].toolName, "bash");
	assert.equal(view.item.toolResults[0].isError, true);
	assert.match(
		view.item.assistantMessage.content[0].type === "text" ? view.item.assistantMessage.content[0].text : "",
		/\{"historyId":"source-turn","source":"assistant","contentIndex":0\}/,
	);
	assert.deepEqual(view.references, [
		{ historyId: "source-turn", source: "assistant", contentIndex: 0 },
		{ historyId: "source-turn", source: "toolResult", toolCallId: "call-1" },
	]);
});

test("uses UTF-8 bytes for ordinary paging and pages every output on demand", () => {
	const nonAsciiTurn = turnWithLargeOutputs();
	nonAsciiTurn.assistantMessage.content = [{ type: "text", text: "😀".repeat(30) }] as any;
	nonAsciiTurn.toolResults = [];
	assert.ok(JSON.stringify(nonAsciiTurn.assistantMessage.content[0]).length < 100);
	assert.equal(pageTurnOutputs(nonAsciiTurn, 100).references.length, 1);

	const view = pageAllTurnOutputs(turnWithLargeOutputs());
	assert.equal(view.references.length, 3);
	assert.deepEqual(view.references, [
		{ historyId: "source-turn", source: "assistant", contentIndex: 0 },
		{ historyId: "source-turn", source: "assistant", contentIndex: 1 },
		{ historyId: "source-turn", source: "toolResult", toolCallId: "call-1" },
	]);
	assert.deepEqual(
		view.item.assistantMessage.content[1].type === "toolCall"
			? view.item.assistantMessage.content[1].arguments
			: undefined,
		{ contextOutputReference: view.references[1] },
	);
	assert.ok(MAXIMUM_INLINE_OUTPUT_BYTES === 16_000);
	assert.ok(MAXIMUM_OUTPUT_PAGE_CHARACTERS === 2_000);
});

const pagingTurn: ModelTurnHistoryItem = {
	id: "paging-turn",
	kind: "modelTurn",
	sequence: 0,
	timestamp: "2026-09-21T00:00:00.000Z",
	assistantMessage: {
		role: "assistant",
		content: [{
			type: "toolCall",
			id: "load-call",
			name: "load_history",
			arguments: { historyIds: ["source"] },
		}],
		stopReason: "toolUse",
		timestamp: 1,
	} as any,
	toolResults: [{
		role: "toolResult",
		toolCallId: "load-call",
		toolName: "load_history",
		content: [{ type: "text", text: "😀".repeat(900) }],
		details: { marker: "raw paging result" },
		isError: false,
		timestamp: 2,
	}],
	metadata: { tools: ["load_history"], files: [], failed: false },
};

test("reads raw JSON repeatedly by UTF-16 offsets, including paging-tool turns", () => {
	const first = readContextOutput([pagingTurn], {
		historyId: pagingTurn.id,
		source: "toolResult",
		toolCallId: "load-call",
		offset: 0,
		limit: 17,
	});
	const second = readContextOutput([pagingTurn], {
		historyId: pagingTurn.id,
		source: "toolResult",
		toolCallId: "load-call",
		offset: first.nextOffset as number,
		limit: 2_000,
	});
	const original = JSON.stringify(pagingTurn.toolResults[0]);
	assert.equal(first.text + second.text, original);
	assert.equal(second.nextOffset, null);
	assert.equal(second.totalCharacters, original.length);
	assert.equal(first.text.length, 17);
});

test("validates output references, offsets, and page limits", () => {
	const assistantReference = {
		historyId: pagingTurn.id,
		source: "assistant" as const,
		contentIndex: 0,
	};
	const resultReference = {
		historyId: pagingTurn.id,
		source: "toolResult" as const,
		toolCallId: "load-call",
	};
	const serializedResult = JSON.stringify(pagingTurn.toolResults[0]);

	assert.deepEqual(readContextOutput([pagingTurn], {
		...resultReference,
		offset: serializedResult.length,
	}), {
		offset: serializedResult.length,
		nextOffset: null,
		totalCharacters: serializedResult.length,
		text: "",
	});
	for (const input of [
		{ ...assistantReference, historyId: "missing" },
		{ ...assistantReference, historyId: "user-turn" },
		{ ...assistantReference, contentIndex: 1 },
		{ ...resultReference, toolCallId: "missing" },
		{ ...assistantReference, toolCallId: "load-call" },
		{ ...resultReference, contentIndex: 0 },
		{ ...assistantReference, contentIndex: -1 },
		{ ...assistantReference, contentIndex: 0.5 },
		{ ...assistantReference, offset: -1 },
		{ ...assistantReference, offset: 0.5 },
		{ ...assistantReference, limit: 0 },
		{ ...assistantReference, limit: 2_001 },
		{ ...resultReference, offset: serializedResult.length + 1 },
	]) {
		assert.throws(() => readContextOutput([
			pagingTurn,
			{
				id: "user-turn",
				kind: "user",
				sequence: 1,
				timestamp: "2026-09-21T00:00:01.000Z",
				userMessage: { role: "user", content: "request", timestamp: 3 },
			},
		], input as any));
	}
});
