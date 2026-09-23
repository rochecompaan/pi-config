import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { findModelTurnByToolCallId, type HistoryItem } from "./history.ts";

export const CONTEXT_TOKEN_BUDGET = 64_000;

export type ResidentToolDefinition = {
	name: string;
	description: string;
	parameters: unknown;
};

export type ContextSelectionInput = {
	messages: readonly AgentMessage[];
	systemPrompt: string;
	activeTools: readonly ResidentToolDefinition[];
	modelContextWindow: number | undefined;
	rawHistoryItems?: readonly HistoryItem[];
};

export type ContextSelectionMode = "within-budget" | "paged" | "protected-overflow" | "recovery";

export type ContextSelection = {
	messages: AgentMessage[];
	estimatedTokens: number;
	budgetTokens: number;
	mode: ContextSelectionMode;
};

export type ContextSelectionErrorCode =
	| "INVALID_MODEL_CONTEXT"
	| "RESIDENT_INPUT_TOO_LARGE"
	| "ACTIVE_REQUEST_TOO_LARGE"
	| "INVALID_MESSAGE_STRUCTURE";

export class ContextSelectionError extends Error {
	readonly code: ContextSelectionErrorCode;
	readonly residentTokens?: number;
	readonly estimatedTokens?: number;
	readonly budgetTokens?: number;

	constructor(
		code: ContextSelectionErrorCode,
		message: string,
		residentTokens?: number,
		estimatedTokens?: number,
		budgetTokens?: number,
	) {
		super(message);
		this.code = code;
		this.residentTokens = residentTokens;
		this.estimatedTokens = estimatedTokens;
		this.budgetTokens = budgetTokens;
		this.name = "ContextSelectionError";
	}
}

type ToolExchange = {
	assistant: AssistantMessage;
	results: ToolResultMessage[];
	messages: AgentMessage[];
};

type PrefixUnit = { kind: "prefix"; messages: AgentMessage[] };
type CompletedTurnUnit = { kind: "completedTurn"; messages: AgentMessage[] };
type RequestMessage = UserMessage | Extract<AgentMessage, { role: "custom" }>;

type ActiveTurnUnit = {
	kind: "activeTurn";
	request: RequestMessage[];
	exchanges: ToolExchange[];
};

type GroupedContext = {
	prefixes: PrefixUnit[];
	completedTurns: CompletedTurnUnit[];
	activeTurn?: ActiveTurnUnit;
};

type ToolCallBlock = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: unknown;
};

type ToolRecoveryReference = {
	historyId: string;
	toolCallId: string;
	toolName: string;
};

function isToolCallBlock(block: unknown): block is ToolCallBlock {
	return typeof block === "object" && block !== null
		&& (block as { type?: unknown }).type === "toolCall"
		&& typeof (block as { id?: unknown }).id === "string"
		&& typeof (block as { name?: unknown }).name === "string";
}

function temporaryUserMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: 0 };
}

function residentTokenEstimate(input: ContextSelectionInput): number {
	const tools = input.activeTools.map(({ name, description, parameters }) => ({ name, description, parameters }));
	return estimateTokens(temporaryUserMessage(input.systemPrompt))
		+ estimateTokens(temporaryUserMessage(JSON.stringify(tools)));
}

function structureError(message: string): ContextSelectionError {
	return new ContextSelectionError("INVALID_MESSAGE_STRUCTURE", message);
}

function exchangeAt(messages: readonly AgentMessage[], index: number): { exchange: ToolExchange; nextIndex: number } {
	const assistant = messages[index] as AssistantMessage;
	const calls = assistant.content.filter(isToolCallBlock);
	if (calls.length === 0) {
		return { exchange: { assistant, results: [], messages: [assistant] }, nextIndex: index + 1 };
	}

	const expectedIds = new Set(calls.map((call) => call.id));
	if (expectedIds.size !== calls.length) {
		throw structureError("Canonical tool-call exchange has duplicate IDs.");
	}
	const seenIds = new Set<string>();
	const results: ToolResultMessage[] = [];
	let nextIndex = index + 1;
	while (messages[nextIndex]?.role === "toolResult") {
		const result = messages[nextIndex] as ToolResultMessage;
		if (!expectedIds.has(result.toolCallId) || seenIds.has(result.toolCallId)) {
			throw structureError("Canonical tool-result exchange has an invalid matching result.");
		}
		seenIds.add(result.toolCallId);
		results.push(result);
		nextIndex++;
	}
	if (seenIds.size !== expectedIds.size) {
		throw structureError("Canonical tool-call exchange is incomplete.");
	}
	return { exchange: { assistant, results, messages: [assistant, ...results] }, nextIndex };
}

