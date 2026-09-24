import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { HistoryItem } from "./history.ts";
import {
	DEFAULT_CONTEXT_TOKEN_BUDGET,
	ContextSelectionError,
	selectContext,
} from "./context-policy.ts";

const LEGACY_TEST_TOKEN_BUDGET = 64_000;

type SelectionOverrides = {
	modelContextWindow?: number;
	tokenBudget?: number;
	rawHistoryItems?: HistoryItem[];
};

const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 });
const custom = (content: string) => ({
	role: "custom" as const,
	customType: "test-request",
	content,
	display: true,
	timestamp: 0,
});
const assistant = (text: string) => ({ role: "assistant" as const, content: [{ type: "text", text }], timestamp: 0 });
const toolCall = (id: string, name = "read") => ({ type: "toolCall" as const, id, name, arguments: { path: "src/file.ts" } });
const toolAssistant = (...calls: ReturnType<typeof toolCall>[]) => ({
	role: "assistant" as const,
	content: calls,
	timestamp: 0,
});
const result = (toolCallId: string, text: string, toolName = "read") => ({
	role: "toolResult" as const,
	toolCallId,
	toolName,
	content: [{ type: "text" as const, text }],
	isError: false,
	timestamp: 0,
});
const selected = (
	messages: readonly object[],
	{
		modelContextWindow = 100_000,
		tokenBudget = LEGACY_TEST_TOKEN_BUDGET,
		rawHistoryItems,
	}: SelectionOverrides = {},
) => selectContext({
	messages: messages as any,
	systemPrompt: "resident prompt",
	activeTools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
	modelContextWindow,
	tokenBudget,
	rawHistoryItems,
});
const marker = (message: any): string => typeof message.content === "string"
	? message.content
	: message.content?.map((block: any) => block.text ?? "").join("") ?? message.summary ?? "";
const hasMarker = (messages: readonly object[], value: string) => messages.some((message) => marker(message).includes(value));
const rolesAndMarkers = (messages: readonly any[]) => messages.map((message) => [message.role, marker(message)]);
const repeat = (markerText: string, length: number) => `${markerText} ${"x".repeat(length)}`;

// This test fails if accounting changes from Pi's exported estimator to byte or character counting.
test("accounts resident inputs and canonical messages with Pi estimates", () => {
	const messages = [
		user("request  😀  {\"spacing\":  true}"),
		assistant("answer\n\nwith JSON: {\"ok\":true}"),
	];
	const systemMessage = user("system prompt\t😀");
	const toolMessage = user(JSON.stringify([{ name: "read", description: "Read", parameters: { type: "object" } }]));
	const expected = estimateTokens(systemMessage)
		+ estimateTokens(toolMessage)
		+ messages.reduce((total, message) => total + estimateTokens(message as any), 0);
	const selection = selectContext({
		messages: messages as any,
		systemPrompt: systemMessage.content,
		activeTools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
		modelContextWindow: 100_000,
		tokenBudget: LEGACY_TEST_TOKEN_BUDGET,
	});

	assert.equal(DEFAULT_CONTEXT_TOKEN_BUDGET, 128_000);
	assert.equal(selection.estimatedTokens, expected);
	assert.equal(selection.budgetTokens, LEGACY_TEST_TOKEN_BUDGET);
	assert.deepEqual(selection.messages, messages);
	assert.equal(selectContext({
		messages: [],
		systemPrompt: "resident",
		activeTools: [],
		modelContextWindow: 32_000,
		tokenBudget: DEFAULT_CONTEXT_TOKEN_BUDGET,
	}).budgetTokens, 32_000);
});

test("uses an explicit token budget when model context metadata is absent", () => {
	const selection = selectContext({
		messages: [],
		systemPrompt: "resident",
		activeTools: [],
		modelContextWindow: undefined,
		tokenBudget: 96_000,
	});

	assert.equal(selection.budgetTokens, 96_000);
	assert.equal(selection.mode, "within-budget");
});

