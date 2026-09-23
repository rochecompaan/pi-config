import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { HistoryItem } from "./history.ts";
import { HistoryNavigator, type HistoryBrowseInput, type HistorySearchInput } from "./navigator.ts";
import { readContextOutput, type ContextOutputReadInput } from "./output-pages.ts";

const MAXIMUM_COMPACT_REPLY_CHARACTERS = 8_000;

export type HistorySnapshot = {
	allItems: readonly HistoryItem[];
	navigator: HistoryNavigator;
};

export type ContextPagingToolDependencies = {
	isEnabled(): boolean;
	snapshot(ctx: ExtensionContext): HistorySnapshot;
};

const strictObject = <T extends Record<string, unknown>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

const searchHistoryParameters = strictObject({
	query: Type.String({ maxLength: 200 }),
	files: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 10 })),
	tools: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 10 })),
	failed: Type.Optional(Type.Boolean()),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })),
	load: Type.Optional(Type.Boolean()),
});

const browseHistoryParameters = strictObject({
	historyId: Type.Optional(Type.String({ maxLength: 128 })),
	sequence: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
	direction: StringEnum(["backward", "forward", "around"] as const),
	count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })),
	stride: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 1 })),
});

const loadHistoryParameters = strictObject({
	historyIds: Type.Array(Type.String({ maxLength: 128 }), { minItems: 1, maxItems: 3 }),
});

const readContextOutputParameters = strictObject({
	historyId: Type.String(),
	source: StringEnum(["assistant", "toolResult"] as const),
	contentIndex: Type.Optional(Type.Integer({ minimum: 0 })),
	toolCallId: Type.Optional(Type.String()),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000, default: 2_000 })),
});

type SearchHistoryInput = HistorySearchInput & { load?: boolean };

function serialized(value: unknown): string {
	const text = JSON.stringify(value);
	if (text === undefined) throw new Error("Context paging response could not be serialized.");
	return text;
}

function response<T>(details: T) {
	return {
		content: [{ type: "text" as const, text: serialized(details) }],
		details,
	};
}

function compactResponse<T>(details: T) {
	if (serialized(details).length > MAXIMUM_COMPACT_REPLY_CHARACTERS) {
		throw new Error(`Compact history response exceeds ${MAXIMUM_COMPACT_REPLY_CHARACTERS.toLocaleString()} characters.`);
	}
	return response(details);
}

function snapshot(dependencies: ContextPagingToolDependencies, ctx: ExtensionContext): HistorySnapshot {
	if (!dependencies.isEnabled()) throw new Error("Context paging recovery tools are disabled.");
	return dependencies.snapshot(ctx);
}

/** Registers the four public tools that recover paged session context. */
export function registerContextPagingTools(
	pi: ExtensionAPI,
	dependencies: ContextPagingToolDependencies,
): void {
	pi.registerTool({
		name: "search_history",
		label: "Search History",
		description: "search_history finds compact recovery references in paged session history. Use load_history for exact items or read_context_output for repeated output pages.",
		parameters: searchHistoryParameters,
		async execute(_toolCallId, params: SearchHistoryInput, _signal, _onUpdate, ctx) {
			const current = snapshot(dependencies, ctx);
			const references = current.navigator.search(params);
			const historyIds = references.slice(0, 3).map((reference) => reference.historyId);
			return params.load
				? response({ items: historyIds.length === 0 ? [] : current.navigator.load(historyIds) })
				: compactResponse({ references });
		},
	});

	pi.registerTool({
		name: "browse_history",
		label: "Browse History",
		description: "browse_history returns compact recovery references around paged session history. Use load_history for exact items or read_context_output for repeated output pages.",
		parameters: browseHistoryParameters,
		async execute(_toolCallId, params: HistoryBrowseInput, _signal, _onUpdate, ctx) {
			const current = snapshot(dependencies, ctx);
			return compactResponse({ references: current.navigator.browse(params) });
		},
	});

	pi.registerTool({
		name: "load_history",
		label: "Load History",
		description: "load_history returns exact recovery items in the requested order. Use read_context_output for repeated output pages from a loaded model turn.",
		parameters: loadHistoryParameters,
		async execute(_toolCallId, params: { historyIds: string[] }, _signal, _onUpdate, ctx) {
			const current = snapshot(dependencies, ctx);
			return response({ items: current.navigator.load(params.historyIds) });
		},
	});

	pi.registerTool({
		name: "read_context_output",
		label: "Read Context Output",
		description: "read_context_output returns one exact recovery output page. Repeat read_context_output with nextOffset until nextOffset is null.",
		parameters: readContextOutputParameters,
		async execute(_toolCallId, params: ContextOutputReadInput, _signal, _onUpdate, ctx) {
			const current = snapshot(dependencies, ctx);
			return response(readContextOutput(current.allItems, params));
		},
	});
}
