import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { isInterruptedAssistantMessage, type HistoryItem } from "./history.ts";

export const DEFAULT_CONTEXT_TOKEN_BUDGET = 128_000;

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
	tokenBudget: number;
	/** A provider-backed full-context estimate, when its usage basis is known. */
	contextTokens?: number;
	/** Messages present only in this outgoing request, not the persistent session branch. */
	outgoingOnly?: readonly boolean[];
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
	| "INVALID_TOKEN_BUDGET"
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
	trailingOutgoing: AgentMessage[];
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

export function residentTokenEstimate(input: Pick<ContextSelectionInput, "systemPrompt" | "activeTools">): number {
	const tools = input.activeTools.map(({ name, description, parameters }) => ({ name, description, parameters }));
	// Pi 0.87 counts the rendered system content and toolsAdded schema together.
	return Math.ceil((input.systemPrompt.length + JSON.stringify(tools).length) / 4);
}

function structureError(message: string): ContextSelectionError {
	return new ContextSelectionError("INVALID_MESSAGE_STRUCTURE", message);
}

function exchangeAt(
	messages: readonly AgentMessage[],
	index: number,
	allowIncomplete = false,
): { exchange: ToolExchange; nextIndex: number } {
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
	if (seenIds.size !== expectedIds.size && !allowIncomplete) {
		throw structureError("Canonical tool-call exchange is incomplete.");
	}
	return { exchange: { assistant, results, messages: [assistant, ...results] }, nextIndex };
}