test("rejects invalid token budgets at the selector boundary", () => {
	for (const tokenBudget of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "64_000", [96000], {}]) {
		assert.throws(
			() => selectContext({
				messages: [],
				systemPrompt: "resident",
				activeTools: [],
				modelContextWindow: undefined,
				tokenBudget: tokenBudget as unknown as number,
			}),
			(error: unknown) => error instanceof ContextSelectionError
				&& error.code === "INVALID_TOKEN_BUDGET" && /token budget/i.test(error.message),
		);
	}
});

test("matches Pi 0.85.1 user-image estimation", () => {
	const imageMessage = {
		role: "user" as const,
		content: [{ type: "image" as const, data: "ignored", mimeType: "image/png" }],
		timestamp: 0,
	};

	assert.equal(estimateTokens(imageMessage as any), 1_200);
});

test("removes prefix summaries and completed turns before later user turns", () => {
	const messages = [
		{ role: "compactionSummary", summary: repeat("PREFIX_SUMMARY", 100_000), timestamp: 0 },
		user(repeat("old request", 160_000)),
		assistant(repeat("old answer", 160_000)),
		user("new request"),
		assistant("new answer"),
	];
	const selection = selected(messages);

	assert.match(marker(selection.messages[0]), /^\[Context paging notice — generated by the extension\]/);
	assert.deepEqual(rolesAndMarkers(selection.messages.slice(1)), [["user", "new request"], ["assistant", "new answer"]]);
	assert.equal(hasMarker(selection.messages, "PREFIX_SUMMARY"), false);
	assert.equal(hasMarker(selection.messages, "old request"), false);
	assert.equal(hasMarker(selection.messages, "old answer"), false);
});

test("pages over-budget prefix-only context FIFO", () => {
	const messages = [{ role: "compactionSummary", summary: repeat("PREFIX_ONLY", 300_000), timestamp: 0 }];
	const selection = selected(messages);

	assert.equal(selection.messages.length, 1);
	assert.match(marker(selection.messages[0]), /^\[Context paging notice — generated by the extension\]/);
	assert.equal(selection.estimatedTokens <= selection.budgetTokens, true);
});

test("keeps the active user while removing its oldest completed exchanges", () => {
	const messages = [
		user("active request"),
		toolAssistant(toolCall("old-call")),
		result("old-call", repeat("old result", 180_000)),
		toolAssistant(toolCall("new-call")),
		result("new-call", repeat("new result", 100_000)),
	];
	const selection = selected(messages);

	assert.equal(hasMarker(selection.messages, "active request"), true);
	assert.equal(hasMarker(selection.messages, "old result"), false);
	assert.equal(hasMarker(selection.messages, "new result"), true);
	assert.equal(selection.messages.some((message: any) => message.role === "toolResult" && message.toolCallId === "old-call"), false);
});

test("keeps an injected custom message with its active user while paging a large exchange", () => {
	const activeUser = user(repeat("ACTIVE_USER_REQUEST ", 120_000));
	const injectedCustom = custom(repeat("INJECTED_CUSTOM_CONTEXT ", 100_000));
	const messages = [
		activeUser,
		injectedCustom,
		toolAssistant(toolCall("large-call")),
		result("large-call", repeat("large active exchange ", 80_000)),
	];
	const selection = selected(messages);

	assert.equal(selection.mode, "paged");
	assert.equal(selection.messages.some((message) => message === activeUser), true);
	assert.equal(selection.messages.some((message) => message === injectedCustom), true);
	assert.equal(hasMarker(selection.messages, "ACTIVE_USER_REQUEST"), true);
	assert.equal(hasMarker(selection.messages, "INJECTED_CUSTOM_CONTEXT"), true);
	assert.equal(hasMarker(selection.messages, "large active exchange"), false);
});

