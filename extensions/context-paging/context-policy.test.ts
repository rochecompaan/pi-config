import assert from "node:assert/strict";
import test from "node:test";
import { PAGING_TOOL_NAMES, projectActiveBranch, type HistoryItem, type ModelTurnHistoryItem } from "./history.ts";
import { HistoryNavigator } from "./navigator.ts";
import {
	ContextBudgetError,
	measureContextBytes,
	selectContext,
	type ResidentToolDefinition,
} from "./context-policy.ts";

const contextWindowForBudget = (bytes: number) => Math.ceil(bytes / 0.60);

function user(id: string, sequence: number, content: string): HistoryItem {
	return {
		id,
		kind: "user",
		sequence,
		timestamp: `2026-09-21T00:00:${String(sequence).padStart(2, "0")}.000Z`,
		userMessage: { role: "user", content, timestamp: sequence },
	};
}

function turn(id: string, sequence: number, text: string): ModelTurnHistoryItem {
	return {
		id,
		kind: "modelTurn",
		sequence,
		timestamp: `2026-09-21T00:00:${String(sequence).padStart(2, "0")}.000Z`,
		assistantMessage: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
			timestamp: sequence,
		} as any,
		toolResults: [],
		metadata: { tools: [], files: [], failed: false },
	};
}

function toolTurn(id: string, sequence: number, resultText: string): ModelTurnHistoryItem {
	return {
		id,
		kind: "modelTurn",
		sequence,
		timestamp: `2026-09-21T00:00:${String(sequence).padStart(2, "0")}.000Z`,
		assistantMessage: {
			role: "assistant",
			content: [{ type: "toolCall", id: `${id}-call`, name: "read", arguments: { path: "file.ts" } }],
			stopReason: "toolUse",
			timestamp: sequence,
		} as any,
		toolResults: [{
			role: "toolResult",
			toolCallId: `${id}-call`,
			toolName: "read",
			content: [{ type: "text", text: resultText }],
			isError: false,
			timestamp: sequence,
		}],
		metadata: { tools: ["read"], files: ["file.ts"], failed: false },
	};
}

function pagingBranch(toolName: typeof PAGING_TOOL_NAMES[number], marker: string) {
	return [
		{
			type: "message",
			id: `${toolName}-user`,
			parentId: null,
			timestamp: "2026-09-21T00:00:00.000Z",
			message: { role: "user", content: `run ${toolName}`, timestamp: 1 },
		},
		{
			type: "message",
			id: `${toolName}-turn`,
			parentId: null,
			timestamp: "2026-09-21T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: `${toolName}-call`, name: toolName, arguments: {} }],
				stopReason: "toolUse",
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: `${toolName}-result`,
			parentId: null,
			timestamp: "2026-09-21T00:00:02.000Z",
			message: {
				role: "toolResult",
				toolCallId: `${toolName}-call`,
				toolName,
				content: [{ type: "text", text: marker }],
				isError: false,
				timestamp: 3,
			},
		},
	];
}

test("measures the full serialized resident context and messages in UTF-8 bytes", () => {
	const tools: ResidentToolDefinition[] = [{
		name: "léer",
		description: "Read 😀",
		parameters: { type: "object", properties: { path: { type: "string" } } },
	}];
	const messages = [{ role: "user", content: "café 😀", timestamp: 1 }] as any;
	const expected = Buffer.byteLength(JSON.stringify({
		systemPrompt: "système 😀",
		tools,
		messages,
	}), "utf8");
	assert.equal(measureContextBytes("système 😀", tools, messages), expected);
});

test("resident prompt and tool definitions can overflow mandatory context", () => {
	const userItem = user("user-1", 0, "keep me");
	const baseline = measureContextBytes("", [], [userItem.userMessage]);
	const contextWindow = contextWindowForBudget(baseline);
	assert.equal(selectContext({ items: [userItem], systemPrompt: "", activeTools: [], contextWindow }).messages.length, 1);

	for (const input of [
		{ systemPrompt: "extra system bytes", activeTools: [] },
		{
			systemPrompt: "",
			activeTools: [{ name: "read", description: "extra tool bytes", parameters: { type: "object" } }],
		},
	]) {
		assert.throws(
			() => selectContext({ items: [userItem], contextWindow, ...input }),
			(error: unknown) => error instanceof ContextBudgetError
				&& error.code === "MANDATORY_CONTEXT_TOO_LARGE"
				&& error.measuredInputBytes > error.maximumInputBytes,
		);
	}
});

