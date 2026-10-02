import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import contextPagingExtension, { resolveContextPagingSettings } from "./index.ts";
import { HistoryNavigator } from "./navigator.ts";

type Handler = (event: any, ctx: any) => unknown;

type Settings = {
	globalSettings: unknown;
	projectSettings?: unknown;
	projectTrusted: boolean;
};

const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 });
const custom = (content: string) => ({
	role: "custom" as const,
	customType: "test-request",
	content,
	display: true,
	timestamp: 0,
});
const assistant = (text: string, usage?: object, stopReason = "stop") => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
	usage,
	stopReason,
});
const toolAssistant = (id: string, name = "read") => ({
	role: "assistant" as const,
	content: [{ type: "toolCall" as const, id, name, arguments: { path: "src/file.ts" } }],
	timestamp: 0,
});
const result = (toolCallId: string, text: string) => ({
	role: "toolResult" as const,
	toolCallId,
	toolName: "read",
	content: [{ type: "text" as const, text }],
	isError: false,
	timestamp: 0,
});
const entry = (id: string, message: object) => ({
	id,
	type: "message" as const,
	timestamp: "2026-09-21T00:00:00.000Z",
	message,
});
const branchFor = (reason: string) => [entry(`user-${reason}`, user(reason))];
const marker = (message: any) => typeof message.content === "string"
	? message.content
	: message.content?.map((block: any) => block.text ?? "").join("") ?? "";
const hasMarker = (messages: readonly object[], value: string) => messages.some((message) => marker(message).includes(value));
const statusTokens = (usage: number, suffix: readonly object[]) =>
	usage + suffix.reduce((sum, message) => sum + estimateTokens(message as any), 0);

function createHarness(settings: Settings | null = { globalSettings: {}, projectTrusted: false }) {
	const handlers = new Map<string, Handler>();
	const tools: any[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	let branch = branchFor("initial");
	let branchReads = 0;
	let branchError: Error | undefined;
	let projectedMessages: object[] | undefined;
	let aborts = 0;
	let appends = 0;
	let contextUsage: unknown;
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		registerTool(tool: any) { tools.push(tool); },
		appendEntry() { appends++; },
		getActiveTools: () => ["small", "missing"],
		getAllTools: () => [
			{ name: "small", description: "small active tool", parameters: { type: "object" } },
			{ name: "large-inactive", description: "x".repeat(300_000), parameters: { type: "object" } },
		],
	};
	const ctx = {
		sessionManager: {
			getBranch: () => {
				branchReads++;
				if (branchError) throw branchError;
				return branch;
			},
			buildSessionProjection: () => ({
				messages: projectedMessages ?? branch.flatMap((item: any) =>
					item.type === "message" ? [item.message] : []),
			}),
		},
		getSystemPrompt: () => "system",
		getContextUsage: () => contextUsage,
		isProjectTrusted: () => false,
		model: { contextWindow: 64_000 },
		ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
		abort: () => { aborts++; },
	};
	contextPagingExtension(pi as any, settings ?? undefined);
	return {
		handlers,
		tools,
		ctx,
		notifications,
		branch: () => branch,
		setBranch: (next: typeof branch) => { branch = next; branchError = undefined; },
		setBranchError: (error: Error) => { branchError = error; },
		setProjectedMessages: (next: object[] | undefined) => { projectedMessages = next; },
		branchReads: () => branchReads,
		resetBranchReads: () => { branchReads = 0; },
		abortCalls: () => aborts,
		appendCalls: () => appends,
		setContextUsage: (next: unknown) => { contextUsage = next; },
	};
}

async function emit(harness: ReturnType<typeof createHarness>, name: string, event: any) {
	return await harness.handlers.get(name)?.(event, harness.ctx);
}

async function searchIds(harness: ReturnType<typeof createHarness>, query: string) {
	const search = harness.tools.find((tool) => tool.name === "search_history");
	const response = await search.execute("call", { query }, undefined, undefined, harness.ctx);
	return response.details.references.map((reference: { historyId: string }) => reference.historyId);
}

