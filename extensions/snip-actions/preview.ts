import { copyItemKindLabel, type CopyItem } from "./copy-items.ts";

export type CopyItemPreview = {
	title: string;
	content: string;
	item?: CopyItem;
};

export function limitPreviewLines(lines: readonly string[], maxLines: number): string[] {
	if (maxLines <= 0) return [];
	if (lines.length <= maxLines) return [...lines];
	if (maxLines === 1) return ["…"];
	return [...lines.slice(0, maxLines - 1), "…"];
}

export function buildCopyItemPreview(
	copyItems: readonly CopyItem[],
	selectedValue: string | undefined,
): CopyItemPreview {
	const index = Number.parseInt(selectedValue ?? "", 10);
	const item = Number.isNaN(index) ? undefined : copyItems[index];
	if (!item) {
		return { title: "Preview", content: "No matching item." };
	}

	const language = item.language ? ` (${item.language})` : "";
	return {
		title: `Preview — ${copyItemKindLabel(item.kind)}${language}`,
		content: item.content,
		item,
	};
}
