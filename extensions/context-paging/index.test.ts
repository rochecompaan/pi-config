import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
const toolAssistant = (id: string) => ({
	role: "assistant" as const,
	content: [{ type: "toolCall" as const, id, name: "read", arguments: { path: "src/file.ts" } }],
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

function createHarness(settings: Settings | null = { globalSettings: {}, projectTrusted: false }) {
	const handlers = new Map<string, Handler>();
	const tools: any[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	let branch = branchFor("initial");
	let branchReads = 0;
	let branchError: Error | undefined;
	let aborts = 0;
	let appends = 0;
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
		},
		getSystemPrompt: () => "system",
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
		branchReads: () => branchReads,
		resetBranchReads: () => { branchReads = 0; },
		abortCalls: () => aborts,
		appendCalls: () => appends,
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
		"session_before_compact",
		"session_start",
		"session_tree",
		"turn_end",
	]);
	assert.equal(harness.handlers.has("session_before_tree"), false);
});

test("rebuilds navigation for session lifecycle changes without cancelling tree navigation", async () => {
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
	assert.notEqual((canonical as any).messages, canonicalMessages);
	assert.notEqual((canonical as any).messages[0], canonicalMessages[0]);

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