test("resolves enabled setting precedence", () => {
	assert.equal(resolveContextPagingSettings({
		globalSettings: {},
		projectTrusted: false,
	}).enabled, true);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { enabled: false } },
		projectTrusted: false,
	}).enabled, false);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { enabled: false } },
		projectSettings: { contextPaging: { enabled: true } },
		projectTrusted: true,
	}).enabled, true);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { enabled: false } },
		projectSettings: { contextPaging: { enabled: true } },
		projectTrusted: false,
	}).enabled, false);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { enabled: true } },
		projectSettings: { contextPaging: { enabled: "yes" } },
		projectTrusted: true,
	}).enabled, true);
});

test("resolves valid token budgets by trusted source precedence", () => {
	assert.equal(resolveContextPagingSettings({
		globalSettings: {},
		projectTrusted: false,
	}).tokenBudget, 128_000);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { tokenBudget: 96_000 } },
		projectTrusted: false,
	}).tokenBudget, 96_000);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { tokenBudget: 96_000 } },
		projectSettings: { contextPaging: { tokenBudget: 72_000 } },
		projectTrusted: true,
	}).tokenBudget, 72_000);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { tokenBudget: 96_000 } },
		projectSettings: { contextPaging: { tokenBudget: 72_000 } },
		projectTrusted: false,
	}).tokenBudget, 96_000);
});

test("falls through invalid token budgets without throwing", () => {
	for (const tokenBudget of [
		0,
		-1,
		1.5,
		"128000",
		[],
		{},
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
	]) {
		assert.equal(resolveContextPagingSettings({
			globalSettings: { contextPaging: { tokenBudget } },
			projectTrusted: false,
		}).tokenBudget, 128_000);
	}

	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { tokenBudget: 96_000 } },
		projectSettings: { contextPaging: { tokenBudget: "invalid" } },
		projectTrusted: true,
	}).tokenBudget, 96_000);
});

test("registers only paging lifecycle handlers", () => {
	const harness = createHarness();
	assert.equal(harness.tools.length, 4);
	assert.deepEqual([...harness.handlers.keys()].sort(), [
		"context",
		"model_select",
		"session_before_compact",
		"session_compact",
		"session_start",
		"session_tree",
		"turn_end",
	]);
	assert.equal(harness.handlers.has("session_before_tree"), false);
});

test("refreshes navigation history for session lifecycle changes without cancelling tree navigation", async () => {
	const harness = createHarness();
	for (const reason of ["startup", "new", "resume", "fork", "reload"] as const) {
		harness.setBranch(branchFor(reason));
		harness.resetBranchReads();
		await emit(harness, "session_start", { reason });
		assert.equal(harness.branchReads(), 1);
		assert.deepEqual(await searchIds(harness, reason), [`user-${reason}`]);
	}

	harness.setBranch(branchFor("turn-end"));
	harness.resetBranchReads();
	await emit(harness, "turn_end", {});
	assert.equal(harness.branchReads(), 1);
	assert.deepEqual(await searchIds(harness, "turn-end"), ["user-turn-end"]);

	harness.setBranch(branchFor("old-tree"));
	harness.resetBranchReads();
	await emit(harness, "session_start", { reason: "startup" });
	assert.equal(harness.branchReads(), 1);
	assert.deepEqual(await searchIds(harness, "old-tree"), ["user-old-tree"]);
	harness.setBranch(branchFor("tree"));
	harness.resetBranchReads();
	assert.equal(await emit(harness, "session_tree", {}), undefined);
	assert.equal(harness.branchReads(), 1);
	assert.deepEqual(await searchIds(harness, "old-tree"), []);
	assert.deepEqual(await searchIds(harness, "tree"), ["user-tree"]);

	harness.setBranchError(new Error("LIFECYCLE_PROJECTION_FAILURE"));
	harness.resetBranchReads();
	await emit(harness, "turn_end", {});
	assert.equal(harness.branchReads(), 1);
	assert.match(harness.notifications.at(-1)?.message ?? "", /LIFECYCLE_PROJECTION_FAILURE/);
	harness.setBranch(branchFor("after-failure"));
	const canonicalMessages = [user("CANONICAL_AFTER_LIFECYCLE_FAILURE")];
	assert.deepEqual(await emit(harness, "context", { messages: canonicalMessages }), {
		messages: canonicalMessages,
	});
	assert.equal(harness.abortCalls(), 0);
});

