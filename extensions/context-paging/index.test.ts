import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import contextPagingExtension, { resolveContextPagingEnabled } from "./index.ts";

type Handler = (event: any, ctx: any) => unknown;
type RegisteredTool = {
	name: string;
	description: string;
	parameters: unknown;
	execute: (...args: any[]) => unknown;
};

type HarnessOptions = {
	trusted?: boolean;
	projectSetting?: unknown | "invalid-json";
	contextWindow?: number;
	activeTools?: string[];
	residentTools?: Array<{ name: string; description: string; parameters: unknown }>;
};

const timestamp = "2026-09-21T00:00:00.000Z";
const agentDir = await mkdtemp(join(tmpdir(), "context-paging-agent-test-"));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ contextPaging: { enabled: true } }));
process.env.PI_CODING_AGENT_DIR = agentDir;

function userEntry(id: string, content: string) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: { role: "user", content, timestamp: 1 },
	};
}

function assistantEntry(id: string, content: string) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: content }],
			stopReason: "stop",
			timestamp: 2,
		},
	};
}

function orphanToolResult(id = "orphan") {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: {
			role: "toolResult",
			toolCallId: "missing-call",
			toolName: "read",
			content: [{ type: "text", text: "orphan" }],
			isError: false,
			timestamp: 3,
		},
	};
}

async function createHarness(options: HarnessOptions = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "context-paging-test-"));
	if (options.projectSetting !== undefined) {
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			options.projectSetting === "invalid-json"
				? "{ invalid"
				: JSON.stringify(options.projectSetting),
		);
	}

	let branch: any[] = [];
	let model = options.contextWindow === undefined
		? { contextWindow: 100_000 }
		: { contextWindow: options.contextWindow };
	const handlers = new Map<string, Handler>();
	const tools: RegisteredTool[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	let abortCalls = 0;
	let appendCalls = 0;
	const residentTools = options.residentTools ?? [];
	const activeTools = options.activeTools ?? [];

	const pi = {
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		getActiveTools: () => activeTools,
		getAllTools: () => [
			...residentTools,
			...tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
		],
		appendEntry: () => {
			appendCalls++;
		},
	};
	const ctx = {
		cwd,
		isProjectTrusted: () => options.trusted ?? true,
		sessionManager: { getBranch: () => branch },
		getSystemPrompt: () => "resident prompt",
		get model() {
			return model;
		},
		abort: () => {
			abortCalls++;
		},
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
	};
	contextPagingExtension(pi as any);

	return {
		ctx,
		handlers,
		tools,
		notifications,
		setBranch: (next: any[]) => {
			branch = next;
		},
		setModel: (next: any) => {
			model = next;
		},
		abortCalls: () => abortCalls,
		appendCalls: () => appendCalls,
	};
}

async function emit(harness: Awaited<ReturnType<typeof createHarness>>, event: string, payload: object = {}) {
	const handler = harness.handlers.get(event);
	assert.ok(handler, `missing ${event} handler`);
	return await handler({ type: event, ...payload }, harness.ctx);
}

async function executeTool(
	harness: Awaited<ReturnType<typeof createHarness>>,
	name: string,
	input: Record<string, unknown>,
) {
	const tool = harness.tools.find((candidate) => candidate.name === name);
	assert.ok(tool, `missing ${name} tool`);
	return await tool.execute("call", input, new AbortController().signal, () => {}, harness.ctx);
}

function resultDetails(result: unknown): any {
	return (result as { details: unknown }).details;
}

async function start(harness: Awaited<ReturnType<typeof createHarness>>, reason = "startup") {
	await emit(harness, "session_start", { reason });
}

test("resolves global, trusted-project, invalid, and default settings precedence", () => {
	assert.equal(resolveContextPagingEnabled({ globalSettings: {}, projectTrusted: false }), true);
	assert.equal(resolveContextPagingEnabled({
		globalSettings: { contextPaging: { enabled: false } },
		projectTrusted: false,
	}), false);
	assert.equal(resolveContextPagingEnabled({
		globalSettings: { contextPaging: { enabled: true } },
		projectSettings: { contextPaging: { enabled: false } },
		projectTrusted: true,
	}), false);
	assert.equal(resolveContextPagingEnabled({
		globalSettings: { contextPaging: { enabled: true } },
		projectSettings: { contextPaging: { enabled: false } },
		projectTrusted: false,
	}), true);
	assert.equal(resolveContextPagingEnabled({
		globalSettings: { contextPaging: { enabled: false } },
		projectSettings: { contextPaging: { enabled: "yes" } },
		projectTrusted: true,
	}), false);
});