test("keeps a custom-only request canonical while evicting its oldest tool exchange", () => {
	const customRequest = custom("CUSTOM_ONLY_REQUEST");
	const messages = [
		customRequest,
		toolAssistant(toolCall("old-call")),
		result("old-call", repeat("old custom exchange", 180_000)),
		toolAssistant(toolCall("new-call")),
		result("new-call", repeat("new custom exchange", 100_000)),
	];
	const selection = selected(messages);

	assert.equal(selection.messages.some((message) => message === customRequest), true);
	assert.equal(selection.messages.find((message: any) => message.role === "custom"), customRequest);
	assert.equal(hasMarker(selection.messages, "old custom exchange"), false);
	assert.equal(hasMarker(selection.messages, "new custom exchange"), true);
});

test("keeps a custom request after a completed user turn and its tool follow-up", () => {
	const customRequest = custom("CUSTOM_AFTER_USER_REQUEST");
	const messages = [
		user(repeat("completed user request", 160_000)),
		assistant(repeat("completed user answer", 160_000)),
		customRequest,
		toolAssistant(toolCall("custom-old-call")),
		result("custom-old-call", repeat("old custom follow-up", 180_000)),
		toolAssistant(toolCall("custom-new-call")),
		result("custom-new-call", repeat("new custom follow-up", 100_000)),
	];
	const selection = selected(messages);

	assert.equal(selection.messages.some((message) => message === customRequest), true);
	assert.equal(selection.messages.find((message: any) => message.role === "custom"), customRequest);
	assert.equal(hasMarker(selection.messages, "completed user request"), false);
	assert.equal(hasMarker(selection.messages, "completed user answer"), false);
	assert.equal(hasMarker(selection.messages, "old custom follow-up"), false);
	assert.equal(hasMarker(selection.messages, "new custom follow-up"), true);
	assert.equal(selection.messages.some((message: any) => message.role === "toolResult" && message.toolCallId === "custom-new-call"), true);
});

test("keeps tool calls and matching sequential and parallel results atomic", () => {
	const messages = [
		user(repeat("old request", 80_000)),
		toolAssistant(toolCall("old-call")),
		result("old-call", repeat("old result", 180_000)),
		user("active request"),
		toolAssistant(toolCall("parallel-a"), toolCall("parallel-b")),
		result("parallel-b", "parallel result b"),
		result("parallel-a", "parallel result a"),
	];
	const selection = selected(messages);
	const ids = selection.messages.filter((message: any) => message.role === "toolResult").map((message: any) => message.toolCallId);

	assert.equal(hasMarker(selection.messages, "old request"), false);
	assert.deepEqual(ids, ["parallel-b", "parallel-a"]);
	assert.equal(selection.messages.some((message: any) => message.role === "assistant" && marker(message).includes("old-call")), false);
});

test("rejects orphan results and incomplete older exchanges", () => {
	assert.throws(
		() => selected([user("active"), result("orphan", "bad")]),
		(error: unknown) => error instanceof ContextSelectionError && error.code === "INVALID_MESSAGE_STRUCTURE",
	);
	assert.throws(
		() => selected([user("old"), toolAssistant(toolCall("missing")), user("active")]),
		(error: unknown) => error instanceof ContextSelectionError && error.code === "INVALID_MESSAGE_STRUCTURE",
	);
	assert.throws(
		() => selected([user("active"), toolAssistant(toolCall("duplicate"), toolCall("duplicate")), result("duplicate", "bad")]),
		(error: unknown) => error instanceof ContextSelectionError && error.code === "INVALID_MESSAGE_STRUCTURE",
	);
});

test("preserves a complete output larger than 16,000 bytes", () => {
	const output = `LARGE_OUTPUT ${"😀JSON {\"value\": true}\n".repeat(5_000)}`;
	const messages = [user("active"), toolAssistant(toolCall("large")), result("large", output)];
	const selection = selected(messages);

	assert.equal((selection.messages[2] as any).content[0].text, output);
});