test("selects canonical context and isolates raw-history failures", async () => {
	const harness = createHarness();
	const canonicalMessages = [user("CANONICAL_ONLY")];
	harness.setBranch([entry("raw", user("RAW_ONLY"))]);
	const canonical = await emit(harness, "context", { messages: canonicalMessages });
	assert.equal(hasMarker((canonical as any).messages, "CANONICAL_ONLY"), true);
	assert.equal(hasMarker((canonical as any).messages, "RAW_ONLY"), false);
	assert.deepEqual(canonical, { messages: canonicalMessages });
	assert.equal((canonical as any).messages, canonicalMessages);
	assert.equal((canonical as any).messages[0], canonicalMessages[0]);

	harness.setBranch([entry("orphan", result("missing", "ORPHAN_TOOL_RESULT"))]);
	assert.deepEqual(await emit(harness, "context", { messages: canonicalMessages }), {
		messages: canonicalMessages,
	});
	assert.equal(harness.abortCalls(), 0);
	assert.match(harness.notifications.at(-1)?.message ?? "", /ORPHAN_TOOL_RESULT/);

	const malformed = [result("orphan", "bad")];
	const malformedResult = await emit(harness, "context", { messages: malformed }) as any;
	assert.deepEqual(malformedResult, { messages: malformed });
	assert.equal(malformedResult.messages, malformed);
	assert.equal(malformedResult.messages[0], malformed[0]);
	assert.equal(harness.abortCalls(), 1);
	assert.match(harness.notifications.at(-1)?.message ?? "", /aborted this provider call/i);
});

test("uses a tracked measured anchor when raw history returns after paging", async () => {
	const harness = createHarness({
		globalSettings: { contextPaging: { enabled: true, tokenBudget: 64_000 } },
		projectTrusted: false,
	});
	const old = user(`OLD_RAW_HISTORY ${"x".repeat(300_000)}`);
	const active = user("ACTIVE_REQUEST");
	const first = await emit(harness, "context", { messages: [old, active] }) as any;
	assert.equal(hasMarker(first.messages, "OLD_RAW_HISTORY"), false);

	const response = assistant("MODEL_RESPONSE", { totalTokens: 50_000 });
	const next = user("NEXT_REQUEST");
	harness.setBranch([entry("old", old), entry("active", active), entry("response", response), entry("next", next)]);
	await emit(harness, "turn_end", { message: response });
	harness.setContextUsage({ tokens: statusTokens(50_000, [next]), contextWindow: 64_000, percent: 78 });
	const second = await emit(harness, "context", { messages: [old, active, response, next] }) as any;

	assert.equal(hasMarker(second.messages, "OLD_RAW_HISTORY"), false);
	assert.equal(hasMarker(second.messages, "ACTIVE_REQUEST"), true);
	assert.equal(hasMarker(second.messages, "NEXT_REQUEST"), true);
});

test("keeps persistent requests, outgoing instructions, and protected tool continuations", async () => {
	const harness = createHarness({
		globalSettings: { contextPaging: { enabled: true, tokenBudget: 300 } },
		projectTrusted: false,
	});
	const old = user(`OLD ${"x".repeat(2_000)}`);
	const actual = user(`ACTUAL ${"x".repeat(800)}`);
	const call = toolAssistant("protected-call");
	const toolResult = result("protected-call", `PROTECTED_RESULT ${"x".repeat(800)}`);
	const injected = user("outgoing extension instruction");
	harness.setBranch([
		entry("old", old),
		entry("actual", actual),
		entry("call", call),
		entry("result", toolResult),
	]);
	const selection = await emit(harness, "context", { messages: [old, actual, call, toolResult, injected] }) as any;

	assert.equal(hasMarker(selection.messages, "OLD"), false);
	assert.equal(hasMarker(selection.messages, "ACTUAL"), true);
	assert.equal(hasMarker(selection.messages, "PROTECTED_RESULT"), true);
	assert.equal(hasMarker(selection.messages, "outgoing extension instruction"), true);
	assert.equal(harness.abortCalls(), 0);
});

