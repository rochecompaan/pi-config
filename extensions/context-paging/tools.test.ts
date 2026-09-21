import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryItem, ModelTurnHistoryItem } from "./history.ts";
import { HistoryNavigator } from "./navigator.ts";
import { registerContextPagingTools, type ContextPagingToolDependencies } from "./tools.ts";

type RegisteredTool = {
	name: string;
	description: string;
	promptGuidelines?: string[];
	parameters: Record<string, unknown>;
	execute: (...args: unknown[]) => unknown;
};

function userItem(id: string, sequence: number, content: string): HistoryItem {
	return {
		id,
		kind: "user",
		sequence,
		timestamp: `2026-09-21T00:00:${String(sequence).padStart(2, "0")}.000Z`,
		userMessage: { role: "user", content, timestamp: sequence } as any,
	};
}

function turnItem(id: string, sequence: number, content: string): ModelTurnHistoryItem {
	return {
		id,
		kind: "modelTurn",
		sequence,
		timestamp: `2026-09-21T00:01:${String(sequence).padStart(2, "0")}.000Z`,
		assistantMessage: {
			role: "assistant",
			content: [{ type: "text", text: content }],
			stopReason: "stop",
			timestamp: sequence,
		} as any,
		toolResults: [],
		metadata: { tools: [], files: [], failed: false },
	};
}

