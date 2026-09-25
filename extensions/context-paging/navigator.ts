import { isPagingToolTurn, type HistoryItem } from "./history.ts";

const K1 = 1.2;
const B = 0.75;

export type HistorySearchInput = {
	query: string;
	files?: string[];
	tools?: string[];
	failed?: boolean;
	limit?: number;
};

export type HistoryBrowseInput = {
	historyId?: string;
	sequence?: number;
	direction: "backward" | "forward" | "around";
	count?: number;
	stride?: number;
};

export type HistoryReference = {
	historyId: string;
	sequence: number;
	kind: HistoryItem["kind"];
	timestamp: string;
	preview: string;
	tools: string[];
	files: string[];
	failed: boolean;
	previousHistoryId: string | null;
	nextHistoryId: string | null;
};

export type HistoryNavigatorErrorCode =
	| "INVALID_HISTORY_NAVIGATOR_INPUT"
	| "UNKNOWN_HISTORY_ANCHOR"
	| "UNKNOWN_HISTORY_ID";

export class HistoryNavigatorError extends Error {
	readonly code: HistoryNavigatorErrorCode;

	constructor(code: HistoryNavigatorErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = "HistoryNavigatorError";
	}
}

type SearchDocument = {
	terms: Map<string, number>;
	length: number;
};

function tokenize(text: string): string[] {
	return text.toLowerCase().match(/\p{Script=Han}|[\p{L}\p{N}_./:-]+/gu) ?? [];
}

function serialized(value: unknown): string {
	const result = JSON.stringify(value);
	return result === undefined ? "" : result;
}

function itemText(item: HistoryItem): string {
	if (item.kind === "user") {
		return typeof item.userMessage.content === "string"
			? item.userMessage.content
			: serialized(item.userMessage.content);
	}

	const toolCalls = item.assistantMessage.content.flatMap((block) => {
		if (typeof block !== "object" || block === null
			|| (block as { type?: unknown }).type !== "toolCall"
			|| typeof (block as { name?: unknown }).name !== "string") return [];
		const call = block as { name: string; arguments: unknown };
		return [call];
	});
	const fileSegments = item.metadata.files.flatMap((file) => file.split(/[\\/]/));
	return [
		serialized(item.assistantMessage.content),
		...toolCalls.flatMap((call) => [call.name, serialized(call.arguments)]),
		...item.toolResults.map((result) => serialized(result.content)),
		...item.metadata.files,
		...fileSegments,
	].join(" ");
}

function previewFor(item: HistoryItem): string {
	if (item.kind === "user") {
		const content = item.userMessage.content;
		return (typeof content === "string" ? content : serialized(content)).replace(/\s+/g, " ").trim().slice(0, 160);
	}
	const content = item.assistantMessage.content.map((block) =>
		typeof block === "object" && block !== null
		&& (block as { type?: unknown }).type === "text"
		&& typeof (block as { text?: unknown }).text === "string"
			? (block as { text: string }).text
			: serialized(block),
	).join(" ");
	return content.replace(/\s+/g, " ").trim().slice(0, 160);
}

function buildReference(item: HistoryItem, index: number, items: readonly HistoryItem[]): HistoryReference {
	const metadata = item.kind === "modelTurn" ? item.metadata : { tools: [], files: [], failed: false };
	return {
		historyId: item.id,
		sequence: item.sequence,
		kind: item.kind,
		timestamp: item.timestamp,
		preview: previewFor(item),
		tools: metadata.tools,
		files: metadata.files,
		failed: metadata.failed,
		previousHistoryId: items[index - 1]?.id ?? null,
		nextHistoryId: items[index + 1]?.id ?? null,
	};
}

function invalid(message: string): never {
	throw new HistoryNavigatorError("INVALID_HISTORY_NAVIGATOR_INPUT", message);
}

function validateString(value: unknown, label: string, maximum: number): asserts value is string {
	if (typeof value !== "string" || value.length > maximum) invalid(`${label} must be a string of at most ${maximum} characters`);
}