test("uses measured anchors across repeated paged requests with a protected tool continuation", async () => {
	const harness = createHarness({
		globalSettings: { contextPaging: { enabled: true, tokenBudget: 400 } },
		projectTrusted: false,
	});
	const old = user(`OLD_RESTORED ${"x".repeat(2_000)}`);
	const requestA = user("REQUEST_A");
	const instructionA = user("OUTGOING_A");
	harness.setBranch([entry("old", old), entry("request-a", requestA)]);
	const selectedA = await emit(harness, "context", { messages: [old, requestA, instructionA] }) as any;
	assert.equal(hasMarker(selectedA.messages, "OLD_RESTORED"), false);
	assert.equal(hasMarker(selectedA.messages, "OUTGOING_A"), true);
	assert.equal(selectedA.messages.filter((message: any) => marker(message).includes("Context paging notice")).length, 1);

	const responseA = assistant(`RESPONSE_A ${"y".repeat(2_000)}`, { input: 10, output: 10, cacheRead: 20, cacheWrite: 10 });
	const requestB = user("REQUEST_B");
	const callB = toolAssistant("request-b-call");
	const resultB = result("request-b-call", `RESULT_B ${"x".repeat(800)}`);
	const instructionB = user("OUTGOING_B");
	harness.setBranch([
		entry("old", old), entry("request-a", requestA), entry("response-a", responseA),
		entry("request-b", requestB), entry("call-b", callB), entry("result-b", resultB),
	]);
	await emit(harness, "turn_end", { message: responseA });
	harness.setContextUsage({ tokens: statusTokens(50, [requestB, callB, resultB]), contextWindow: 64_000, percent: 1 });
	const selectedB = await emit(harness, "context", { messages: [old, requestA, responseA, requestB, callB, resultB, instructionB] }) as any;
	assert.equal(hasMarker(selectedB.messages, "OLD_RESTORED"), false);
	assert.equal(hasMarker(selectedB.messages, "REQUEST_A"), true, "measured usage retains the previous request");
	assert.equal(hasMarker(selectedB.messages, "REQUEST_B"), true);
	assert.equal(hasMarker(selectedB.messages, "RESULT_B"), true);
	assert.equal(hasMarker(selectedB.messages, "OUTGOING_B"), true);
	assert.equal(selectedB.messages.filter((message: any) => marker(message).includes("Context paging notice")).length, 1);

	const responseB = assistant(`RESPONSE_B ${"z".repeat(2_000)}`, { input: 10, output: 10, cacheRead: 30, cacheWrite: 10 });
	const requestC = user("REQUEST_C");
	const instructionC = user("OUTGOING_C");
	harness.setBranch([...harness.branch(), entry("response-b", responseB), entry("request-c", requestC)]);
	await emit(harness, "turn_end", { message: responseB });
	harness.setContextUsage({ tokens: statusTokens(60, [requestC]), contextWindow: 64_000, percent: 1 });
	const selectedC = await emit(harness, "context", {
		messages: [old, requestA, responseA, requestB, callB, resultB, responseB, requestC, instructionC],
	}) as any;
	assert.equal(hasMarker(selectedC.messages, "OLD_RESTORED"), false);
	assert.equal(hasMarker(selectedC.messages, "RESULT_B"), true);
	assert.equal(hasMarker(selectedC.messages, "REQUEST_C"), true);
	assert.equal(hasMarker(selectedC.messages, "OUTGOING_C"), true);
	assert.equal(selectedC.messages.filter((message: any) => marker(message).includes("Context paging notice")).length, 1);

	const fallback = createHarness({
		globalSettings: { contextPaging: { enabled: true, tokenBudget: 400 } }, projectTrusted: false,
	});
	fallback.setBranch([
		entry("old", old), entry("request-a", requestA), entry("response-a", responseA),
		entry("request-b", requestB), entry("call-b", callB), entry("result-b", resultB),
	]);
	fallback.setContextUsage({ tokens: statusTokens(50, [requestB, callB, resultB]) });
	const fallbackB = await emit(fallback, "context", {
		messages: [old, requestA, responseA, requestB, callB, resultB, instructionB],
	}) as any;
	assert.equal(hasMarker(fallbackB.messages, "REQUEST_A"), false, "fallback must evict the marker measured B retains");
	assert.equal(hasMarker(fallbackB.messages, "REQUEST_B"), true);
	assert.equal(hasMarker(fallbackB.messages, "RESULT_B"), true);
	assert.equal(hasMarker(fallbackB.messages, "OUTGOING_B"), true);
	fallback.setBranch(harness.branch());
	fallback.setContextUsage({ tokens: statusTokens(60, [requestC]) });
	const fallbackC = await emit(fallback, "context", {
		messages: [old, requestA, responseA, requestB, callB, resultB, responseB, requestC, instructionC],
	}) as any;
	assert.equal(hasMarker(fallbackC.messages, "RESULT_B"), false, "fallback must evict the tool result measured C retains");
	assert.equal(hasMarker(fallbackC.messages, "REQUEST_C"), true);
	assert.equal(hasMarker(fallbackC.messages, "OUTGOING_C"), true);
	assert.equal(harness.abortCalls(), 0);
	assert.equal(fallback.abortCalls(), 0);
});

