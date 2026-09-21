import type { HistoryItem, ModelTurnHistoryItem } from "./history.ts";

export const MAXIMUM_INLINE_OUTPUT_BYTES = 16_000;
export const MAXIMUM_OUTPUT_PAGE_CHARACTERS = 2_000;

export type ContextOutputReference =
	| { historyId: string; source: "assistant"; contentIndex: number }
	| { historyId: string; source: "toolResult"; toolCallId: string };

export type ContextOutputReadInput = {
	historyId: string;
	source: "assistant" | "toolResult";
	contentIndex?: number;
	toolCallId?: string;
	offset?: number;
	limit?: number;
};

export type ContextOutputPage = {
	offset: number;
	nextOffset: number | null;
	totalCharacters: number;
	text: string;
};

export type PagedTurnView = {
	item: ModelTurnHistoryItem;
	references: ContextOutputReference[];
};

type ToolCallBlock = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: unknown;
};

type AssistantContent = ModelTurnHistoryItem["assistantMessage"]["content"][number];

function serialized(value: unknown): string {
	const text = JSON.stringify(value);
	if (text === undefined) throw new Error("Context output could not be serialized.");
	return text;
}

function isToolCallBlock(value: unknown): value is ToolCallBlock {
	return typeof value === "object" && value !== null
		&& (value as { type?: unknown }).type === "toolCall"
		&& typeof (value as { id?: unknown }).id === "string"
		&& typeof (value as { name?: unknown }).name === "string";
}

function outputNotice(reference: ContextOutputReference, source: string): string {
	return `Output is paged. Use read_context_output with ${JSON.stringify(reference)}. `
		+ `Each page contains at most ${MAXIMUM_OUTPUT_PAGE_CHARACTERS.toLocaleString("en-US")} characters. `
		+ `Preview: ${source.slice(0, 256)}`;
}

function assistantPlaceholder(value: AssistantContent, notice: string): AssistantContent {
	if (typeof value === "object" && value !== null && (value as { type?: unknown }).type === "text") {
		return { ...value, text: notice } as AssistantContent;
	}
	return { type: "text", text: notice } as AssistantContent;
}

function pageAssistantContent(
	turn: ModelTurnHistoryItem,
	maximumInlineBytes: number,
	references: ContextOutputReference[],
): ModelTurnHistoryItem["assistantMessage"]["content"] {
	return turn.assistantMessage.content.map((value, contentIndex): AssistantContent => {
		const source = serialized(value);
		if (Buffer.byteLength(source, "utf8") <= maximumInlineBytes) return value;
		const reference: ContextOutputReference = { historyId: turn.id, source: "assistant", contentIndex };
		references.push(reference);
		const notice = outputNotice(reference, source);
		if (isToolCallBlock(value)) {
			return { ...value, arguments: { contextOutputReference: reference } } as AssistantContent;
		}
		return assistantPlaceholder(value, notice);
	});
}

/** Creates a compact outbound turn view while leaving the stored turn unchanged. */
export function pageTurnOutputs(
	turn: ModelTurnHistoryItem,
	maximumInlineBytes = MAXIMUM_INLINE_OUTPUT_BYTES,
): PagedTurnView {
	const references: ContextOutputReference[] = [];
	const content = pageAssistantContent(turn, maximumInlineBytes, references);
	const toolResults = turn.toolResults.map((result) => {
		const source = serialized(result);
		if (Buffer.byteLength(source, "utf8") <= maximumInlineBytes) return { ...result };
		const reference: ContextOutputReference = {
			historyId: turn.id,
			source: "toolResult",
			toolCallId: result.toolCallId,
		};
		references.push(reference);
		const notice = outputNotice(reference, source);
		return {
			...result,
			content: [{ type: "text", text: notice }],
			details: { contextOutputReference: reference },
		};
	});
	return {
		item: {
			...turn,
			assistantMessage: { ...turn.assistantMessage, content },
			toolResults,
		},
		references,
	};
}

/** Replaces every assistant block and tool result with a bounded recovery reference. */
export function pageAllTurnOutputs(turn: ModelTurnHistoryItem): PagedTurnView {
	return pageTurnOutputs(turn, 0);
}

function validateDiscriminator(input: ContextOutputReadInput): void {
	if (input.source === "assistant") {
		if (!Number.isSafeInteger(input.contentIndex) || (input.contentIndex as number) < 0) {
			throw new Error("Assistant output requires a nonnegative integer contentIndex.");
		}
		if (input.toolCallId !== undefined) {
			throw new Error("Assistant output does not accept toolCallId.");
		}
	} else if (input.source === "toolResult") {
		if (typeof input.toolCallId !== "string" || input.toolCallId.length === 0) {
			throw new Error("Tool-result output requires toolCallId.");
		}
		if (input.contentIndex !== undefined) {
			throw new Error("Tool-result output does not accept contentIndex.");
		}
	} else {
		throw new Error("Output source must be assistant or toolResult.");
	}
}

function validatePageInput(input: ContextOutputReadInput): { offset: number; limit: number } {
	const offset = input.offset === undefined ? 0 : input.offset;
	const limit = input.limit === undefined ? MAXIMUM_OUTPUT_PAGE_CHARACTERS : input.limit;
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw new Error("Output offset must be a nonnegative integer.");
	}
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_OUTPUT_PAGE_CHARACTERS) {
		throw new Error(`Output limit must be an integer from 1 to ${MAXIMUM_OUTPUT_PAGE_CHARACTERS.toLocaleString("en-US")}.`);
	}
	return { offset, limit };
}

/** Reads an exact JSON page from the raw active-branch projection. */
export function readContextOutput(items: readonly HistoryItem[], input: ContextOutputReadInput): ContextOutputPage {
	validateDiscriminator(input);
	const { offset, limit } = validatePageInput(input);
	const item = items.find((candidate) => candidate.id === input.historyId);
	if (item === undefined) throw new Error(`Unknown history ID ${input.historyId}.`);
	if (item.kind !== "modelTurn") throw new Error(`History ID ${input.historyId} is not a model turn.`);

	const value = input.source === "assistant"
		? item.assistantMessage.content[input.contentIndex!]
		: item.toolResults.find((result) => result.toolCallId === input.toolCallId);
	if (value === undefined) {
		throw new Error(input.source === "assistant"
			? `Unknown assistant content index ${input.contentIndex}.`
			: `Unknown tool-result toolCallId ${input.toolCallId}.`);
	}

	const text = serialized(value);
	if (offset > text.length) throw new Error("Output offset exceeds the serialized output length.");
	const end = Math.min(offset + limit, text.length);
	return {
		offset,
		nextOffset: end < text.length ? end : null,
		totalCharacters: text.length,
		text: text.slice(offset, end),
	};
}
