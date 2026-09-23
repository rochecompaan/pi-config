import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryItem, ModelTurnHistoryItem } from "./history.ts";
import { readContextOutput } from "./output-pages.ts";

const assistantText = "a".repeat(20_000);
const resultText = "b".repeat(20_000);

const turn: ModelTurnHistoryItem = {
	id: "turn-1",
	kind: "modelTurn",
	sequence: 0,
	timestamp: "2026-09-21T00:00:00.000Z",
	assistantMessage: {
		role: "assistant",
		content: [{ type: "text", text: assistantText }],
		stopReason: "toolUse",
		timestamp: 1,
	} as any,
	toolResults: [{
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: resultText }],
		isError: false,
		timestamp: 2,
	}] as any,
	metadata: { tools: ["read"], files: [], failed: false },
};

const user: HistoryItem = {
	id: "user-1",
	kind: "user",
	sequence: 1,
	timestamp: "2026-09-21T00:00:01.000Z",
	userMessage: { role: "user", content: "request", timestamp: 3 } as any,
};

test("reads exact serialized output pages without replacing large values", () => {
	const first = readContextOutput([turn], {
		historyId: turn.id,
		source: "toolResult",
		toolCallId: "call-1",
		limit: 2_000,
	});

	assert.equal(first.offset, 0);
	assert.equal(first.text.length, 2_000);
	assert.equal(first.nextOffset, 2_000);

	const final = readContextOutput([turn], {
		historyId: turn.id,
		source: "toolResult",
		toolCallId: "call-1",
		offset: first.totalCharacters,
	});
	assert.equal(final.text, "");
	assert.equal(final.nextOffset, null);

	const assistant = readContextOutput([turn], {
		historyId: turn.id,
		source: "assistant",
		contentIndex: 0,
	});
	assert.equal(assistant.text, JSON.stringify(turn.assistantMessage.content[0]).slice(0, 2_000));
	assert.equal(assistant.nextOffset, 2_000);
});

test("rejects invalid context-output references and page bounds", () => {
	const assistantReference = {
		historyId: turn.id,
		source: "assistant" as const,
		contentIndex: 0,
	};
	const resultReference = {
		historyId: turn.id,
		source: "toolResult" as const,
		toolCallId: "call-1",
	};
	const serializedResult = JSON.stringify(turn.toolResults[0]);

	for (const input of [
		{ ...assistantReference, historyId: "missing" },
		{ ...assistantReference, historyId: user.id },
		{ ...assistantReference, contentIndex: 1 },
		{ ...resultReference, toolCallId: "missing" },
		{ ...assistantReference, toolCallId: "call-1" },
		{ ...resultReference, contentIndex: 0 },
		{ historyId: turn.id, source: "assistant" },
		{ historyId: turn.id, source: "toolResult" },
		{ ...assistantReference, offset: -1 },
		{ ...assistantReference, offset: 0.5 },
		{ ...assistantReference, limit: 0 },
		{ ...assistantReference, limit: 2_001 },
		{ ...resultReference, offset: serializedResult.length + 1 },
	]) {
		assert.throws(() => readContextOutput([turn, user], input));
	}
});