test("uses outgoing-only provenance for measured anchors and clears it after projection failure", async () => {
	const harness = createHarness({
		globalSettings: { contextPaging: { enabled: true, tokenBudget: 110 } },
		projectTrusted: false,
	});
	const actual = user(`ACTUAL_REQUEST ${"x".repeat(150)}`);
	const injected = user("outgoing extension instruction");
	harness.setBranch([entry("actual", actual)]);
	assert.equal(hasMarker((await emit(harness, "context", { messages: [actual, injected] }) as any).messages, "ACTUAL_REQUEST"), true);

	const response = assistant("MODEL_RESPONSE ".repeat(20), { totalTokens: 51 });
	harness.setBranch([entry("actual", actual), entry("response", response)]);
	await emit(harness, "turn_end", { message: response });
	const next = user("NEXT_REQUEST");
	const canonical = [actual, response, next];
	harness.setBranch([...harness.branch(), entry("next", next)]);
	harness.setContextUsage({ tokens: statusTokens(51, [next]), contextWindow: 64_000, percent: 1 });
	const measured = await emit(harness, "context", { messages: canonical }) as any;
	assert.equal(hasMarker(measured.messages, "ACTUAL_REQUEST"), true, "the outgoing instruction removal is calibrated");

	harness.setBranchError(new Error("PROJECTION_FAILURE"));
	const fallback = await emit(harness, "context", { messages: canonical }) as any;
	assert.equal(hasMarker(fallback.messages, "ACTUAL_REQUEST"), false, "unknown branch state must not reuse measured usage");
	assert.match(harness.notifications.at(-1)?.message ?? "", /PROJECTION_FAILURE/);
});

test("counts a persisted system/tool update once at the measured threshold for both outgoing shapes", async () => {
	for (const includeSystem of [false, true]) {
		const harness = createHarness({
			globalSettings: { contextPaging: { enabled: true, tokenBudget: 111 } }, projectTrusted: false,
		});
		const actual = user("ACTUAL_REQUEST");
		const response = assistant("answer", { totalTokens: 100 });
		const update = { role: "system", content: "s".repeat(24), toolsAdded: [{ name: "t" }] };
		const next = user("next");
		harness.setBranch([entry("actual", actual)]);
		await emit(harness, "context", { messages: [actual] });
		await emit(harness, "turn_end", { message: response });
		harness.setBranch([entry("actual", actual), entry("response", response), entry("update", update), entry("next", next)]);
		const oldSystem = harness.ctx.getSystemPrompt();
		harness.ctx.getSystemPrompt = () => oldSystem + "s".repeat(40);
		const status = statusTokens(100, [update, next]);
		assert.equal(status, 111);
		harness.setContextUsage({ tokens: status });
		const messages = includeSystem ? [actual, response, update, next] : [actual, response, next];
		const selected = await emit(harness, "context", { messages: structuredClone(messages) }) as any;
		assert.deepEqual(selected.messages, messages, `111-token request fits without paging (system metadata: ${includeSystem})`);
		assert.equal(hasMarker(selected.messages, "ACTUAL_REQUEST"), true);
		assert.equal(hasMarker(selected.messages, "next"), true);
		assert.equal(hasMarker(selected.messages, "Context paging notice"), false);
		assert.equal(harness.abortCalls(), 0);
	}
});