test("adds one counted paging notice before retained canonical messages and can evict another unit", () => {
	const messages = [
		user(repeat("first old request", 1_000)),
		assistant(repeat("first old answer", 1_000)),
		user(repeat("second old request", 20)),
		assistant(repeat("second old answer", 20)),
		user(repeat("active request", 255_600)),
	];
	const selection = selected(messages, {
		modelContextWindow: 64_000,
		tokenBudget: DEFAULT_CONTEXT_TOKEN_BUDGET,
	});

	assert.match(marker(selection.messages[0]), /^\[Context paging notice — generated by the extension\]/);
	assert.match(marker(selection.messages[0]), /Older context left the 64,000-token rolling window\./);
	assert.equal(selection.messages[0].role, "user");
	assert.equal(selection.estimatedTokens <= selection.budgetTokens, true);
	assert.equal(hasMarker(selection.messages, "first old request"), false);
	assert.equal(hasMarker(selection.messages, "second old request"), false);
	assert.equal(hasMarker(selection.messages, "active request"), true);
	assert.match(marker(selection.messages[0]), /search_history.*browse_history/s);
	assert.match(marker(selection.messages[0]), /load_history.*read_context_output/s);
});

test("adds a stable raw history ID to a notice for a matched evicted message", () => {
	const evicted = user(repeat("matched old request", 160_000));
	const messages = [evicted, assistant(repeat("matched old answer", 160_000)), user("active")];
	const rawHistoryItems: HistoryItem[] = [{
		id: "history-user-17",
		kind: "user",
		sequence: 0,
		timestamp: "2026-09-21T00:00:00.000Z",
		userMessage: evicted as any,
	}];
	const selection = selected(messages, { modelContextWindow: 100_000, rawHistoryItems });

	assert.match(marker(selection.messages[0]), /Recent evicted historyId: "history-user-17"\./);
});

test("keeps canonical compaction summaries until FIFO removal needs them", () => {
	const summary = { role: "compactionSummary", summary: "CANONICAL_SUMMARY", timestamp: 0 };
	assert.equal(hasMarker(selected([summary, user("active")]).messages, "CANONICAL_SUMMARY"), true);
	assert.equal(
		hasMarker(selected([{ ...summary, summary: repeat("CANONICAL_SUMMARY", 300_000) }, user("active")]).messages, "CANONICAL_SUMMARY"),
		false,
	);
});

test("keeps a protected unread trailing parallel tool exchange for one follow-up call", () => {
	const protectedAssistant = toolAssistant(toolCall("new-call-a"), toolCall("new-call-b"));
	const protectedResults = [
		result("new-call-b", repeat("new parallel result b", 160_000)),
		result("new-call-a", repeat("new parallel result a", 160_000)),
	];
	const messages = [
		{ role: "compactionSummary" as const, summary: repeat("old prefix", 80_000), timestamp: 0 },
		user(repeat("older completed turn", 160_000)),
		assistant(repeat("older completed answer", 160_000)),
		user("active request"),
		toolAssistant(toolCall("removable-call")),
		result("removable-call", repeat("removable active exchange", 160_000)),
		protectedAssistant,
		...protectedResults,
	];
	const rawHistoryItems: HistoryItem[] = [{
		id: "raw-turn-id",
		kind: "modelTurn",
		sequence: 0,
		timestamp: "2026-09-21T00:00:00.000Z",
		assistantMessage: protectedAssistant as any,
		toolResults: protectedResults as any,
		metadata: { tools: ["read", "read"], files: [], failed: false },
	}];

	const selection = selectContext({
		messages: messages as any,
		systemPrompt: "resident prompt",
		activeTools: [],
		modelContextWindow: 100_000,
		tokenBudget: 48_000,
		rawHistoryItems,
	});

	assert.equal(selection.mode, "protected-overflow");
	assert.ok(selection.estimatedTokens > 48_000);
	assert.ok(selection.estimatedTokens <= 100_000);
	assert.equal(selection.messages.some((message: any) => message.role === "assistant" && message.content.some((block: any) => block.id === "new-call-a")), true);
	assert.equal(selection.messages.some((message: any) => message.role === "assistant" && message.content.some((block: any) => block.id === "new-call-b")), true);
	assert.deepEqual(selection.messages.filter((message: any) => message.role === "toolResult").map((message: any) => message.toolCallId), ["new-call-b", "new-call-a"]);
	assert.equal(hasMarker(selection.messages, "old prefix"), false);
	assert.equal(hasMarker(selection.messages, "older completed turn"), false);
	assert.equal(hasMarker(selection.messages, "older completed answer"), false);
	assert.equal(selection.messages.some((message: any) => message.role === "assistant" && message.content.some((block: any) => block.id === "removable-call")), false);
	assert.equal(hasMarker(selection.messages, "removable active exchange"), false);
	assert.match(marker(selection.messages[0]), /present in full for this follow-up call/);
	assert.match(marker(selection.messages[0]), /The normal rolling budget is 48,000 estimated tokens\./);
});

