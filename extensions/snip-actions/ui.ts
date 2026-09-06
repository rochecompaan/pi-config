// Adapted from @signalridge/pi-code-actions. See NOTICE.
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyHint } from "@earendil-works/pi-coding-agent";
import {
	Container,
	decodeKittyPrintable,
	matchesKey,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";
import {
	copyItemKindLabel,
	isInsertableCopyItem,
	type CopyItem,
	type CopySelection,
} from "./copy-items.ts";
import { buildSearchIndex, rankedFilterItems } from "./search.ts";

const PREVIEW_WIDTH = 52;

function compactPreview(content: string): string {
	const preview = content.replace(/\s+/g, " ").trim();
	if (preview.length === 0) return "(empty)";
	return preview.length <= PREVIEW_WIDTH ? preview : `${preview.slice(0, PREVIEW_WIDTH - 1)}…`;
}

function buildItemLabel(item: CopyItem, index: number, indexWidth: number, timeWidth: number): string {
	const number = String(index + 1).padStart(indexWidth, " ");
	const time = item.sourceLabel.padEnd(timeWidth, " ");
	const language = item.language ? ` (${item.language})` : "";
	return `${number}. ${copyItemKindLabel(item.kind)} ${time}${language} ${compactPreview(item.content)}`;
}

function printableInput(data: string): string | undefined {
	const kittyPrintable = decodeKittyPrintable(data);
	if (kittyPrintable) return kittyPrintable;
	const hasControlChars = [...data].some((character) => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
	});
	return hasControlChars ? undefined : data;
}

export async function pickCopyItem(
	ctx: ExtensionCommandContext,
	copyItems: CopyItem[],
): Promise<CopySelection | undefined> {
	const indexWidth = String(copyItems.length).length;
	const timeWidth = Math.max(...copyItems.map((item) => item.sourceLabel.length));
	const maxVisible = Math.min(copyItems.length, 12);
	const selectItems: SelectItem[] = copyItems.map((item, index) => ({
		value: String(index),
		label: buildItemLabel(item, index, indexWidth, timeWidth),
		description: "",
	}));
	const searchIndex = buildSearchIndex(copyItems, selectItems);

	const encoded = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Copy message or code")), 1, 0));

		const list = new SelectList(selectItems, maxVisible, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		container.addChild(list);

		let filter = "";
		let filteredItems = selectItems;
		const help = new Text("", 1, 0);
		const updateHelp = (): void => {
			help.setText(theme.fg(
				"dim",
				`Filter: ${filter || "(none)"} · ${keyHint("tui.select.confirm", "copy")} · Right insert code · ${keyHint("tui.select.cancel", "cancel")}`,
			));
		};
		const updateFilter = (next: string): void => {
			filter = next;
			const state = list as unknown as { filteredItems: SelectItem[]; selectedIndex: number };
			filteredItems = rankedFilterItems(filter, selectItems, searchIndex);
			state.filteredItems = filteredItems;
			state.selectedIndex = 0;
			updateHelp();
			list.invalidate();
			tui.requestRender();
		};
		const selectedIndex = (): number | undefined => {
			const selected = list.getSelectedItem();
			if (!selected) return undefined;
			const index = Number.parseInt(selected.value, 10);
			return Number.isNaN(index) ? undefined : index;
		};
		const moveSelection = (offset: number, wrap: boolean): void => {
			if (filteredItems.length === 0) return;
			const selected = list.getSelectedItem();
			const currentIndex = selected ? Math.max(filteredItems.indexOf(selected), 0) : 0;
			const nextIndex = wrap
				? (currentIndex + offset + filteredItems.length) % filteredItems.length
				: currentIndex + offset;
			list.setSelectedIndex(nextIndex);
			tui.requestRender();
		};

		list.onSelect = (selected) => done(`copy:${selected.value}`);
		list.onCancel = () => done(null);
		updateHelp();
		container.addChild(help);
		container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (keybindings.matches(data, "tui.select.cancel")) {
					done(null);
					return;
				}
				if (keybindings.matches(data, "tui.select.confirm")) {
					const index = selectedIndex();
					if (index !== undefined) done(`copy:${index}`);
					return;
				}
				if (matchesKey(data, "right")) {
					const index = selectedIndex();
					if (index !== undefined && isInsertableCopyItem(copyItems[index]!)) {
						done(`insert:${index}`);
					}
					return;
				}
				if (matchesKey(data, "backspace")) {
					if (filter.length > 0) updateFilter(filter.slice(0, -1));
					return;
				}
				if (keybindings.matches(data, "tui.select.up")) {
					moveSelection(-1, true);
					return;
				}
				if (keybindings.matches(data, "tui.select.down")) {
					moveSelection(1, true);
					return;
				}
				if (keybindings.matches(data, "tui.select.pageUp")) {
					moveSelection(-maxVisible, false);
					return;
				}
				if (keybindings.matches(data, "tui.select.pageDown")) {
					moveSelection(maxVisible, false);
					return;
				}
				const printable = printableInput(data);
				if (printable) {
					updateFilter(filter + printable);
					return;
				}
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (!encoded) return undefined;
	const [action, rawIndex] = encoded.split(":");
	const index = Number.parseInt(rawIndex ?? "", 10);
	const item = copyItems[index];
	if (!item || (action !== "copy" && action !== "insert")) return undefined;
	if (action === "insert" && !isInsertableCopyItem(item)) return undefined;
	return { item, action };
}
