import type { HistoryItem, ModelTurnHistoryItem } from "./history.ts";

export const MAXIMUM_OUTPUT_PAGE_CHARACTERS = 2_000;

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

function validateDiscriminator(input: ContextOutputReadInput): void {
	if (input.source === "assistant") {
		if (typeof input.contentIndex !== "number"
			|| !Number.isSafeInteger(input.contentIndex) || input.contentIndex < 0) {
			throw new Error("Assistant output requires a nonnegative integer contentIndex.");
		}
		if (input.toolCallId !== undefined) {
			throw new Error("Assistant output does not accept toolCallId.");
		}
		return;
	}
	if (input.source === "toolResult") {
		if (typeof input.toolCallId !== "string" || input.toolCallId.length === 0) {
			throw new Error("Tool-result output requires toolCallId.");
		}
		if (input.contentIndex !== undefined) {
			throw new Error("Tool-result output does not accept contentIndex.");
		}
		return;
	}
	throw new Error("Output source must be assistant or toolResult.");
}

function pageInput(input: ContextOutputReadInput): { offset: number; limit: number } {
	const offset = input.offset ?? 0;
	const limit = input.limit ?? MAXIMUM_OUTPUT_PAGE_CHARACTERS;
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw new Error("Output offset must be a nonnegative integer.");
	}
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_OUTPUT_PAGE_CHARACTERS) {
		throw new Error(`Output limit must be an integer from 1 to ${MAXIMUM_OUTPUT_PAGE_CHARACTERS}.`);
	}
	return { offset, limit };
}

function modelTurn(items: readonly HistoryItem[], historyId: string): ModelTurnHistoryItem {
	const item = items.find((candidate) => candidate.id === historyId);
	if (item === undefined) throw new Error(`Unknown history ID ${historyId}.`);
	if (item.kind !== "modelTurn") throw new Error(`History ID ${historyId} is not a model turn.`);
	return item;
}

function selectedOutput(turn: ModelTurnHistoryItem, input: ContextOutputReadInput): unknown {
	const value = input.source === "assistant"
		? turn.assistantMessage.content[input.contentIndex!]
		: turn.toolResults.find((result) => result.toolCallId === input.toolCallId);
	if (value === undefined) {
		throw new Error(input.source === "assistant"
			? `Unknown assistant content index ${input.contentIndex}.`
			: `Unknown tool-result toolCallId ${input.toolCallId}.`);
	}
	return value;
}

/** Reads an exact JSON page from the raw active-branch history projection. */
export function readContextOutput(
	items: readonly HistoryItem[],
	input: ContextOutputReadInput,
): ContextOutputPage {
	validateDiscriminator(input);
	const { offset, limit } = pageInput(input);
	const value = selectedOutput(modelTurn(items, input.historyId), input);
	const text = JSON.stringify(value);
	if (text === undefined) throw new Error("Context output could not be serialized.");
	if (offset > text.length) throw new Error("Output offset exceeds the serialized output length.");

	const end = Math.min(offset + limit, text.length);
	return {
		offset,
		nextOffset: end < text.length ? end : null,
		totalCharacters: text.length,
		text: text.slice(offset, end),
	};
}