test("pages a subsequent call after a protected tool exchange and includes recovery arguments", () => {
	const oldAssistant = toolAssistant(toolCall("old-call", "distinctive-tool"));
	const oldResult = result("old-call", repeat("large old result", 300_000), "distinctive-tool");
	const messages = [user("previous request"), oldAssistant, oldResult];
	const respondedTurn: HistoryItem = {
		id: "raw-response-id",
		kind: "modelTurn",
		sequence: 1,
		timestamp: "2026-09-21T00:01:00.000Z",
		assistantMessage: assistant("MODEL_HAS_RESPONDED") as any,
		toolResults: [],
		metadata: { tools: [], files: [], failed: false },
	};
	const nextUserItem: HistoryItem = {
		id: "raw-next-user-id",
		kind: "user",
		sequence: 2,
		timestamp: "2026-09-21T00:02:00.000Z",
		userMessage: user("NEXT_REQUEST") as any,
	};
	const selection = selectContext({
		messages: [...messages, assistant("MODEL_HAS_RESPONDED"), user("NEXT_REQUEST")] as any,
		systemPrompt: "resident prompt",
		activeTools: [],
		modelContextWindow: 100_000,
		tokenBudget: LEGACY_TEST_TOKEN_BUDGET,
		rawHistoryItems: [{
			id: "raw-turn-id",
			kind: "modelTurn",
			sequence: 0,
			timestamp: "2026-09-21T00:00:00.000Z",
			assistantMessage: oldAssistant as any,
			toolResults: [oldResult] as any,
			metadata: { tools: ["read"], files: [], failed: false },
		}, respondedTurn, nextUserItem],
	});

	assert.notEqual(selection.mode, "protected-overflow");
	assert.equal(hasMarker(selection.messages, "large old result"), false);
	assert.match(marker(selection.messages[0]), /"historyId":"raw-turn-id"/);
	assert.match(marker(selection.messages[0]), /"toolCallId":"old-call"/);
	assert.match(marker(selection.messages[0]), /Tool name: distinctive-tool\./);
	assert.match(marker(selection.messages[0]), /"offset":0/);
	assert.match(marker(selection.messages[0]), /"limit":2000/);
	assert.ok(marker(selection.messages[0]).includes(
		"read_context_output({\"historyId\":\"raw-turn-id\",\"source\":\"toolResult\",\"toolCallId\":\"old-call\",\"offset\":0,\"limit\":2000})",
	));
});