test("resumes measured accounting from projected compaction and context-edit messages", async () => {
	for (const type of ["compaction", "context_edit"] as const) {
		const harness = createHarness({
			globalSettings: { contextPaging: { enabled: true, tokenBudget: 110 } },
			projectTrusted: false,
		});
		const replaced = user(`REPLACED_${type} ${"x".repeat(1_000)}`);
		const summary = user(`PROJECTED_${type} ${"x".repeat(200)}`);
		const response = assistant(`RESPONSE_${type} ${"y".repeat(300)}`, { totalTokens: 50 });
		const next = user(`NEXT_${type}`);
		harness.setBranch([
			entry("replaced", replaced),
			{ id: type, type, timestamp: "2026-09-21T00:00:00.000Z" } as any,
		]);
		harness.setProjectedMessages([summary]);
		await emit(harness, "context", { messages: [summary] });
		harness.setBranch([...harness.branch(), entry("response", response), entry("next", next)]);
		harness.setProjectedMessages([summary, response, next]);
		await emit(harness, "turn_end", { message: response });
		harness.setContextUsage({ tokens: statusTokens(50, [next]), contextWindow: 64_000, percent: 1 });

		const selected = await emit(harness, "context", { messages: [summary, response, next] }) as any;
		assert.equal(hasMarker(selected.messages, `PROJECTED_${type}`), true, `${type} projection restores measured accounting`);
		assert.equal(hasMarker(selected.messages, `NEXT_${type}`), true);
		assert.equal(harness.abortCalls(), 0);
		await emit(harness, "model_select", {});
		const fallback = await emit(harness, "context", { messages: [summary, response, next] }) as any;
		assert.equal(hasMarker(fallback.messages, `PROJECTED_${type}`), false, `${type} fallback must evict the measured marker`);
		assert.equal(hasMarker(fallback.messages, `NEXT_${type}`), true);
		assert.equal(harness.abortCalls(), 0);
	}
});

test("clears independently re-established measured accounting for lifecycle changes", async () => {
	const invalidators: Array<[string, (harness: ReturnType<typeof createHarness>) => Promise<void>]> = [
		["session tree", (harness) => emit(harness, "session_tree", {}).then(() => undefined)],
		["model", (harness) => emit(harness, "model_select", {}).then(() => undefined)],
		["compaction", (harness) => emit(harness, "session_compact", {}).then(() => undefined)],
		["session", (harness) => emit(harness, "session_start", { reason: "new" }).then(() => undefined)],
		["manual compaction", (harness) => emit(harness, "session_before_compact", { reason: "manual" }).then(() => undefined)],
		["context edit", async (harness) => {
			harness.setBranch([
				...harness.branch(),
				{ id: "edit", type: "context_edit", timestamp: "2026-09-21T00:00:00.000Z" } as any,
			]);
		}],
	];

	for (const [name, invalidate] of invalidators) {
		const harness = createHarness({
			globalSettings: { contextPaging: { enabled: true, tokenBudget: 110 } },
			projectTrusted: false,
		});
		const anchored = user(`ANCHOR_${name} ${"x".repeat(180)}`);
		const response = assistant(`RESPONSE_${name} ${"y".repeat(150)}`, { totalTokens: 50 });
		const next = user(`NEXT_${name}`);
		harness.setBranch([entry("anchored", anchored)]);
		await emit(harness, "context", { messages: [anchored] });
		assert.equal(harness.abortCalls(), 0, `${name} establishes an anchor`);
		harness.setBranch([entry("anchored", anchored), entry("response", response), entry("next", next)]);
		harness.setProjectedMessages([anchored, response, next]);
		await emit(harness, "turn_end", { message: response });
		harness.setContextUsage({ tokens: statusTokens(50, [next]), contextWindow: 64_000, percent: 1 });

		const measured = await emit(harness, "context", { messages: [anchored, response, next] }) as any;
		assert.equal(harness.abortCalls(), 0, `${name} uses its measured anchor`);
		assert.equal(hasMarker(measured.messages, `ANCHOR_${name}`), true, `${name} begins on the measured path`);
		await invalidate(harness);
		const fallback = await emit(harness, "context", { messages: [anchored, response, next] }) as any;
		assert.equal(hasMarker(fallback.messages, `ANCHOR_${name}`), false, `${name} falls back after invalidation`);
	}
});