test("registers all tools and required lifecycle hooks without blocking tree navigation", async () => {
	const harness = await createHarness({
		projectSetting: { contextPaging: { enabled: false } },
	});
	assert.deepEqual(harness.tools.map((tool) => tool.name), [
		"search_history",
		"browse_history",
		"load_history",
		"read_context_output",
	]);
	assert.deepEqual([...harness.handlers.keys()].sort(), [
		"context",
		"session_before_compact",
		"session_start",
		"session_tree",
		"turn_end",
	]);
	assert.equal(harness.handlers.has("session_before_tree"), false);
});

test("all session-start reasons restore the navigator from only the active raw branch", async () => {
	const harness = await createHarness({ projectSetting: { contextPaging: { enabled: true } } });
	let previousMarker: string | undefined;
	for (const reason of ["startup", "new", "resume", "fork", "reload"]) {
		const marker = `${reason}-unique-marker`;
		harness.setBranch([userEntry(`${reason}-user`, marker)]);
		await start(harness, reason);
		const found = resultDetails(await executeTool(harness, "search_history", { query: marker }));
		assert.deepEqual(found.references.map((reference: any) => reference.historyId), [`${reason}-user`]);
		if (previousMarker !== undefined) {
			const previous = resultDetails(await executeTool(harness, "search_history", { query: previousMarker }));
			assert.deepEqual(previous.references, []);
		}
		previousMarker = marker;
	}
});

test("turn, tree, and tool snapshots rebuild references for the replacement branch", async () => {
	const harness = await createHarness({ projectSetting: { contextPaging: { enabled: true } } });
	harness.setBranch([userEntry("old", "old-marker")]);
	await start(harness);

	harness.setBranch([userEntry("turn-new", "turn-marker")]);
	await emit(harness, "turn_end");
	assert.deepEqual(
		resultDetails(await executeTool(harness, "browse_history", { direction: "forward" })).references
			.map((reference: any) => [reference.historyId, reference.sequence]),
		[["turn-new", 0]],
	);

	harness.setBranch([userEntry("tree-a", "tree-marker-a"), userEntry("tree-b", "tree-marker-b")]);
	await emit(harness, "session_tree");
	assert.deepEqual(
		resultDetails(await executeTool(harness, "browse_history", { direction: "forward", count: 10 })).references
			.map((reference: any) => [reference.historyId, reference.sequence]),
		[["tree-a", 0], ["tree-b", 1]],
	);
	assert.deepEqual(
		resultDetails(await executeTool(harness, "search_history", { query: "old-marker" })).references,
		[],
	);

	harness.setBranch([userEntry("tool-fresh", "fresh-tool-marker")]);
	const fresh = resultDetails(await executeTool(harness, "search_history", { query: "fresh-tool-marker" }));
	assert.deepEqual(fresh.references.map((reference: any) => reference.historyId), ["tool-fresh"]);
});

test("context selection always projects a fresh raw branch", async () => {
	const harness = await createHarness({ projectSetting: { contextPaging: { enabled: true } } });
	harness.setBranch([userEntry("old", "old context")]);
	await start(harness);
	const freshMessage = userEntry("fresh", "fresh context").message;
	harness.setBranch([userEntry("fresh", "fresh context")]);

	const result = await emit(harness, "context", { messages: [{ role: "user", content: "stale event" }] });
	assert.deepEqual(result, { messages: [freshMessage] });
});

