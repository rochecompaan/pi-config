import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { extractCopyItems } from "./extract.ts";

export type BranchEntry = ReturnType<
	ExtensionCommandContext["sessionManager"]["getBranch"]
>[number];

type AssistantEntry = {
	id: string;
	timestamp: string;
	content: unknown;
};

export type CopyItemKind = "message" | "pipe-message" | "code" | "inline";
export type CopyAction = "copy" | "insert";

export type CopyItem = {
	id: string;
	kind: CopyItemKind;
	content: string;
	messageId: string;
	sourceLabel: string;
	sourcePosition: number;
	language?: string;
};

export type ExtractedCopyItem = Pick<
	CopyItem,
	"kind" | "content" | "sourcePosition" | "language"
>;

export type CopySelection = {
	item: CopyItem;
	action: CopyAction;
};

const COPY_ITEM_KIND_LABELS: Record<CopyItemKind, string> = {
	message: "message",
	"pipe-message": "pipe message",
	code: "code",
	inline: "inline",
};

export function copyItemKindLabel(kind: CopyItemKind): string {
	return COPY_ITEM_KIND_LABELS[kind];
}

export function isInsertableCopyItem(item: CopyItem): boolean {
	return item.kind === "code" || item.kind === "inline";
}

export function extractAssistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.flatMap((part) => {
			if (!part || typeof part !== "object") return [];
			if ((part as { type?: unknown }).type !== "text") return [];
			const text = (part as { text?: unknown }).text;
			return typeof text === "string" && text.length > 0 ? [text] : [];
		})
		.join("\n\n");
}

function asAssistantEntry(entry: BranchEntry): AssistantEntry | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as { role?: unknown; content?: unknown };
	if (message.role !== "assistant") return undefined;
	return { id: entry.id, timestamp: entry.timestamp, content: message.content };
}

export function collectCopyItems(entries: BranchEntry[]): CopyItem[] {
	const assistantEntries = entries
		.flatMap((entry) => {
			const assistant = asAssistantEntry(entry);
			return assistant ? [assistant] : [];
		})
		.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));

	const items: CopyItem[] = [];
	for (const entry of assistantEntries) {
		const content = extractAssistantText(entry.content);
		if (content.length === 0) continue;
		const sourceLabel = new Date(entry.timestamp).toLocaleTimeString();
		items.push({
			id: `${entry.id}:message`,
			kind: "message",
			content,
			messageId: entry.id,
			sourceLabel,
			sourcePosition: -1,
		});

		for (const extracted of extractCopyItems(content)) {
			items.push({
				...extracted,
				id: `${entry.id}:${extracted.kind}:${extracted.sourcePosition}`,
				messageId: entry.id,
				sourceLabel,
			});
		}
	}
	return items;
}