test("fails closed when session settings cannot be parsed", async () => {
	const previousHome = process.env.HOME;
	const home = await mkdtemp(join(tmpdir(), "context-paging-settings-"));
	try {
		process.env.HOME = home;
		const agentDirectory = join(home, ".pi", "agent");
		const settingsPath = join(agentDirectory, "settings.json");
		await mkdir(agentDirectory, { recursive: true });
		await writeFile(settingsPath, JSON.stringify({ contextPaging: { enabled: true } }));
		const harness = createHarness(null);
		await emit(harness, "session_start", { reason: "startup" });
		assert.deepEqual(await emit(harness, "session_before_compact", { reason: "threshold" }), { cancel: true });

		await writeFile(settingsPath, "{");
		await assert.rejects(() => emit(harness, "session_start", { reason: "reload" }), SyntaxError);
		assert.equal(await emit(harness, "context", { messages: [user("unchanged")] }), undefined);
		assert.equal(await emit(harness, "session_before_compact", { reason: "threshold" }), undefined);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await rm(home, { recursive: true, force: true });
	}
});

test("does not rebuild the navigator during a context event", async () => {
	const harness = createHarness();
	const originalRebuild = HistoryNavigator.prototype.rebuild;
	let rebuilds = 0;
	HistoryNavigator.prototype.rebuild = function (items) {
		rebuilds++;
		return originalRebuild.call(this, items);
	};
	try {
		await emit(harness, "context", { messages: [user("canonical")] });
		assert.equal(rebuilds, 0);
	} finally {
		HistoryNavigator.prototype.rebuild = originalRebuild;
	}
});

test("refreshes lifecycle history and reuses navigation until visible history changes", async () => {
	const harness = createHarness();
	const originalRebuild = HistoryNavigator.prototype.rebuild;
	let rebuilds = 0;
	HistoryNavigator.prototype.rebuild = function (items) {
		rebuilds++;
		return originalRebuild.call(this, items);
	};
	try {
		harness.setBranch(branchFor("visible"));
		await emit(harness, "turn_end", {});
		assert.equal(rebuilds, 0);
		assert.deepEqual(await searchIds(harness, "visible"), ["user-visible"]);
		assert.equal(rebuilds, 1);
		assert.deepEqual(await searchIds(harness, "visible"), ["user-visible"]);
		assert.equal(rebuilds, 1);

		harness.setBranch([
			...branchFor("visible"),
			entry("paging-assistant", toolAssistant("paging-call", "search_history")),
			entry("paging-result", result("paging-call", "paging result")),
		]);
		await emit(harness, "turn_end", {});
		assert.equal(rebuilds, 1);
		assert.deepEqual(await searchIds(harness, "visible"), ["user-visible"]);
		assert.equal(rebuilds, 1);
		const read = harness.tools.find((tool) => tool.name === "read_context_output");
		const output = await read.execute("call", {
			historyId: "paging-assistant",
			source: "assistant",
			contentIndex: 0,
		}, undefined, undefined, harness.ctx);
		assert.match(output.details.text, /search_history/);

		harness.setBranch(branchFor("replacement"));
		await emit(harness, "session_tree", {});
		assert.equal(rebuilds, 1);
		assert.deepEqual(await searchIds(harness, "replacement"), ["user-replacement"]);
		assert.equal(rebuilds, 2);
	} finally {
		HistoryNavigator.prototype.rebuild = originalRebuild;
	}
});