test("recovers an unread protected result above the actual model limit without mutation", () => {
	const hugeAssistant = toolAssistant(toolCall("huge-call"));
	const hugeResult = result("huge-call", repeat("huge protected result", 300_000));
	const messages = [user("active request"), hugeAssistant, hugeResult];
	const canonicalBefore = structuredClone(messages);
	const rawResult = structuredClone(hugeResult);
	const rawHistoryItems: HistoryItem[] = [{
		id: "raw-huge-turn",
		kind: "modelTurn",
		sequence: 0,
		timestamp: "2026-09-21T00:00:00.000Z",
		assistantMessage: hugeAssistant as any,
		toolResults: [rawResult] as any,
		metadata: { tools: ["read"], files: [], failed: false },
	}];
	const rawBefore = structuredClone(rawHistoryItems);

	const recovered = selectContext({
		messages: messages as any,
		systemPrompt: "resident prompt",
		activeTools: [],
		modelContextWindow: 70_000,
		tokenBudget: LEGACY_TEST_TOKEN_BUDGET,
		rawHistoryItems,
	});
	const recoveredResult = recovered.messages.find((message: any) => message.role === "toolResult") as any;

	assert.equal(recovered.mode, "recovery");
	assert.ok(recovered.estimatedTokens <= 70_000);
	assert.equal(recovered.messages.some((message: any) => message.role === "assistant" && message.content.some((block: any) => block.id === "huge-call")), true);
	assert.equal(recoveredResult.toolCallId, "huge-call");
	assert.equal(recoveredResult.toolName, "read");
	assert.match(marker(recoveredResult), /read_context_output/);
	assert.match(marker(recoveredResult), /"historyId":"raw-huge-turn"/);
	assert.match(marker(recovered.messages[0]), /payloads were replaced with recovery references/);
	assert.match(marker(recovered.messages[0]), /read_context_output/);
	assert.ok(marker(recovered.messages[0]).startsWith("[Context paging notice — generated by the extension]"));
	assert.doesNotMatch(marker(recovered.messages[0]), /present in full for this follow-up call/);
	assert.ok(marker(recoveredResult).includes(
		"read_context_output({\"historyId\":\"raw-huge-turn\",\"source\":\"toolResult\",\"toolCallId\":\"huge-call\",\"offset\":0,\"limit\":2000})",
	));
	assert.equal(
		recovered.estimatedTokens,
		estimateTokens(user("resident prompt"))
			+ estimateTokens(user(JSON.stringify([])))
			+ recovered.messages.reduce((total, message) => total + estimateTokens(message as any), 0),
	);
	assert.deepEqual(messages, canonicalBefore);
	assert.deepEqual(rawHistoryItems, rawBefore);
});

test("reports invalid model windows and resident or active request overflows as estimates", () => {
	for (const modelContextWindow of [0, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
		assert.throws(
			() => selectContext({
				messages: [], systemPrompt: "resident", activeTools: [], modelContextWindow,
				tokenBudget: LEGACY_TEST_TOKEN_BUDGET,
			}),
			(error: unknown) => error instanceof ContextSelectionError
				&& error.code === "INVALID_MODEL_CONTEXT" && /estimate/i.test(error.message),
		);
	}
	assert.throws(
		() => selectContext({
			messages: [], systemPrompt: "x".repeat(300_000), activeTools: [], modelContextWindow: 64_000,
			tokenBudget: LEGACY_TEST_TOKEN_BUDGET,
		}),
		(error: unknown) => error instanceof ContextSelectionError
			&& error.code === "RESIDENT_INPUT_TOO_LARGE" && /estimate/i.test(error.message),
	);
	assert.throws(
		() => selectContext({
			messages: [user("x".repeat(300_000))] as any, systemPrompt: "resident", activeTools: [], modelContextWindow: 64_000,
			tokenBudget: LEGACY_TEST_TOKEN_BUDGET,
		}),
		(error: unknown) => error instanceof ContextSelectionError
			&& error.code === "ACTIVE_REQUEST_TOO_LARGE" && /estimate/i.test(error.message),
	);
});