function unitsForSegment(messages: readonly AgentMessage[]): AgentMessage[][] {
	const units: AgentMessage[][] = [];
	for (let index = 0; index < messages.length;) {
		const message = messages[index];
		if (message.role === "toolResult") throw structureError("Canonical context contains an orphan tool result.");
		if (message.role === "assistant") {
			const { exchange, nextIndex } = exchangeAt(messages, index);
			units.push(exchange.messages);
			index = nextIndex;
			continue;
		}
		units.push([message]);
		index++;
	}
	return units;
}

function requestStartIndexes(messages: readonly AgentMessage[]): number[] {
	const indexes: number[] = [];
	let followsUserRequest = false;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role === "user") {
			indexes.push(index);
			followsUserRequest = true;
			continue;
		}
		if (message.role === "custom") {
			if (!followsUserRequest) indexes.push(index);
			continue;
		}
		followsUserRequest = false;
	}
	return indexes;
}

function requestEnvelope(messages: readonly AgentMessage[], start: number): RequestMessage[] {
	const request = [messages[start] as RequestMessage];
	if (request[0].role !== "user") return request;
	for (let index = start + 1; messages[index]?.role === "custom"; index++) {
		request.push(messages[index] as Extract<AgentMessage, { role: "custom" }>);
	}
	return request;
}

function groupContext(messages: readonly AgentMessage[]): GroupedContext {
	const requestIndexes = requestStartIndexes(messages);
	if (requestIndexes.length === 0) return { prefixes: unitsForSegment(messages).map((messages) => ({ kind: "prefix", messages })) };

	const prefixes = unitsForSegment(messages.slice(0, requestIndexes[0]))
		.map((messages) => ({ kind: "prefix" as const, messages }));
	const completedTurns: CompletedTurnUnit[] = [];
	for (let turn = 0; turn < requestIndexes.length - 1; turn++) {
		const start = requestIndexes[turn];
		const end = requestIndexes[turn + 1];
		unitsForSegment(messages.slice(start, end));
		completedTurns.push({ kind: "completedTurn", messages: [...messages.slice(start, end)] });
	}

	const activeStart = requestIndexes.at(-1)!;
	const activeMessages = messages.slice(activeStart);
	const request = requestEnvelope(activeMessages, 0);
	const exchanges: ToolExchange[] = [];
	for (let index = request.length; index < activeMessages.length;) {
		const message = activeMessages[index];
		if (message.role === "toolResult") throw structureError("Canonical context contains an orphan tool result.");
		if (message.role !== "assistant") throw structureError("Canonical active turn has an unsupported message structure.");
		const { exchange, nextIndex } = exchangeAt(activeMessages, index);
		exchanges.push(exchange);
		index = nextIndex;
	}
	return { prefixes, completedTurns, activeTurn: { kind: "activeTurn", request, exchanges } };
}