test("does not abort custom requests and preserves their canonical role", async () => {
	const harness = createHarness();
	const customOnly = custom("CUSTOM_ONLY_REQUEST");
	const customOnlyResult = await emit(harness, "context", { messages: [customOnly] }) as any;
	assert.deepEqual(customOnlyResult.messages, [customOnly]);
	assert.equal(customOnlyResult.messages[0].role, "custom");
	assert.equal(harness.abortCalls(), 0);

	const completedUser = user("COMPLETED_USER_REQUEST");
	const completedAnswer = { role: "assistant" as const, content: [{ type: "text" as const, text: "COMPLETED_USER_ANSWER" }], timestamp: 0 };
	const customFollowUp = custom("CUSTOM_FOLLOW_UP_REQUEST");
	const toolCall = toolAssistant("custom-follow-up-call");
	const toolResult = result("custom-follow-up-call", "CUSTOM_TOOL_RESULT");
	const followUpResult = await emit(harness, "context", {
		messages: [completedUser, completedAnswer, customFollowUp, toolCall, toolResult],
	}) as any;

	assert.deepEqual(followUpResult.messages, [completedUser, completedAnswer, customFollowUp, toolCall, toolResult]);
	assert.equal(followUpResult.messages[2].role, "custom");
	assert.equal(followUpResult.messages[3].content[0].id, "custom-follow-up-call");
	assert.equal(followUpResult.messages[4].toolCallId, "custom-follow-up-call");
	assert.equal(harness.abortCalls(), 0);
});

test("does not mutate stored history and generates transient notices", async () => {
	const harness = createHarness({
		globalSettings: { contextPaging: { enabled: true, tokenBudget: 32_000 } },
		projectTrusted: false,
	});
	const canonicalMessages = [user(`old ${"x".repeat(300_000)}`), user("current")];
	const rawBefore = structuredClone(harness.branch());
	const canonicalBefore = structuredClone(canonicalMessages);
	const first = await emit(harness, "context", { messages: canonicalMessages }) as any;
	const second = await emit(harness, "context", { messages: canonicalMessages }) as any;
	assert.deepEqual(harness.branch(), rawBefore);
	assert.deepEqual(canonicalMessages, canonicalBefore);
	assert.equal(harness.abortCalls(), 0);
	assert.equal(harness.appendCalls(), 0);
	assert.equal(first.messages.filter((message: any) => marker(message).includes("Context paging notice")).length, 1);
	assert.equal(second.messages.filter((message: any) => marker(message).includes("Context paging notice")).length, 1);
	assert.match(marker(first.messages[0]), /Older context left the 32,000-token rolling window\./);
	assert.match(marker(second.messages[0]), /Older context left the 32,000-token rolling window\./);
	assert.equal(hasMarker(harness.branch().map((item: any) => item.message), "Context paging notice"), false);
});

test("cancels only automatic compaction and leaves disabled paging inert", async () => {
	const enabled = createHarness();
	assert.deepEqual(await emit(enabled, "session_before_compact", { reason: "threshold" }), { cancel: true });
	assert.deepEqual(await emit(enabled, "session_before_compact", { reason: "overflow" }), { cancel: true });
	assert.equal(await emit(enabled, "session_before_compact", { reason: "manual" }), undefined);

	const disabled = createHarness({ globalSettings: { contextPaging: { enabled: false } }, projectTrusted: false });
	for (const reason of ["threshold", "overflow", "manual"]) {
		assert.equal(await emit(disabled, "session_before_compact", { reason }), undefined);
	}
	const messages = [user("unchanged")];
	assert.equal(await emit(disabled, "context", { messages }), undefined);
});