function createCatalog(items: readonly HistoryItem[], enabled = true) {
	const tools: RegisteredTool[] = [];
	let snapshotCalls = 0;
	const dependencies: ContextPagingToolDependencies = {
		isEnabled: () => enabled,
		snapshot: () => {
			snapshotCalls++;
			return { allItems: items, navigator: new HistoryNavigator(items) };
		},
	};
	registerContextPagingTools({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as any, dependencies);
	return { tools, snapshotCalls: () => snapshotCalls };
}

async function execute(tool: RegisteredTool, input: Record<string, unknown>) {
	return await tool.execute("call", input, new AbortController().signal, () => {}, {});
}

function details(result: unknown): Record<string, any> {
	return (result as { details: Record<string, any> }).details;
}

test("registers exactly four strict paging schemas with string enums", () => {
	const { tools } = createCatalog([]);
	assert.deepEqual(tools.map((tool) => tool.name), [
		"search_history",
		"browse_history",
		"load_history",
		"read_context_output",
	]);
	assert.equal(tools.some((tool) => tool.name === "update_task_state"), false);
	for (const tool of tools) {
		const schema = JSON.parse(JSON.stringify(tool.parameters));
		assert.equal(schema.type, "object", tool.name);
		assert.equal(schema.additionalProperties, false, tool.name);
		assert.match(tool.description, /Paging turns are absent/);
		assert.ok(tool.promptGuidelines?.some((guideline) => guideline.includes("Paging turns are absent")));
	}
	const browse = JSON.parse(JSON.stringify(tools.find((tool) => tool.name === "browse_history")!.parameters));
	const output = JSON.parse(JSON.stringify(tools.find((tool) => tool.name === "read_context_output")!.parameters));
	const search = JSON.parse(JSON.stringify(tools.find((tool) => tool.name === "search_history")!.parameters));
	const load = JSON.parse(JSON.stringify(tools.find((tool) => tool.name === "load_history")!.parameters));
	assert.deepEqual(browse.properties.direction, { type: "string", enum: ["backward", "forward", "around"] });
	assert.deepEqual(output.properties.source, { type: "string", enum: ["assistant", "toolResult"] });
	assert.deepEqual(search.properties.query.maxLength, 200);
	assert.deepEqual(search.properties.limit, { minimum: 1, maximum: 10, default: 5, type: "integer" });
	assert.deepEqual(browse.properties.sequence, { minimum: 0, maximum: 1_000_000, type: "integer" });
	assert.deepEqual(load.properties.historyIds, {
		minItems: 1,
		maxItems: 3,
		type: "array",
		items: { maxLength: 128, type: "string" },
	});
	assert.deepEqual(output.properties.limit, { minimum: 1, maximum: 2_000, default: 2_000, type: "integer" });
	assert.ok(output.properties.toolCallId);
	assert.ok(output.properties.contentIndex);
	assert.ok(tools.find((tool) => tool.name === "read_context_output")!.promptGuidelines?.some((guideline) => guideline.includes("nextOffset")));
});

test("search and browse return compact references from one fresh snapshot", async () => {
	const { tools, snapshotCalls } = createCatalog([
		userItem("u1", 0, "alpha first"),
		userItem("u2", 1, "alpha second"),
		userItem("u3", 2, "alpha third"),
		userItem("u4", 3, "alpha fourth"),
	]);
	const search = tools.find((tool) => tool.name === "search_history")!;
	const browse = tools.find((tool) => tool.name === "browse_history")!;

	assert.deepEqual(details(await execute(search, { query: "alpha" })).references.map((item: { historyId: string }) => item.historyId), ["u1", "u2", "u3", "u4"]);
	assert.deepEqual(details(await execute(browse, { direction: "forward", count: 3 })).references.map((item: { historyId: string }) => item.historyId), ["u1", "u2", "u3"]);
	assert.equal(snapshotCalls(), 2);
});

test("search loads at most its first three matches and exact loads preserve requested order", async () => {
	const { tools, snapshotCalls } = createCatalog([
		userItem("u1", 0, "alpha first"),
		userItem("u2", 1, "alpha second"),
		userItem("u3", 2, "alpha third"),
		userItem("u4", 3, "alpha fourth"),
	]);
	const search = tools.find((tool) => tool.name === "search_history")!;
	const load = tools.find((tool) => tool.name === "load_history")!;

	assert.deepEqual(details(await execute(search, { query: "alpha", load: true })).items.map((item: HistoryItem) => item.id), ["u1", "u2", "u3"]);
	assert.deepEqual(details(await execute(load, { historyIds: ["u3", "u1"] })).items.map((item: HistoryItem) => item.id), ["u3", "u1"]);
	await assert.rejects(() => execute(load, { historyIds: ["u1", "missing"] }), /Unknown history ID missing/);
	assert.equal(snapshotCalls(), 3);
});

test("search with load returns exact empty items when there are no matches", async () => {
	const { tools } = createCatalog([userItem("u1", 0, "alpha")]);
	const search = tools.find((tool) => tool.name === "search_history")!;

	assert.deepEqual(details(await execute(search, { query: "missing", load: true })).items, []);
});

test("compact replies fail over 8,000 characters while exact loads remain unbounded", async () => {
	const oversizedReference = userItem("reference", 0, "match");
	const oversizedTurn = turnItem("large", 1, "exact-match " + "x".repeat(9_000));
	const oversizedMetadata = turnItem("metadata", 2, "metadata-match");
	oversizedMetadata.metadata.tools = ["tool-" + "x".repeat(8_100)];
	const { tools } = createCatalog([oversizedReference, oversizedTurn, oversizedMetadata]);
	const search = tools.find((tool) => tool.name === "search_history")!;
	const browse = tools.find((tool) => tool.name === "browse_history")!;

	await assert.rejects(() => execute(browse, { direction: "around", count: 3 }), /RESPONSE_TOO_LARGE/);
	const loaded = await execute(search, { query: "exact-match", load: true });
	assert.equal(details(loaded).items[0].id, "large");
	assert.ok((loaded as any).content[0].text.length > 8_000);
});

test("reads repeated output pages from raw history", async () => {
	const source = turnItem("source", 0, "x".repeat(3_000));
	const { tools, snapshotCalls } = createCatalog([source]);
	const read = tools.find((tool) => tool.name === "read_context_output")!;

	const first = details(await execute(read, { historyId: "source", source: "assistant", contentIndex: 0 }));
	const second = details(await execute(read, {
		historyId: "source",
		source: "assistant",
		contentIndex: 0,
		offset: first.nextOffset,
	}));
	assert.equal(first.text + second.text, JSON.stringify(source.assistantMessage.content[0]));
	assert.equal(second.nextOffset, null);
	assert.equal(snapshotCalls(), 2);
});

test("disabled tools reject before taking a snapshot", async () => {
	const { tools, snapshotCalls } = createCatalog([userItem("u1", 0, "alpha")], false);
	const inputs: Record<string, Record<string, unknown>> = {
		search_history: { query: "alpha" },
		browse_history: { direction: "forward" },
		load_history: { historyIds: ["u1"] },
		read_context_output: { historyId: "u1", source: "assistant", contentIndex: 0 },
	};
	for (const tool of tools) {
		await assert.rejects(
			() => execute(tool, inputs[tool.name]),
			/Context paging is disabled by contextPaging.enabled\./,
		);
	}
	assert.equal(snapshotCalls(), 0);
});
