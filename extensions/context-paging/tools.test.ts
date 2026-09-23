import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HistoryItem } from "./history.ts";
import { HistoryNavigator } from "./navigator.ts";
import { registerContextPagingTools } from "./tools.ts";

type RegisteredTool = ToolDefinition;

function user(id: string, sequence: number, content: string): HistoryItem {
	return {
		id,
		kind: "user",
		sequence,
		timestamp: `2026-09-21T00:00:${String(sequence).padStart(2, "0")}.000Z`,
		userMessage: { role: "user", content, timestamp: sequence } as any,
	};
}

function turn(id: string, sequence: number, text: string): HistoryItem {
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
		metadata: { tools: [], files: [], failed: false },
	};
}

function registered(items: readonly HistoryItem[], enabled = true) {
	const tools: RegisteredTool[] = [];
	let snapshots = 0;
	const pi: Pick<ExtensionAPI, "registerTool"> = {
		registerTool(tool) { tools.push(tool); },
	};
	registerContextPagingTools(
		pi as ExtensionAPI,
		{
			isEnabled: () => enabled,
			snapshot: () => {
				snapshots++;
				return { allItems: items, navigator: new HistoryNavigator(items) };
			},
		},
	);
	return { tools, snapshotCount: () => snapshots };
}

function tool(tools: readonly RegisteredTool[], name: string): RegisteredTool {
	const found = tools.find((candidate) => candidate.name === name);
	assert.ok(found, `missing ${name}`);
	return found;
}

async function execute(registeredTool: RegisteredTool, params: unknown) {
	return registeredTool.execute("call-1", params, undefined, undefined, {} as ExtensionContext);
}

function details(result: { details?: unknown }): Record<string, unknown> {
	assert.ok(result.details && typeof result.details === "object");
	return result.details as Record<string, unknown>;
}

type SerializedSchema = {
	type?: unknown;
	additionalProperties?: unknown;
	properties: Record<string, unknown>;
};

function serializedSchema(schema: RegisteredTool["parameters"]): SerializedSchema {
	return JSON.parse(JSON.stringify(schema)) as SerializedSchema;
}

function detailItems(details: Record<string, unknown>): HistoryItem[] {
	assert.ok(Array.isArray(details.items));
	return details.items as HistoryItem[];
}

function detailReferences(details: Record<string, unknown>): Array<{ historyId: string }> {
	assert.ok(Array.isArray(details.references));
	return details.references as Array<{ historyId: string }>;
}

test("registers only the four strict recovery-tool schemas", () => {
	const { tools } = registered([user("u1", 0, "alpha")]);

	assert.deepEqual(tools.map((candidate) => candidate.name), [
		"search_history",
		"browse_history",
		"load_history",
		"read_context_output",
	]);
	assert.equal(tools.some((candidate) => candidate.name === "update_task_state"), false);

	for (const candidate of tools) {
		const schema = serializedSchema(candidate.parameters);
		assert.equal(schema.type, "object");
		assert.equal(schema.additionalProperties, false);
	}

	const search = serializedSchema(tool(tools, "search_history").parameters);
	const load = serializedSchema(tool(tools, "load_history").parameters);
	const output = serializedSchema(tool(tools, "read_context_output").parameters);
	assert.deepEqual(search.properties.limit, {
		minimum: 1,
		maximum: 10,
		default: 5,
		type: "integer",
	});
	assert.deepEqual(load.properties.historyIds, {
		minItems: 1,
		maxItems: 3,
		type: "array",
		items: { maxLength: 128, type: "string" },
	});
	assert.deepEqual(output.properties.limit, {
		minimum: 1,
		maximum: 2_000,
		default: 2_000,
		type: "integer",
	});
});

test("executes searches, browsing, and exact loads from one current snapshot", async () => {
	const items = [user("u1", 0, "alpha"), user("u2", 1, "alpha"), user("u3", 2, "alpha")];
	const registration = registered(items);
	const search = tool(registration.tools, "search_history");
	const browse = tool(registration.tools, "browse_history");
	const load = tool(registration.tools, "load_history");

	assert.deepEqual(detailReferences(details(await execute(search, { query: "alpha" })))
		.map((item: { historyId: string }) => item.historyId), ["u1", "u2", "u3"]);
	assert.deepEqual(detailItems(details(await execute(search, { query: "alpha", load: true })))
		.map((item: HistoryItem) => item.id), ["u1", "u2", "u3"]);
	assert.deepEqual(detailReferences(details(await execute(browse, { direction: "forward", count: 2 })))
		.map((item: { historyId: string }) => item.historyId), ["u1", "u2"]);
	assert.deepEqual(detailItems(details(await execute(load, { historyIds: ["u3", "u1"] })))
		.map((item: HistoryItem) => item.id), ["u3", "u1"]);
	await assert.rejects(() => execute(load, { historyIds: ["u1", "missing"] }), /Unknown history ID missing/);
	assert.equal(registration.snapshotCount(), 5);
});

test("returns no items when loading a search with no matches", async () => {
	const { tools } = registered([user("u1", 0, "alpha")]);
	const search = tool(tools, "search_history");

	assert.deepEqual(detailItems(details(await execute(search, { query: "missing", load: true }))), []);
});

test("limits compact replies but not exact loads", async () => {
	const large = turn("large", 0, "needle");
	if (large.kind === "modelTurn") {
		large.metadata.files = Array.from({ length: 50 }, (_, index) => `src/${index}-${"x".repeat(200)}.ts`);
	}
	const { tools } = registered([large]);
	const search = tool(tools, "search_history");
	const browse = tool(tools, "browse_history");
	const load = tool(tools, "load_history");

	await assert.rejects(() => execute(search, { query: "needle" }), /8,000/);
	await assert.rejects(() => execute(browse, { direction: "forward" }), /8,000/);
	const exact = await execute(load, { historyIds: ["large"] });
	assert.equal(JSON.stringify(details(exact)).length > 8_000, true);
});

test("reads exact output pages repeatedly through nextOffset", async () => {
	const output = turn("turn-1", 0, "a".repeat(3_000));
	const { tools } = registered([output]);
	const read = tool(tools, "read_context_output");

	const first = details(await execute(read, {
		historyId: "turn-1",
		source: "assistant",
		contentIndex: 0,
		limit: 2_000,
	}));
	const second = details(await execute(read, {
		historyId: "turn-1",
		source: "assistant",
		contentIndex: 0,
		offset: first.nextOffset,
		limit: 2_000,
	}));
	assert.equal(first.nextOffset, 2_000);
	assert.equal(second.offset, 2_000);
	assert.equal(second.nextOffset, null);
});

test("rejects disabled recovery tools before taking a snapshot", async () => {
	const registration = registered([user("u1", 0, "alpha")], false);
	const inputs: Record<string, unknown> = {
		search_history: { query: "alpha" },
		browse_history: { direction: "forward" },
		load_history: { historyIds: ["u1"] },
		read_context_output: { historyId: "u1", source: "assistant", contentIndex: 0 },
	};
	for (const registeredTool of registration.tools) {
		await assert.rejects(() => execute(registeredTool, inputs[registeredTool.name]), /disabled/i);
	}
	assert.equal(registration.snapshotCount(), 0);
});

test("describes recovery tools and repeated output reads", () => {
	const { tools } = registered([user("u1", 0, "alpha")]);
	for (const name of ["search_history", "browse_history", "load_history", "read_context_output"]) {
		assert.match(tool(tools, name).description, new RegExp(name));
	}
	assert.match(tool(tools, "read_context_output").description, /nextOffset.*repeat|repeat.*nextOffset/i);
});
