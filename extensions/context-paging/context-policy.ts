import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { flattenHistoryItems, type HistoryItem, type ModelTurnHistoryItem } from "./history.ts";
import {
	pageAllTurnOutputs,
	pageTurnOutputs,
	type ContextOutputReference,
	type PagedTurnView,
} from "./output-pages.ts";

export type ResidentToolDefinition = {
	name: string;
	description: string;
	parameters: unknown;
};

export type ContextSelectionInput = {
	items: readonly HistoryItem[];
	systemPrompt: string;
	activeTools: readonly ResidentToolDefinition[];
	contextWindow: number | undefined;
};

export type ContextSelection = {
	messages: AgentMessage[];
	selectedHistoryIds: string[];
	selectedModelTurnIds: string[];
	evictedHistoryIds: string[];
	outputReferences: ContextOutputReference[];
	measuredInputBytes: number;
	maximumInputBytes: number;
};

export type ContextBudgetErrorCode = "INVALID_MODEL_CONTEXT" | "MANDATORY_CONTEXT_TOO_LARGE";

export class ContextBudgetError extends Error {
	readonly code: ContextBudgetErrorCode;
	readonly measuredInputBytes: number | undefined;
	readonly maximumInputBytes: number | undefined;

	constructor(
		code: ContextBudgetErrorCode,
		message: string,
		measuredInputBytes?: number,
		maximumInputBytes?: number,
	) {
		super(message);
		this.code = code;
		this.measuredInputBytes = measuredInputBytes;
		this.maximumInputBytes = maximumInputBytes;
		this.name = "ContextBudgetError";
	}
}

export function measureContextBytes(
	systemPrompt: string,
	activeTools: readonly ResidentToolDefinition[],
	messages: readonly AgentMessage[],
): number {
	return Buffer.byteLength(JSON.stringify({
		systemPrompt,
		tools: activeTools.map(({ name, description, parameters }) => ({ name, description, parameters })),
		messages,
	}), "utf8");
}

function selectedItems(
	orderedItems: readonly HistoryItem[],
	selectedTurns: ReadonlyMap<string, PagedTurnView>,
): HistoryItem[] {
	return orderedItems.flatMap((item) => {
		if (item.kind === "user") return [item];
		const view = selectedTurns.get(item.id);
		return view === undefined ? [] : [view.item];
	});
}

function selectedMessages(
	orderedItems: readonly HistoryItem[],
	selectedTurns: ReadonlyMap<string, PagedTurnView>,
): AgentMessage[] {
	return flattenHistoryItems(selectedItems(orderedItems, selectedTurns));
}

function tentativeSelection(
	turn: ModelTurnHistoryItem,
	view: PagedTurnView,
	selectedTurns: ReadonlyMap<string, PagedTurnView>,
): Map<string, PagedTurnView> {
	return new Map([[turn.id, view], ...selectedTurns]);
}

export function selectContext(input: ContextSelectionInput): ContextSelection {
	if (!Number.isFinite(input.contextWindow)
		|| !Number.isInteger(input.contextWindow)
		|| (input.contextWindow as number) <= 0) {
		throw new ContextBudgetError(
			"INVALID_MODEL_CONTEXT",
			"The active model must provide a positive finite integer context window.",
		);
	}

	const maximumInputBytes = Math.floor((input.contextWindow as number) * 0.60);
	const orderedItems = [...input.items].sort((left, right) => left.sequence - right.sequence);
	const modelTurns = orderedItems.filter((item): item is ModelTurnHistoryItem => item.kind === "modelTurn");
	const mandatoryMessages = flattenHistoryItems(orderedItems.filter((item) => item.kind === "user"));
	const mandatoryBytes = measureContextBytes(input.systemPrompt, input.activeTools, mandatoryMessages);
	if (mandatoryBytes > maximumInputBytes) {
		throw new ContextBudgetError(
			"MANDATORY_CONTEXT_TOO_LARGE",
			`Mandatory context requires ${mandatoryBytes} bytes but the model budget is ${maximumInputBytes} bytes.`,
			mandatoryBytes,
			maximumInputBytes,
		);
	}

	let selectedTurns = new Map<string, PagedTurnView>();
	for (let index = modelTurns.length - 1; index >= 0; index--) {
		const turn = modelTurns[index];
		let candidate = pageTurnOutputs(turn);
		let tentative = tentativeSelection(turn, candidate, selectedTurns);
		let messages = selectedMessages(orderedItems, tentative);
		if (measureContextBytes(input.systemPrompt, input.activeTools, messages) > maximumInputBytes) {
			candidate = pageAllTurnOutputs(turn);
			tentative = tentativeSelection(turn, candidate, selectedTurns);
			messages = selectedMessages(orderedItems, tentative);
			if (measureContextBytes(input.systemPrompt, input.activeTools, messages) > maximumInputBytes) break;
		}
		selectedTurns = tentative;
	}

	const selected = selectedItems(orderedItems, selectedTurns);
	const messages = flattenHistoryItems(selected);
	return {
		messages,
		selectedHistoryIds: selected.map((item) => item.id),
		selectedModelTurnIds: modelTurns.filter((turn) => selectedTurns.has(turn.id)).map((turn) => turn.id),
		evictedHistoryIds: modelTurns.filter((turn) => !selectedTurns.has(turn.id)).map((turn) => turn.id),
		outputReferences: modelTurns.flatMap((turn) => selectedTurns.get(turn.id)?.references ?? []),
		measuredInputBytes: measureContextBytes(input.systemPrompt, input.activeTools, messages),
		maximumInputBytes,
	};
}