test("rejects missing and invalid model context windows", () => {
	for (const contextWindow of [undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(
			() => selectContext({ items: [], systemPrompt: "", activeTools: [], contextWindow }),
			(error: unknown) => error instanceof ContextBudgetError && error.code === "INVALID_MODEL_CONTEXT",
		);
	}
});

test("preserves every user message by identity and chronological sequence", () => {
	const first = user("user-1", 0, "first");
	const oldTurn = turn("turn-1", 1, "old".repeat(1_000));
	const second = user("user-2", 2, "second");
	const newestTurn = turn("turn-2", 3, "new".repeat(1_000));
	const mandatoryBytes = measureContextBytes("system", [], [first.userMessage, second.userMessage]);
	const selection = selectContext({
		items: [newestTurn, second, oldTurn, first],
		systemPrompt: "system",
		activeTools: [],
		contextWindow: contextWindowForBudget(mandatoryBytes),
	});
	assert.deepEqual(selection.selectedHistoryIds, [first.id, second.id]);
	assert.deepEqual(selection.selectedModelTurnIds, []);
	assert.deepEqual(selection.evictedHistoryIds, [oldTurn.id, newestTurn.id]);
	assert.equal(selection.messages[0], first.userMessage);
	assert.equal(selection.messages[1], second.userMessage);
});

test("selects only a newest contiguous model-turn suffix and never emits orphan results", () => {
	const userOne = user("user-1", 0, "request");
	const oldSmallTurn = turn("old", 1, "old response");
	const middleHugeTurn = turn("middle", 2, "middle response");
	(middleHugeTurn.assistantMessage as any).provider = "x".repeat(20_000);
	const newestSmallTurn = toolTurn("newest", 3, "new result");
	const newestMessages = [userOne.userMessage, newestSmallTurn.assistantMessage, ...newestSmallTurn.toolResults] as any;
	const targetBytes = measureContextBytes("system", [], newestMessages);

	const selection = selectContext({
		items: [userOne, oldSmallTurn, middleHugeTurn, newestSmallTurn],
		systemPrompt: "system",
		activeTools: [],
		contextWindow: contextWindowForBudget(targetBytes),
	});
	assert.deepEqual(selection.selectedHistoryIds, [userOne.id, newestSmallTurn.id]);
	assert.deepEqual(selection.selectedModelTurnIds, [newestSmallTurn.id]);
	assert.deepEqual(selection.evictedHistoryIds, [oldSmallTurn.id, middleHugeTurn.id]);
	assert.equal(selection.messages.findIndex((message) => message.role === "toolResult") > 0, true);
	for (let index = 0; index < selection.messages.length; index++) {
		if (selection.messages[index].role === "toolResult") assert.equal(selection.messages[index - 1].role, "assistant");
	}
});

test("keeps paging-tool results visible outbound while excluding them from navigation", () => {
	for (const toolName of PAGING_TOOL_NAMES) {
		const items = projectActiveBranch(pagingBranch(toolName, `${toolName}-result-marker`) as any);
		const navigator = new HistoryNavigator(items);
		const selection = selectContext({
			items,
			systemPrompt: "system",
			activeTools: [],
			contextWindow: 10_000,
		});

		assert.equal(
			JSON.stringify(selection.messages).includes(`${toolName}-result-marker`),
			true,
			`${toolName} result must be visible on the immediate follow-up`,
		);
		assert.deepEqual(navigator.search({ query: `${toolName}-result-marker` }), []);
	}
});

test("pages large outputs before eviction for different context windows without mutating history", () => {
	const userItem = user("user-1", 0, "inspect output");
	const largeTurn = toolTurn("large-turn", 1, "b".repeat(40_000));
	largeTurn.assistantMessage.content = [{ type: "text", text: "a".repeat(40_000) }, largeTurn.assistantMessage.content[0]] as any;
	const rawBefore = structuredClone(largeTurn);
	const activeTools = [{ name: "read", description: "Read a file", parameters: { type: "object" } }];

	for (const contextWindow of [32_000, 200_000]) {
		const selection = selectContext({
			items: [userItem, largeTurn],
			systemPrompt: "shared system prompt",
			activeTools,
			contextWindow,
		});
		assert.equal(selection.maximumInputBytes, Math.floor(contextWindow * 0.60));
		assert.ok(selection.measuredInputBytes <= selection.maximumInputBytes);
		assert.deepEqual(selection.selectedModelTurnIds, [largeTurn.id]);
		assert.deepEqual(selection.outputReferences, [
			{ historyId: largeTurn.id, source: "assistant", contentIndex: 0 },
			{ historyId: largeTurn.id, source: "toolResult", toolCallId: "large-turn-call" },
		]);
	}
	assert.deepEqual(largeTurn, rawBefore);
});