function normalizeInterruptedExchanges(
	messages: readonly AgentMessage[],
	outgoingOnly: readonly boolean[],
): { messages: AgentMessage[]; outgoingOnly: readonly boolean[] } {
	const normalized: AgentMessage[] = [];
	const normalizedOutgoingOnly: boolean[] = [];
	let removedInterruptedExchange = false;
	for (let index = 0; index < messages.length;) {
		const message = messages[index]!;
		if (message.role === "toolResult") {
			throw structureError("Canonical context contains an orphan tool result.");
		}
		if (message.role !== "assistant") {
			normalized.push(message);
			normalizedOutgoingOnly.push(outgoingOnly[index]!);
			index++;
			continue;
		}
		const interrupted = isInterruptedAssistantMessage(message);
		const { exchange, nextIndex } = exchangeAt(messages, index, interrupted);
		if (interrupted) removedInterruptedExchange = true;
		else {
			normalized.push(...exchange.messages);
			normalizedOutgoingOnly.push(...outgoingOnly.slice(index, nextIndex));
		}
		index = nextIndex;
	}
	return removedInterruptedExchange
		? { messages: normalized, outgoingOnly: normalizedOutgoingOnly }
		: { messages: messages as AgentMessage[], outgoingOnly };
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

function requestStartIndexes(messages: readonly AgentMessage[], outgoingOnly: readonly boolean[]): number[] {
	const indexes: number[] = [];
	let followsUserRequest = false;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (outgoingOnly[index]) continue;
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

function requestEnvelope(messages: readonly AgentMessage[], start: number, outgoingOnly: readonly boolean[]): RequestMessage[] {
	const request = [messages[start] as RequestMessage];
	if (request[0].role !== "user") return request;
	for (let index = start + 1; messages[index] && (messages[index]!.role === "custom" || outgoingOnly[index]); index++) {
		request.push(messages[index] as RequestMessage);
	}
	return request;
}

function groupContext(messages: readonly AgentMessage[], outgoingOnly: readonly boolean[]): GroupedContext {
	const requestIndexes = requestStartIndexes(messages, outgoingOnly);
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
	const request = requestEnvelope(activeMessages, 0, outgoingOnly.slice(activeStart));
	const exchanges: ToolExchange[] = [];
	const trailingOutgoing: AgentMessage[] = [];
	for (let index = request.length; index < activeMessages.length;) {
		const message = activeMessages[index];
		if (outgoingOnly[activeStart + index]) {
			trailingOutgoing.push(message);
			index++;
			continue;
		}
		if (message.role === "toolResult") throw structureError("Canonical context contains an orphan tool result.");
		if (message.role !== "assistant") throw structureError("Canonical active turn has an unsupported message structure.");
		const { exchange, nextIndex } = exchangeAt(activeMessages, index);
		exchanges.push(exchange);
		index = nextIndex;
	}
	return { prefixes, completedTurns, activeTurn: { kind: "activeTurn", request, exchanges, trailingOutgoing } };
}

type TokenCache = {
	messages: Map<AgentMessage, number>;
	units: WeakMap<readonly AgentMessage[], number>;
};

function messageEstimate(message: AgentMessage, cache: TokenCache): number {
	// Rendered system/tool metadata is already covered by residentTokenEstimate.
	if (message.role === "system") return 0;
	const cached = cache.messages.get(message);
	if (cached !== undefined) return cached;
	const estimate = estimateTokens(message);
	cache.messages.set(message, estimate);
	return estimate;
}

function unitEstimate(messages: readonly AgentMessage[], cache: TokenCache): number {
	const cached = cache.units.get(messages);
	if (cached !== undefined) return cached;
	const estimate = messages.reduce((total, message) => total + messageEstimate(message, cache), 0);
	cache.units.set(messages, estimate);
	return estimate;
}

type ModelTurnHistoryItem = Extract<HistoryItem, { kind: "modelTurn" }>;
type FallbackHistoryMessage = { message: AgentMessage; historyId: string };
type FallbackHistoryBucket = {
	messages: FallbackHistoryMessage[];
	serializedIds?: Map<string, string>;
};

function historyFallbackBucket(message: AgentMessage): string {
	return `${message.role}\u0000${message.timestamp}`;
}

// This stays local because it only supports one selectContext invocation.
class SelectionHistoryLookup {
	private readonly identities = new Map<AgentMessage, string>();
	private readonly toolTurns = new Map<string, ModelTurnHistoryItem>();
	private readonly fallbackBuckets = new Map<string, FallbackHistoryBucket>();
	private readonly serializations = new Map<AgentMessage, string>();
	private readonly items: readonly HistoryItem[] | undefined;

	constructor(items: readonly HistoryItem[] | undefined) {
		this.items = items;
		for (const item of items ?? []) {
			if (item.kind === "user") {
				this.addMessage(item.userMessage, item.id);
				continue;
			}
			this.addMessage(item.assistantMessage, item.id);
			for (const call of item.assistantMessage.content.filter(isToolCallBlock)) {
				this.toolTurns.set(call.id, item);
			}
			for (const result of item.toolResults) this.addMessage(result, item.id);
		}
	}

	historyId(message: AgentMessage): string | undefined {
		const identity = this.identities.get(message);
		if (identity !== undefined) return identity;
		const toolTurn = this.toolTurn(message);
		if (toolTurn) return toolTurn.id;
		const bucket = this.fallbackBuckets.get(historyFallbackBucket(message));
		if (!bucket) return undefined;
		const serialized = this.serialize(message);
		return this.serializedIds(bucket).get(serialized);
	}

	toolTurn(message: AgentMessage): ModelTurnHistoryItem | undefined {
		if (message.role === "toolResult") return this.toolTurns.get(message.toolCallId);
		if (message.role !== "assistant") return undefined;
		return message.content.filter(isToolCallBlock)
			.map((call) => this.toolTurns.get(call.id))
			.find((turn): turn is ModelTurnHistoryItem => turn !== undefined);
	}

	isLastItem(item: HistoryItem): boolean {
		return this.items?.at(-1) === item;
	}

	private addMessage(message: AgentMessage, historyId: string): void {
		if (!this.identities.has(message)) this.identities.set(message, historyId);
		const key = historyFallbackBucket(message);
		const bucket = this.fallbackBuckets.get(key) ?? { messages: [] };
		bucket.messages.push({ message, historyId });
		this.fallbackBuckets.set(key, bucket);
	}

	private serializedIds(bucket: FallbackHistoryBucket): Map<string, string> {
		if (bucket.serializedIds) return bucket.serializedIds;
		const serializedIds = new Map<string, string>();
		for (const candidate of bucket.messages) {
			const serialized = this.serialize(candidate.message);
			if (!serializedIds.has(serialized)) {
				serializedIds.set(serialized, candidate.historyId);
			}
		}
		bucket.serializedIds = serializedIds;
		return serializedIds;
	}

	private serialize(message: AgentMessage): string {
		const cached = this.serializations.get(message);
		if (cached !== undefined) return cached;
		const serialized = JSON.stringify(message);
		this.serializations.set(message, serialized);
		return serialized;
	}
}

function pagingNotice(
	budgetTokens: number,
	historyId: string | undefined,
	toolReference?: ToolRecoveryReference,
): UserMessage {
	const lines = [
		"[Context paging notice — generated by the extension]",
		`Older context left the ${budgetTokens.toLocaleString("en-US")}-token rolling window. Raw session history is unchanged.`,
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

function pagingNoticeKey(historyId: string | undefined, toolReference: ToolRecoveryReference | undefined): string {
	return JSON.stringify([
		historyId,
		toolReference?.historyId,
		toolReference?.toolCallId,
		toolReference?.toolName,
	]);
}

function protectedOverflowNotice(budgetTokens: number): UserMessage {
	return temporaryUserMessage([
		"[Context paging notice — generated by the extension]",
		"The newest tool-result exchange is present in full for this follow-up call.",
		`The normal rolling budget is ${budgetTokens.toLocaleString("en-US")} estimated tokens.`,
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

function toolRecoveryReference(message: AgentMessage, history: SelectionHistoryLookup): ToolRecoveryReference | undefined {
	if (message.role !== "toolResult") return undefined;
	const turn = history.toolTurn(message);
	return turn?.toolResults.some((result) => result.toolCallId === message.toolCallId)
		? { historyId: turn.id, toolCallId: message.toolCallId, toolName: message.toolName }
		: undefined;
}

function unreadTrailingExchange(grouped: GroupedContext, history: SelectionHistoryLookup): ToolExchange | undefined {
	if (!grouped.activeTurn) return undefined;
	const exchange = grouped.activeTurn.exchanges.at(-1);
	if (!exchange) return undefined;
	const calls = exchange.assistant.content.filter(isToolCallBlock);
	if (calls.length === 0) return undefined;
	const callIds = calls.map((call) => call.id);
	const turn = history.toolTurn(exchange.assistant);
	if (!turn || !history.isLastItem(turn)) return undefined;
	const rawCallIds = turn.assistantMessage.content.filter(isToolCallBlock).map((call) => call.id);
	const resultIds = exchange.results.map((result) => result.toolCallId);
	const rawResultIds = turn.toolResults.map((result) => result.toolCallId);
	if (rawCallIds.length !== callIds.length || rawResultIds.length !== resultIds.length
		|| rawCallIds.some((id, index) => id !== callIds[index])
		|| rawResultIds.some((id, index) => id !== resultIds[index])) return undefined;
	return exchange;
}

function recoveredProtectedExchange(exchange: ToolExchange, history: SelectionHistoryLookup): ToolExchange {
	const results = exchange.results.map((result) => {
		const turn = history.toolTurn(result);
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

function validContextTokens(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function selectContext(input: ContextSelectionInput): ContextSelection {
	if (
		input.modelContextWindow !== undefined
		&& (!Number.isFinite(input.modelContextWindow) || input.modelContextWindow <= 0)
	) {
		throw error("INVALID_MODEL_CONTEXT", "The active model context-window estimate is invalid.", 0, 0, 0);
	}
	if (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget <= 0) {
		throw error("INVALID_TOKEN_BUDGET", "The token budget must be a positive safe integer.", 0, 0, 0);
	}
	const budgetTokens = input.modelContextWindow === undefined
		? input.tokenBudget
		: Math.min(input.tokenBudget, input.modelContextWindow);
	const modelLimit = input.modelContextWindow ?? Number.POSITIVE_INFINITY;
	const residentTokens = residentTokenEstimate(input);
	const inputOutgoingOnly = input.outgoingOnly?.length === input.messages.length
		? input.outgoingOnly
		: input.messages.map(() => false);
	const { messages, outgoingOnly } = normalizeInterruptedExchanges(input.messages, inputOutgoingOnly);
	const grouped = groupContext(messages, outgoingOnly);
	const tokenCache: TokenCache = { messages: new Map(), units: new WeakMap() };
	const rawInputEstimate = residentTokens + unitEstimate(input.messages, tokenCache);
	const rawFullEstimate = messages === input.messages
		? rawInputEstimate
		: residentTokens + unitEstimate(messages, tokenCache);
	const contextTokens = validContextTokens(input.contextTokens) ? input.contextTokens : undefined;
	// Usage describes the incoming snapshot; normalization removes tokens, not its calibration.
	const calibration = contextTokens === undefined ? 0 : contextTokens - rawInputEstimate;
	// Keep one adjustment for this selection so each FIFO removal changes only its own estimate.
	const calibrated = (rawEstimate: number): number => rawEstimate + calibration;
	const reported = (rawEstimate: number): number => Math.max(0, calibrated(rawEstimate));
	if (contextTokens === undefined && residentTokens > budgetTokens) {
		throw error("RESIDENT_INPUT_TOO_LARGE", `Resident input estimate ${residentTokens} exceeds budget estimate ${budgetTokens}.`, residentTokens, residentTokens, budgetTokens);
	}

	const fullEstimate = calibrated(rawFullEstimate);
	if (fullEstimate <= budgetTokens) {
		return { messages, estimatedTokens: reported(rawFullEstimate), budgetTokens, mode: "within-budget" };
	}
	const history = new SelectionHistoryLookup(input.rawHistoryItems);
	if (!grouped.activeTurn) {
		const prefixes = grouped.prefixes;
		let prefixIndex = 0;
		let evictedHistoryId: string | undefined;
		let retainedTokens = rawFullEstimate - residentTokens;
		let notice: UserMessage | undefined;
		let noticeTokens = 0;
		let noticeKey: string | undefined;
		const updateNotice = () => {
			const nextKey = pagingNoticeKey(evictedHistoryId, undefined);
			if (nextKey === noticeKey) return;
			noticeKey = nextKey;
			notice = pagingNotice(budgetTokens, evictedHistoryId);
			noticeTokens = messageEstimate(notice, tokenCache);
		};
		while (calibrated(residentTokens + retainedTokens + noticeTokens) > budgetTokens) {
			if (prefixIndex === prefixes.length) {
				const estimatedTokens = reported(residentTokens + retainedTokens + noticeTokens);
				throw error("RESIDENT_INPUT_TOO_LARGE", `Resident and paging-notice estimate ${estimatedTokens} exceeds budget estimate ${budgetTokens}.`, residentTokens, estimatedTokens, budgetTokens);
			}
			const evicted = prefixes[prefixIndex++]!;
			retainedTokens -= unitEstimate(evicted.messages, tokenCache);
			for (const message of evicted.messages) {
				evictedHistoryId = history.historyId(message) ?? evictedHistoryId;
			}
			updateNotice();
		}
		const messages = [...(notice ? [notice] : []), ...prefixes.slice(prefixIndex).flatMap((unit) => unit.messages)];
		return { messages, estimatedTokens: reported(residentTokens + retainedTokens + noticeTokens), budgetTokens, mode: "paged" };
	}

	const activeRequestTokens = residentTokens
		+ unitEstimate(grouped.activeTurn.request, tokenCache)
		+ unitEstimate(grouped.activeTurn.trailingOutgoing, tokenCache);
	if (calibrated(activeRequestTokens) > budgetTokens) {
		const estimatedTokens = reported(activeRequestTokens);
		throw error("ACTIVE_REQUEST_TOO_LARGE", `Resident plus active request estimate ${estimatedTokens} exceeds budget estimate ${budgetTokens}.`, residentTokens, estimatedTokens, budgetTokens);
	}

	const prefixes = grouped.prefixes;
	const completedTurns = grouped.completedTurns;
	const exchanges = [...grouped.activeTurn.exchanges];
	let prefixIndex = 0;
	let completedTurnIndex = 0;
	let exchangeIndex = 0;
	const protectedExchange = unreadTrailingExchange(grouped, history);
	const protectedExchangeIndex = protectedExchange ? exchanges.indexOf(protectedExchange) : -1;
	let evictedHistoryId: string | undefined;
	let evictedToolReference: ToolRecoveryReference | undefined;
	let retainedTokens = rawFullEstimate - residentTokens;
	let notice: UserMessage | undefined;
	let noticeTokens = 0;
	let noticeKey: string | undefined;
	const messagesFor = (selectionNotice: UserMessage | undefined): AgentMessage[] => [
		...(selectionNotice ? [selectionNotice] : []),
		...prefixes.slice(prefixIndex).flatMap((unit) => unit.messages),
		...completedTurns.slice(completedTurnIndex).flatMap((unit) => unit.messages),
		...grouped.activeTurn!.request,
		...exchanges.slice(exchangeIndex).flatMap((exchange) => exchange.messages),
		...grouped.activeTurn!.trailingOutgoing,
	];
	const updateNotice = () => {
		const nextKey = pagingNoticeKey(evictedHistoryId, evictedToolReference);
		if (nextKey === noticeKey) return;
		noticeKey = nextKey;
		notice = pagingNotice(budgetTokens, evictedHistoryId, evictedToolReference);
		noticeTokens = messageEstimate(notice, tokenCache);
	};
	const remove = (messages: readonly AgentMessage[]) => {
		for (const message of messages) {
			evictedHistoryId = history.historyId(message) ?? evictedHistoryId;
			evictedToolReference ??= toolRecoveryReference(message, history);
		}
		updateNotice();
	};

	while (calibrated(residentTokens + retainedTokens + noticeTokens) > budgetTokens) {
		if (prefixIndex < prefixes.length) {
			const evicted = prefixes[prefixIndex++]!;
			retainedTokens -= unitEstimate(evicted.messages, tokenCache);
			remove(evicted.messages);
			continue;
		}
		if (completedTurnIndex < completedTurns.length) {
			const evicted = completedTurns[completedTurnIndex++]!;
			retainedTokens -= unitEstimate(evicted.messages, tokenCache);
			remove(evicted.messages);
			continue;
		}
		if (exchangeIndex < exchanges.length && exchangeIndex !== protectedExchangeIndex) {
			const evicted = exchanges[exchangeIndex++]!;
			retainedTokens -= unitEstimate(evicted.messages, tokenCache);
			remove(evicted.messages);
			continue;
		}
		if (protectedExchange) {
			const overflowNotice = protectedOverflowNotice(budgetTokens);
			const overflowEstimate = residentTokens + retainedTokens + messageEstimate(overflowNotice, tokenCache);
			if (calibrated(overflowEstimate) <= modelLimit) {
				return { messages: messagesFor(overflowNotice), estimatedTokens: reported(overflowEstimate), budgetTokens, mode: "protected-overflow" };
			}
			const replacement = recoveredProtectedExchange(protectedExchange, history);
			exchanges[protectedExchangeIndex] = replacement;
			retainedTokens += unitEstimate(replacement.messages, tokenCache) - unitEstimate(protectedExchange.messages, tokenCache);
			const recovery = recoveryNotice();
			const recoveredEstimate = residentTokens + retainedTokens + messageEstimate(recovery, tokenCache);
			if (calibrated(recoveredEstimate) <= modelLimit) {
				return { messages: messagesFor(recovery), estimatedTokens: reported(recoveredEstimate), budgetTokens, mode: "recovery" };
			}
			const estimatedTokens = reported(recoveredEstimate);
			throw error("ACTIVE_REQUEST_TOO_LARGE", `Protected exchange recovery estimate ${estimatedTokens} exceeds model context estimate ${input.modelContextWindow}.`, residentTokens, estimatedTokens, budgetTokens);
		}
		const estimatedTokens = reported(residentTokens + retainedTokens + noticeTokens);
		throw error("ACTIVE_REQUEST_TOO_LARGE", `Resident plus active request estimate ${estimatedTokens} exceeds budget estimate ${budgetTokens}.`, residentTokens, estimatedTokens, budgetTokens);
	}

	return { messages: messagesFor(notice), estimatedTokens: reported(residentTokens + retainedTokens + noticeTokens), budgetTokens, mode: "paged" };
}