function messageEstimate(messages: readonly AgentMessage[]): number {
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function matchingHistoryId(message: AgentMessage, items: readonly HistoryItem[] | undefined): string | undefined {
	if (!items) return undefined;
	const matches = (candidate: AgentMessage): boolean => candidate === message || JSON.stringify(candidate) === JSON.stringify(message);
	for (const item of items) {
		if (item.kind === "user" && matches(item.userMessage)) return item.id;
		if (item.kind === "modelTurn" && (matches(item.assistantMessage) || item.toolResults.some(matches))) return item.id;
	}
	return undefined;
}

function pagingNotice(historyId: string | undefined, toolReference?: ToolRecoveryReference): UserMessage {
	const lines = [
		"[Context paging notice — generated by the extension]",
		"Older context left the 64,000-token rolling window. Raw session history is unchanged.",
		"Use search_history or browse_history to find stored items.",
		"Use load_history for exact items or read_context_output for exact output pages.",
	];
	if (historyId !== undefined) lines.push(`Recent evicted historyId: ${JSON.stringify(historyId)}.`);
	if (toolReference) {
		lines.push(`Tool name: ${toolReference.toolName}.`);
		lines.push(`Read evicted tool output with read_context_output(${JSON.stringify({
			historyId: toolReference.historyId,
			source: "toolResult",
			toolCallId: toolReference.toolCallId,
			offset: 0,
			limit: 2000,
		})}).`);
	}
	return temporaryUserMessage(lines.join("\n"));
}

function protectedOverflowNotice(): UserMessage {
	return temporaryUserMessage([
		"[Context paging notice — generated by the extension]",
		"The newest tool-result exchange is present in full for this follow-up call.",
		"The normal rolling budget is 64,000 estimated tokens.",
		"This exchange can leave context after this call.",
		"Use search_history or browse_history, then load_history or read_context_output, to recover it.",
	].join("\n"));
}

function recoveryNotice(): UserMessage {
	return temporaryUserMessage([
		"[Context paging notice — generated by the extension]",
		"The newest tool-result payloads were replaced with recovery references because they exceeded the active model context window.",
		"Use read_context_output with the exact arguments in each replacement to retrieve the stored results.",
	].join("\n"));
}

function toolRecoveryReference(message: AgentMessage, items: readonly HistoryItem[] | undefined): ToolRecoveryReference | undefined {
	if (!items || message.role !== "toolResult") return undefined;
	const turn = findModelTurnByToolCallId(items, message.toolCallId);
	return turn?.toolResults.some((result) => result.toolCallId === message.toolCallId)
		? { historyId: turn.id, toolCallId: message.toolCallId, toolName: message.toolName }
		: undefined;
}

function unreadTrailingExchange(grouped: GroupedContext, items: readonly HistoryItem[] | undefined): ToolExchange | undefined {
	if (!items || !grouped.activeTurn) return undefined;
	const exchange = grouped.activeTurn.exchanges.at(-1);
	if (!exchange) return undefined;
	const calls = exchange.assistant.content.filter(isToolCallBlock);
	if (calls.length === 0) return undefined;
	const callIds = calls.map((call) => call.id);
	const turn = findModelTurnByToolCallId(items, callIds[0]);
	if (!turn || items.at(-1) !== turn) return undefined;
	const rawCallIds = turn.assistantMessage.content.filter(isToolCallBlock).map((call) => call.id);
	const resultIds = exchange.results.map((result) => result.toolCallId);
	const rawResultIds = turn.toolResults.map((result) => result.toolCallId);
	if (JSON.stringify(rawCallIds) !== JSON.stringify(callIds)
		|| JSON.stringify(rawResultIds) !== JSON.stringify(resultIds)) return undefined;
	return exchange;
}

function recoveredProtectedExchange(exchange: ToolExchange, items: readonly HistoryItem[]): ToolExchange {
	const results = exchange.results.map((result) => {
		const turn = findModelTurnByToolCallId(items, result.toolCallId);
		const reference = turn && turn.toolResults.some((rawResult) => rawResult.toolCallId === result.toolCallId)
			? { historyId: turn.id, toolCallId: result.toolCallId }
			: undefined;
		if (!reference) return result;
		const content = [
			"[Context paging recovery — generated by the extension]",
			"This tool result exceeded the active model context window.",
			`Read the exact stored result with read_context_output(${JSON.stringify({
				historyId: reference.historyId,
				source: "toolResult",
				toolCallId: reference.toolCallId,
				offset: 0,
				limit: 2000,
			})}).`,
		].join("\n");
		return { ...result, content: [{ type: "text" as const, text: content }] };
	});
	return {
		assistant: exchange.assistant,
		results,
		messages: [exchange.assistant, ...results],
	};
}

function error(code: ContextSelectionErrorCode, message: string, residentTokens: number, estimatedTokens: number, budgetTokens: number): ContextSelectionError {
	return new ContextSelectionError(code, message, residentTokens, estimatedTokens, budgetTokens);
}

export function selectContext(input: ContextSelectionInput): ContextSelection {
	if (!Number.isFinite(input.modelContextWindow) || input.modelContextWindow === undefined || input.modelContextWindow <= 0) {
		throw error("INVALID_MODEL_CONTEXT", "The active model context-window estimate is invalid.", 0, 0, 0);
	}
	const budgetTokens = Math.min(CONTEXT_TOKEN_BUDGET, input.modelContextWindow);
	const residentTokens = residentTokenEstimate(input);
	if (residentTokens > budgetTokens) {
		throw error("RESIDENT_INPUT_TOO_LARGE", `Resident input estimate ${residentTokens} exceeds budget estimate ${budgetTokens}.`, residentTokens, residentTokens, budgetTokens);
	}

	const grouped = groupContext(input.messages);
	const fullEstimate = residentTokens + messageEstimate(input.messages);
	if (fullEstimate <= budgetTokens) {
		return { messages: input.messages as AgentMessage[], estimatedTokens: fullEstimate, budgetTokens, mode: "within-budget" };
	}
	if (!grouped.activeTurn) {
		const prefixes = [...grouped.prefixes];
		let evictedHistoryId: string | undefined;
		let removed = false;
		const candidate = (): AgentMessage[] => [
			...(removed ? [pagingNotice(evictedHistoryId)] : []),
			...prefixes.flatMap((unit) => unit.messages),
		];

		while (residentTokens + messageEstimate(candidate()) > budgetTokens) {
			if (prefixes.length === 0) {
				const estimatedTokens = residentTokens + messageEstimate(candidate());
				throw error("RESIDENT_INPUT_TOO_LARGE", `Resident and paging-notice estimate ${estimatedTokens} exceeds budget estimate ${budgetTokens}.`, residentTokens, estimatedTokens, budgetTokens);
			}
			removed = true;
			for (const message of prefixes.shift()!.messages) {
				evictedHistoryId = matchingHistoryId(message, input.rawHistoryItems) ?? evictedHistoryId;
			}
		}

		const messages = candidate();
		return { messages, estimatedTokens: residentTokens + messageEstimate(messages), budgetTokens, mode: "paged" };
	}

	const activeRequestTokens = residentTokens + messageEstimate(grouped.activeTurn.request);
	if (activeRequestTokens > budgetTokens) {
		throw error("ACTIVE_REQUEST_TOO_LARGE", `Resident plus active request estimate ${activeRequestTokens} exceeds budget estimate ${budgetTokens}.`, residentTokens, activeRequestTokens, budgetTokens);
	}

	const prefixes = [...grouped.prefixes];
	const completedTurns = [...grouped.completedTurns];
	const exchanges = [...grouped.activeTurn.exchanges];
	const protectedExchange = unreadTrailingExchange(grouped, input.rawHistoryItems);
	let evictedHistoryId: string | undefined;
	let evictedToolReference: ToolRecoveryReference | undefined;
	let removed = false;
	const candidate = (notice = removed ? pagingNotice(evictedHistoryId, evictedToolReference) : undefined): AgentMessage[] => [
		...(notice ? [notice] : []),
		...prefixes.flatMap((unit) => unit.messages),
		...completedTurns.flatMap((unit) => unit.messages),
		...grouped.activeTurn!.request,
		...exchanges.flatMap((exchange) => exchange.messages),
	];
	const remove = (messages: readonly AgentMessage[]) => {
		removed = true;
		for (const message of messages) {
			evictedHistoryId = matchingHistoryId(message, input.rawHistoryItems) ?? evictedHistoryId;
			evictedToolReference ??= toolRecoveryReference(message, input.rawHistoryItems);
		}
	};

	while (residentTokens + messageEstimate(candidate()) > budgetTokens) {
		if (prefixes.length > 0) {
			remove(prefixes.shift()!.messages);
			continue;
		}
		if (completedTurns.length > 0) {
			remove(completedTurns.shift()!.messages);
			continue;
		}
		if (exchanges.length > 0 && exchanges[0] !== protectedExchange) {
			remove(exchanges.shift()!.messages);
			continue;
		}
		if (protectedExchange) {
			const overflowMessages = candidate(protectedOverflowNotice());
			const overflowEstimate = residentTokens + messageEstimate(overflowMessages);
			if (overflowEstimate <= input.modelContextWindow) {
				return { messages: overflowMessages, estimatedTokens: overflowEstimate, budgetTokens, mode: "protected-overflow" };
			}
			const replacement = recoveredProtectedExchange(protectedExchange, input.rawHistoryItems ?? []);
			const replacementIndex = exchanges.indexOf(protectedExchange);
			exchanges[replacementIndex] = replacement;
			const recoveredMessages = candidate(recoveryNotice());
			const recoveredEstimate = residentTokens + messageEstimate(recoveredMessages);
			if (recoveredEstimate <= input.modelContextWindow) {
				return { messages: recoveredMessages, estimatedTokens: recoveredEstimate, budgetTokens, mode: "recovery" };
			}
			throw error("ACTIVE_REQUEST_TOO_LARGE", `Protected exchange recovery estimate ${recoveredEstimate} exceeds model context estimate ${input.modelContextWindow}.`, residentTokens, recoveredEstimate, budgetTokens);
		}
		const estimatedTokens = residentTokens + messageEstimate(candidate());
		throw error("ACTIVE_REQUEST_TOO_LARGE", `Resident plus active request estimate ${estimatedTokens} exceeds budget estimate ${budgetTokens}.`, residentTokens, estimatedTokens, budgetTokens);
	}

	const messages = candidate();
	return { messages, estimatedTokens: residentTokens + messageEstimate(messages), budgetTokens, mode: "paged" };
}
