import { copyItemKindLabel, type CopyItem } from "./copy-items.ts";
import type { PickerListAdapter, PickerListItem } from "./picker-controller.ts";

export type PickerRow = {
	text: string;
	style: "header" | "item" | "selected" | "dim" | "warning";
	item?: PickerListItem;
	group?: PickerListItem["group"];
};

function messageTitle(content: string): string {
	for (const line of content.split(/\r?\n/)) {
		const opening = line.trim();
		if (/^(?:`{3,}|~{3,})/.test(opening) || /^(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(opening)) continue;
		const title = opening
			.replace(/^#{1,6}(?:\s+|$)/, "")
			.replace(/\s+#+$/, "")
			.replace(/^(?:>\s*)+/, "")
			.replace(/^(?:[-+*]|\d+[.)])\s+/, "")
			.replace(/\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`/g, "$1$2$3")
			.replace(/\s+/g, " ").trim();
		if (title) return title;
	}
	return "Assistant message";
}

export function buildPickerItems(copyItems: readonly CopyItem[]): PickerListItem[] {
	const messages = new Map(copyItems.filter((item) => item.kind === "message")
		.map((item) => [item.messageId, {
			id: item.messageId,
			label: `${item.sourceLabel} · ${messageTitle(item.content)}`,
			sourceLabel: item.sourceLabel,
			title: messageTitle(item.content),
		}]));
	const kinds = copyItems.map((item) => {
		const kind = copyItemKindLabel(item.kind);
		const label = kind[0]!.toUpperCase() + kind.slice(1);
		return item.language ? `${label} · ${item.language}` : label;
	});
	const labelWidth = Math.max(0, ...kinds.map((kind) => kind.length));
	return copyItems.map((item, index) => ({
		value: String(index),
		kind: item.kind,
		label: item.kind === "message" ? "Full message" : kinds[index]!.padEnd(labelWidth),
		description: item.kind === "message" ? undefined : item.content.replace(/\s+/g, " ").trim(),
		group: messages.get(item.messageId) ?? {
			id: item.messageId,
			label: `${item.sourceLabel} · ${messageTitle(item.content)}`,
			sourceLabel: item.sourceLabel,
			title: messageTitle(item.content),
		},
	}));
}

/** Selectable actions and their display-only headers share one bounded viewport. */
export class GroupedPickerList implements PickerListAdapter {
	private items: PickerListItem[];
	private selectedIndex = 0;
	private startIndex = 0;
	private maxRows: number;

	constructor(items: PickerListItem[], maxRows: number) {
		this.items = items;
		this.maxRows = Math.max(2, maxRows);
	}

	setMaxRows(maxRows: number): void {
		this.maxRows = Math.max(2, maxRows);
	}

	getSelectedItem(): PickerListItem | undefined {
		return this.items[this.selectedIndex];
	}

	replaceItems(items: PickerListItem[]): void {
		this.items = items;
		this.selectedIndex = 0;
		this.startIndex = 0;
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.items.length - 1));
	}

	pageSelection(direction: -1 | 1): void {
		if (this.items.length === 0) return;
		const current = this.selectedIndex;
		if (direction === 1) {
			const { endIndex } = this.windowFrom(current);
			this.setSelectedIndex(Math.max(current + 1, endIndex - 1));
			this.startIndex = current;
		} else {
			let start = Math.max(0, current - 1);
			while (start > 0 && this.windowFrom(start - 1).endIndex > current) start -= 1;
			this.setSelectedIndex(start);
			this.startIndex = start;
		}
	}

	// Keyboard routing belongs to the picker controller; rows never take focus.
	handleInput(_data: string): void {}
	invalidate(): void {} // Rows are rebuilt for each render, including theme changes.

	renderRows(): PickerRow[] {
		if (this.items.length === 0) return [{ text: "  No matching items", style: "warning" }];
		this.startIndex = Math.min(this.startIndex, this.selectedIndex);
		let window = this.windowFrom(this.startIndex);
		while (window.endIndex <= this.selectedIndex) {
			this.startIndex += 1;
			window = this.windowFrom(this.startIndex);
		}
		if (this.startIndex > 0 || window.endIndex < this.items.length) {
			window.rows.push({ text: `  (${this.selectedIndex + 1}/${this.items.length})`, style: "dim" });
		}
		return window.rows;
	}

	private windowFrom(start: number): { rows: PickerRow[]; endIndex: number } {
		const rows: PickerRow[] = [];
		let index = start;
		for (; index < this.items.length; index++) {
			const item = this.items[index]!;
			const newGroup = item.group && (index === start || item.group.id !== this.items[index - 1]?.group?.id);
			const headerRows = newGroup ? (rows.length > 0 ? 2 : 1) : 0;
			// Reserve space for the action as well, so headers are never stranded.
			if (rows.length + headerRows + 1 > this.maxRows) break;
			if (newGroup) {
				if (rows.length > 0) rows.push({ text: "", style: "dim" });
				rows.push({ text: `── ${item.group!.label}`, style: "header", group: item.group });
			}
			const selected = index === this.selectedIndex;
			const description = item.description ? `  ${item.description}` : "";
			rows.push({ text: `${selected ? "  › " : "    "}${item.label}${description}`, style: selected ? "selected" : "item", item });
		}
		return { rows, endIndex: index };
	}
}
