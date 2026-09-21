import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";

export const PAGING_TOOL_NAMES = [
	"search_history",
	"browse_history",
	"load_history",
	"read_context_output",
] as const;

export type PagingToolName = typeof PAGING_TOOL_NAMES[number];

export type HistoryMetadata = {
	tools: string[];
	files: string[];
	failed: boolean;
};

export type UserHistoryItem = {
	id: string;
	kind: "user";
	sequence: number;
	timestamp: string;
	userMessage: UserMessage;
};

export type ModelTurnHistoryItem = {
	id: string;
	kind: "modelTurn";
	sequence: number;
	timestamp: string;
	assistantMessage: AssistantMessage;
	toolResults: ToolResultMessage[];
	metadata: HistoryMetadata;
};

export type HistoryItem = UserHistoryItem | ModelTurnHistoryItem;

export type HistoryProjectionErrorCode =
	| "ORPHAN_TOOL_RESULT"
	| "INCOMPLETE_TOOL_RESULTS"
	| "DUPLICATE_TOOL_RESULT";

export class HistoryProjectionError extends Error {
	readonly code: HistoryProjectionErrorCode;

	constructor(code: HistoryProjectionErrorCode) {
		super(code);
		this.code = code;
		this.name = "HistoryProjectionError";
	}
}

const PAGING_TOOL_SET = new Set<string>(PAGING_TOOL_NAMES);
const FILE_ARGUMENT_KEYS = new Set(["path", "file", "files", "filepath", "file_path"]);

type RelevantMessageEntry = Extract<SessionEntry, { type: "message" }>;

type ToolCallBlock = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: unknown;
};

function isToolCallBlock(block: unknown): block is ToolCallBlock {
	return typeof block === "object" && block !== null
		&& (block as { type?: unknown }).type === "toolCall"
		&& typeof (block as { id?: unknown }).id === "string"
		&& typeof (block as { name?: unknown }).name === "string";
}

function toolCalls(message: AssistantMessage): ToolCallBlock[] {
	return message.content.filter(isToolCallBlock);
}

function collectFiles(value: unknown, files: string[], seen: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectFiles(item, files, seen);
		return;
	}
	if (typeof value !== "object" || value === null) return;

	for (const [key, child] of Object.entries(value)) {
		if (FILE_ARGUMENT_KEYS.has(key.toLowerCase())) {
			const candidates = typeof child === "string"
				? [child]
				: Array.isArray(child) ? child.filter((item): item is string => typeof item === "string") : [];
			for (const file of candidates) {
				if (!seen.has(file)) {
					seen.add(file);
					files.push(file);
				}
			}
		}
		collectFiles(child, files, seen);
	}
}

function metadataFor(message: AssistantMessage, results: ToolResultMessage[]): HistoryMetadata {
	const files: string[] = [];
	const seenFiles = new Set<string>();
	const calls = toolCalls(message);
	for (const call of calls) collectFiles(call.arguments, files, seenFiles);
	return {
		tools: calls.map((call) => call.name),
		files,
		failed: results.some((result) => result.isError),
	};
}

function relevantEntries(entries: readonly SessionEntry[]): RelevantMessageEntry[] {
	return entries.filter(
		(entry): entry is RelevantMessageEntry => entry.type === "message"
			&& (entry.message.role === "user" || entry.message.role === "assistant" || entry.message.role === "toolResult"),
	);
}

export function projectActiveBranch(entries: readonly SessionEntry[]): HistoryItem[] {
	const messages = relevantEntries(entries);
	const items: HistoryItem[] = [];

	for (let index = 0; index < messages.length; index++) {
		const entry = messages[index];
		if (entry.message.role === "user") {
			items.push({
				id: entry.id,
				kind: "user",
				sequence: items.length,
				timestamp: entry.timestamp,
				userMessage: entry.message,
			});
			continue;
		}
		if (entry.message.role === "toolResult") {
			throw new HistoryProjectionError("ORPHAN_TOOL_RESULT");
		}

		const calls = toolCalls(entry.message);
		const expectedIds = new Set(calls.map((call) => call.id));
		const seenIds = new Set<string>();
		const results: ToolResultMessage[] = [];
		let resultIndex = index + 1;
		while (resultIndex < messages.length && messages[resultIndex].message.role === "toolResult") {
			const result = messages[resultIndex].message;
			if (!expectedIds.has(result.toolCallId)) throw new HistoryProjectionError("ORPHAN_TOOL_RESULT");
			if (seenIds.has(result.toolCallId)) throw new HistoryProjectionError("DUPLICATE_TOOL_RESULT");
			seenIds.add(result.toolCallId);
			results.push(result);
			resultIndex++;
		}

		if (seenIds.size !== expectedIds.size) {
			if (resultIndex === messages.length) break;
			throw new HistoryProjectionError("INCOMPLETE_TOOL_RESULTS");
		}

		items.push({
			id: entry.id,
			kind: "modelTurn",
			sequence: items.length,
			timestamp: entry.timestamp,
			assistantMessage: entry.message,
			toolResults: results,
			metadata: metadataFor(entry.message, results),
		});
		index = resultIndex - 1;
	}

	return items;
}

export function isPagingToolTurn(item: HistoryItem): boolean {
	return item.kind === "modelTurn" && item.metadata.tools.some((name) => PAGING_TOOL_SET.has(name));
}

export function flattenHistoryItems(items: readonly HistoryItem[]): AgentMessage[] {
	return items.flatMap((item) => item.kind === "user"
		? [item.userMessage]
		: [item.assistantMessage, ...item.toolResults]);
}
