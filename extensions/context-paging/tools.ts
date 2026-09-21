import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { HistoryItem } from "./history.ts";
import { HistoryNavigator, type HistoryBrowseInput, type HistorySearchInput } from "./navigator.ts";
import { readContextOutput, type ContextOutputReadInput } from "./output-pages.ts";

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

const SearchHistoryParameters = strictObject({
	query: Type.String({ maxLength: 200 }),
	files: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 10 })),
	tools: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 10 })),
	failed: Type.Optional(Type.Boolean()),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })),
	load: Type.Optional(Type.Boolean()),
});

const BrowseHistoryParameters = strictObject({
	historyId: Type.Optional(Type.String({ maxLength: 128 })),
	sequence: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
	direction: StringEnum(["backward", "forward", "around"] as const),
	count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })),
	stride: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 1 })),
});

const LoadHistoryParameters = strictObject({
	historyIds: Type.Array(Type.String({ maxLength: 128 }), { minItems: 1, maxItems: 3 }),
});

const ReadContextOutputParameters = strictObject({
	historyId: Type.String(),
	source: StringEnum(["assistant", "toolResult"] as const),
	contentIndex: Type.Optional(Type.Integer({ minimum: 0 })),
	toolCallId: Type.Optional(Type.String()),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000, default: 2_000 })),
});

type SearchHistoryInput = HistorySearchInput & { load?: boolean };

function requireEnabled(dependencies: ContextPagingToolDependencies): void {
	if (!dependencies.isEnabled()) {
		throw new Error("Context paging is disabled by contextPaging.enabled.");
	}
}

function compactJsonResult<T>(details: T) {
	const text = JSON.stringify(details);
	if (text.length > 8_000) {
		throw new Error(`RESPONSE_TOO_LARGE: Tool response is ${text.length} characters; maximum is 8000.`);
	}
	return { content: [{ type: "text" as const, text }], details };
}

function exactJsonResult<T>(details: T) {
	return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

const pagingTurnGuidance = "Paging turns are absent from history navigation, but their tool results remain available on the immediate next request.";
const pagingTurnPromptGuidance = [pagingTurnGuidance];

/** Registers the public catalog for exact history and paged output recovery. */
export function registerContextPagingTools(pi: ExtensionAPI, dependencies: ContextPagingToolDependencies): void {
	pi.registerTool({
		name: "search_history",
		label: "Search History",
		description: `Search stored session history and return compact references. Set load to true to load the first three matches exactly. ${pagingTurnGuidance}`,
		promptGuidelines: pagingTurnPromptGuidance,
		parameters: SearchHistoryParameters,
		async execute(_toolCallId, input: SearchHistoryInput, _signal, _onUpdate, ctx) {
			requireEnabled(dependencies);
			const { navigator } = dependencies.snapshot(ctx);
			const references = navigator.search(input);
			if (input.load) {
				const historyIds = references.slice(0, 3).map((reference) => reference.historyId);
				return exactJsonResult({ items: historyIds.length === 0 ? [] : navigator.load(historyIds) });
			}
			return compactJsonResult({ references });
		},
	});

	pi.registerTool({
		name: "browse_history",
		label: "Browse History",
		description: `Browse compact history references by anchor and direction. ${pagingTurnGuidance}`,
		promptGuidelines: pagingTurnPromptGuidance,
		parameters: BrowseHistoryParameters,
		async execute(_toolCallId, input: HistoryBrowseInput, _signal, _onUpdate, ctx) {
			requireEnabled(dependencies);
			const { navigator } = dependencies.snapshot(ctx);
			return compactJsonResult({ references: navigator.browse(input) });
		},
	});

	pi.registerTool({
		name: "load_history",
		label: "Load History",
		description: `Load one to three exact atomic history items in the requested order. ${pagingTurnGuidance}`,
		promptGuidelines: pagingTurnPromptGuidance,
		parameters: LoadHistoryParameters,
		async execute(_toolCallId, input: { historyIds: string[] }, _signal, _onUpdate, ctx) {
			requireEnabled(dependencies);
			const { navigator } = dependencies.snapshot(ctx);
			return exactJsonResult({ items: navigator.load(input.historyIds) });
		},
	});

	pi.registerTool({
		name: "read_context_output",
		label: "Read Context Output",
		description: "Read an exact page of a paged assistant or tool-result output. Repeat calls with nextOffset until it is null. Paging turns are absent from history navigation, but their tool results remain available on the immediate next request.",
		promptGuidelines: [
			pagingTurnGuidance,
			"Repeat read_context_output with nextOffset until it is null.",
		],
		parameters: ReadContextOutputParameters,
		async execute(_toolCallId, input: ContextOutputReadInput, _signal, _onUpdate, ctx) {
			requireEnabled(dependencies);
			const { allItems } = dependencies.snapshot(ctx);
			return exactJsonResult(readContextOutput(allItems, input));
		},
	});
}
