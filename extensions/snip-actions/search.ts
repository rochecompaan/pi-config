// Adapted from @signalridge/pi-code-actions. See NOTICE.
import type { SelectItem } from "@earendil-works/pi-tui";
import { copyItemKindLabel, type CopyItem } from "./copy-items.ts";

export type SearchIndexItem = {
	item: SelectItem;
	index: number;
	raw: string;
	normalized: string;
};

export function normalizeForSearch(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function buildSearchIndex(
	copyItems: CopyItem[],
	selectItems: SelectItem[],
): SearchIndexItem[] {
	return copyItems.flatMap((copyItem, index) => {
		const item = selectItems[index];
		if (!item) return [];
		const raw = [
			copyItem.content,
			copyItemKindLabel(copyItem.kind),
			copyItem.language ?? "",
			copyItem.sourceLabel,
		].join(" ").toLowerCase();
		return [{ item, index, raw, normalized: normalizeForSearch(raw) }];
	});
}

export function rankedFilterItems(
	filter: string,
	items: SelectItem[],
	searchIndex: SearchIndexItem[],
): SelectItem[] {
	const lower = filter.toLowerCase();
	if (lower.length === 0) return items;
	const normalized = normalizeForSearch(lower);
	const tokens = normalized.length > 0 ? normalized.split(" ") : [];
	const scored: Array<{ item: SelectItem; index: number; score: number }> = [];

	for (const entry of searchIndex) {
		let score = 0;
		const rawIndex = entry.raw.indexOf(lower);
		if (rawIndex !== -1) {
			score = 1000 - rawIndex;
		} else if (tokens.length > 0) {
			if (tokens.some((token) => entry.normalized.indexOf(token) === -1)) continue;
			score = 500;
		} else {
			continue;
		}
		scored.push({ item: entry.item, index: entry.index, score });
	}

	scored.sort((left, right) => right.score - left.score || left.index - right.index);
	return scored.map((entry) => entry.item);
}