function validateStringArray(value: unknown, label: string): asserts value is string[] {
	if (!Array.isArray(value) || value.length > 10) invalid(`${label} must contain at most 10 strings`);
	for (const item of value) validateString(item, `${label} item`, 200);
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		invalid(`${label} must be an integer from ${minimum} to ${maximum}`);
	}
	return value as number;
}

function directionalIndexes(
	length: number,
	anchorIndex: number | undefined,
	direction: "backward" | "forward",
	count: number,
	stride: number,
): number[] {
	const step = direction === "backward" ? -stride : stride;
	let current = anchorIndex === undefined
		? direction === "backward" ? length - 1 : 0
		: anchorIndex + step;
	const indexes: number[] = [];
	while (indexes.length < count && current >= 0 && current < length) {
		indexes.push(current);
		current += step;
	}
	return indexes;
}

function aroundIndexes(length: number, anchorIndex: number, count: number, stride: number): number[] {
	const candidates: number[] = [anchorIndex];
	for (let index = anchorIndex - stride; index >= 0; index -= stride) candidates.unshift(index);
	for (let index = anchorIndex + stride; index < length; index += stride) candidates.push(index);

	const anchorPosition = candidates.indexOf(anchorIndex);
	const itemsBefore = Math.floor((count - 1) / 2);
	const maximumStart = Math.max(0, candidates.length - count);
	const start = Math.max(0, Math.min(anchorPosition - itemsBefore, maximumStart));
	return candidates.slice(start, start + count);
}

/** Indexes visible history items for compact search, browsing, and exact loads. */
export class HistoryNavigator {
	private items: HistoryItem[] = [];
	private itemById = new Map<string, HistoryItem>();
	private itemBySequence = new Map<number, HistoryItem>();
	private references: HistoryReference[] = [];
	private searchDocuments: SearchDocument[] | undefined;
	private documentFrequencies = new Map<string, number>();
	private averageDocumentLength = 0;

	constructor(items: readonly HistoryItem[] = []) {
		this.rebuild(items);
	}

	rebuild(items: readonly HistoryItem[]): void {
		this.items = items
			.filter((item) => !isPagingToolTurn(item))
			.map((item, sequence) => ({ ...item, sequence }));
		this.itemById = new Map(this.items.map((item) => [item.id, item]));
		this.itemBySequence = new Map(this.items.map((item) => [item.sequence, item]));
		this.references = this.items.map((item, index) => buildReference(item, index, this.items));
		this.searchDocuments = undefined;
		this.documentFrequencies = new Map();
		this.averageDocumentLength = 0;
	}