test("disabled mode is a no-op for context and compaction while tools fail clearly", async () => {
	const harness = await createHarness({ projectSetting: { contextPaging: { enabled: false } } });
	harness.setBranch([userEntry("disabled", "disabled marker")]);
	await start(harness);
	const incoming = [{ role: "user", content: "incoming" }];

	assert.equal(await emit(harness, "context", { messages: incoming }), undefined);
	assert.equal(await emit(harness, "session_before_compact"), undefined);
	assert.equal(harness.abortCalls(), 0);
	assert.equal(harness.notifications.length, 0);
	const toolInputs: Record<string, Record<string, unknown>> = {
		search_history: { query: "disabled" },
		browse_history: { direction: "forward" },
		load_history: { historyIds: ["disabled"] },
		read_context_output: { historyId: "disabled", source: "assistant", contentIndex: 0 },
	};
	for (const tool of harness.tools) {
		await assert.rejects(
			() => executeTool(harness, tool.name, toolInputs[tool.name]),
			/Context paging is disabled by contextPaging.enabled/,
		);
	}
});

test("an untrusted or malformed project setting cannot disable the global default", async () => {
	for (const projectSetting of [{ contextPaging: { enabled: false } }, "invalid-json" as const]) {
		const harness = await createHarness({ trusted: projectSetting === "invalid-json", projectSetting });
		harness.setBranch([userEntry("enabled", "enabled marker")]);
		await start(harness);
		const result = await emit(harness, "context", { messages: [] });
		assert.deepEqual((result as any).messages.map((message: any) => message.content), ["enabled marker"]);
	}
});

test("only active tools with resident definitions consume the context budget", async () => {
	const harness = await createHarness({
		projectSetting: { contextPaging: { enabled: true } },
		contextWindow: 2_000,
		activeTools: ["small", "missing-definition"],
		residentTools: [
			{ name: "small", description: "small", parameters: { type: "object" } },
			{ name: "inactive-huge", description: "x".repeat(10_000), parameters: { type: "object" } },
		],
	});
	harness.setBranch([userEntry("active", "active resident definitions")]);
	await start(harness);

	const result = await emit(harness, "context", { messages: [] });
	assert.deepEqual((result as any).messages.map((message: any) => message.content), ["active resident definitions"]);
	assert.equal(harness.abortCalls(), 0);
});

test("budget failures abort once, notify, retain incoming messages, and append nothing", async () => {
	for (const model of [undefined, { contextWindow: 0 }, { contextWindow: 20 }]) {
		const harness = await createHarness({ projectSetting: { contextPaging: { enabled: true } } });
		harness.setBranch([userEntry("required", "mandatory user request")]);
		await start(harness);
		harness.setModel(model);
		const incoming = [{ role: "user", content: "incoming fallback" }];

		const result = await emit(harness, "context", { messages: incoming });
		assert.deepEqual(result, { messages: incoming });
		assert.equal(harness.abortCalls(), 1);
		assert.equal(harness.appendCalls(), 0);
		assert.equal(harness.notifications.length, 1);
		assert.equal(harness.notifications[0].level, "error");
		assert.match(harness.notifications[0].message, /^Context paging aborted this provider turn:/);
	}
});

test("projection failures fail closed in context and report lifecycle rebuild errors", async () => {
	const harness = await createHarness({ projectSetting: { contextPaging: { enabled: true } } });
	harness.setBranch([userEntry("valid", "valid")]);
	await start(harness);
	harness.setBranch([orphanToolResult()]);
	const incoming = [{ role: "user", content: "incoming fallback" }];

	assert.deepEqual(await emit(harness, "context", { messages: incoming }), { messages: incoming });
	assert.equal(harness.abortCalls(), 1);
	assert.equal(harness.appendCalls(), 0);
	assert.match(harness.notifications.at(-1)!.message, /ORPHAN_TOOL_RESULT/);
	assert.equal(harness.notifications.at(-1)!.level, "error");

	const noticesBefore = harness.notifications.length;
	await emit(harness, "turn_end");
	await emit(harness, "session_tree");
	assert.equal(harness.notifications.length, noticesBefore + 2);
	for (const notice of harness.notifications.slice(-2)) {
		assert.match(notice.message, /ORPHAN_TOOL_RESULT/);
		assert.equal(notice.level, "error");
	}
});

test("enabled compaction is cancelled with a raw-history warning", async () => {
	const harness = await createHarness({ projectSetting: { contextPaging: { enabled: true } } });
	await start(harness);

	assert.deepEqual(await emit(harness, "session_before_compact"), { cancel: true });
	assert.deepEqual(harness.notifications.at(-1), {
		message: "Context paging kept raw history and cancelled compaction.",
		level: "warning",
	});
});