	search(input: HistorySearchInput): HistoryReference[] {
		validateString(input.query, "query", 200);
		if (input.files !== undefined) validateStringArray(input.files, "files");
		if (input.tools !== undefined) validateStringArray(input.tools, "tools");
		if (input.failed !== undefined && typeof input.failed !== "boolean") invalid("failed must be a boolean");
		const limit = input.limit === undefined ? 5 : boundedInteger(input.limit, "limit", 1, 10);
		const queryTerms = [...new Set(tokenize(input.query))];
		if (input.query.length > 0 && queryTerms.length === 0) return [];
		const searchDocuments = this.searchDocuments ?? this.buildSearchIndex();
		const totalDocuments = searchDocuments.length;

		return this.items
			.map((item, index) => ({ item, index, score: this.bm25Score(index, queryTerms, totalDocuments) }))
			.filter(({ item, score }) => score !== undefined && this.matchesFilters(item, input))
			.sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.item.sequence - right.item.sequence)
			.slice(0, limit)
			.map(({ index }) => this.references[index]);
	}

	browse(input: HistoryBrowseInput): HistoryReference[] {
		if (input.direction !== "backward" && input.direction !== "forward" && input.direction !== "around") {
			invalid("direction must be backward, forward, or around");
		}
		if (input.historyId !== undefined && input.sequence !== undefined) {
			throw new HistoryNavigatorError("UNKNOWN_HISTORY_ANCHOR", "Specify historyId or sequence, not both");
		}
		if (input.historyId !== undefined) validateString(input.historyId, "historyId", 128);
		if (input.sequence !== undefined) boundedInteger(input.sequence, "sequence", 0, 1_000_000);
		const count = input.count === undefined ? 5 : boundedInteger(input.count, "count", 1, 10);
		const stride = input.stride === undefined ? 1 : boundedInteger(input.stride, "stride", 1, 10);

		const anchor = this.resolveAnchor(input);
		if (this.items.length === 0 && anchor === undefined) return [];
		const anchorIndex = anchor?.sequence;
		const indexes = input.direction === "around"
			? aroundIndexes(this.items.length, anchorIndex ?? this.items.length - 1, count, stride)
			: directionalIndexes(this.items.length, anchorIndex, input.direction, count, stride);
		return indexes.map((index) => this.references[index]);
	}

	load(historyIds: readonly string[]): HistoryItem[] {
		if (!Array.isArray(historyIds) || historyIds.length < 1 || historyIds.length > 3) {
			invalid("historyIds must contain one to three IDs");
		}
		for (const historyId of historyIds) validateString(historyId, "history ID", 128);
		const resolved = historyIds.map((historyId) => this.itemById.get(historyId));
		const missingIndex = resolved.findIndex((item) => item === undefined);
		if (missingIndex !== -1) {
			throw new HistoryNavigatorError("UNKNOWN_HISTORY_ID", `Unknown history ID ${historyIds[missingIndex]}`);
		}
		return resolved as HistoryItem[];
	}

	private buildSearchIndex(): SearchDocument[] {
		this.documentFrequencies = new Map();
		this.searchDocuments = this.items.map((item) => {
			const terms = new Map<string, number>();
			for (const term of tokenize(itemText(item))) terms.set(term, (terms.get(term) ?? 0) + 1);
			for (const term of terms.keys()) this.documentFrequencies.set(term, (this.documentFrequencies.get(term) ?? 0) + 1);
			return { terms, length: [...terms.values()].reduce((sum, frequency) => sum + frequency, 0) };
		});
		this.averageDocumentLength = this.searchDocuments.length === 0
			? 0
			: this.searchDocuments.reduce((sum, document) => sum + document.length, 0) / this.searchDocuments.length;
		return this.searchDocuments;
	}

	private bm25Score(index: number, queryTerms: string[], totalDocuments: number): number | undefined {
		if (queryTerms.length === 0) return 0;
		const document = this.searchDocuments![index];
		let score = 0;
		let matched = false;
		for (const term of queryTerms) {
			const frequency = document.terms.get(term) ?? 0;
			if (frequency === 0) continue;
			matched = true;
			const documentFrequency = this.documentFrequencies.get(term) ?? 0;
			const idf = Math.log(1 + (totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5));
			const lengthRatio = this.averageDocumentLength === 0 ? 0 : document.length / this.averageDocumentLength;
			score += idf * (frequency * (K1 + 1)) / (frequency + K1 * (1 - B + B * lengthRatio));
		}
		return matched ? score : undefined;
	}

	private matchesFilters(item: HistoryItem, input: HistorySearchInput): boolean {
		const metadata = item.kind === "modelTurn" ? item.metadata : { tools: [], files: [], failed: false };
		return (input.files === undefined || input.files.every((file) => metadata.files.includes(file)))
			&& (input.tools === undefined || input.tools.every((tool) => metadata.tools.includes(tool)))
			&& (input.failed === undefined || input.failed === metadata.failed);
	}

	private resolveAnchor(input: HistoryBrowseInput): HistoryItem | undefined {
		if (input.historyId === undefined && input.sequence === undefined) return undefined;
		const item = input.historyId === undefined
			? this.itemBySequence.get(input.sequence!)
			: this.itemById.get(input.historyId);
		if (item === undefined) throw new HistoryNavigatorError("UNKNOWN_HISTORY_ANCHOR", "Unknown history anchor");
		return item;
	}
}
