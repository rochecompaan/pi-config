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
import { PickerController, type PickerListAdapter } from "./picker-controller.ts";
import { limitPreviewLines } from "./preview.ts";
import { buildSearchIndex } from "./search.ts";

const PREVIEW_WIDTH = 52;
const PREVIEW_MAX_LINES = 10;

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
		container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));

		const previewText = new Text("", 1, 0);
		container.addChild({
			render: (width: number) => limitPreviewLines(previewText.render(width), PREVIEW_MAX_LINES),
			invalidate: () => previewText.invalidate(),
		});

		const help = new Text("", 1, 0);
		const listAdapter: PickerListAdapter = {
			getSelectedItem: () => list.getSelectedItem(),
			replaceItems: (items) => {
				const state = list as unknown as { filteredItems: SelectItem[]; selectedIndex: number };
				state.filteredItems = items;
				state.selectedIndex = 0;
			},
			setSelectedIndex: (index) => list.setSelectedIndex(index),
			handleInput: (data) => list.handleInput(data),
			invalidate: () => list.invalidate(),
		};
		const controller = new PickerController({
			copyItems,
			selectItems,
			searchIndex,
			list: listAdapter,
			showPreview: (preview) => {
				previewText.setText(`${theme.fg("accent", theme.bold(preview.title))}\n${preview.content}`);
			},
			showFilter: (filter) => {
				help.setText(theme.fg(
					"dim",
					`Filter: ${filter || "(none)"} · ${keyHint("tui.select.confirm", "copy")} · Right insert code · ${keyHint("tui.select.cancel", "cancel")}`,
				));
			},
			requestRender: () => tui.requestRender(),
		});

		list.onSelect = (selected) => done(`copy:${selected.value}`);
		list.onCancel = () => done(null);
		controller.initialize();
		container.addChild(help);
		container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => {
				container.invalidate();
				controller.refresh();
			},
			handleInput: (data: string) => {
				if (keybindings.matches(data, "tui.select.cancel")) {
					done(null);
					return;
				}
				if (keybindings.matches(data, "tui.select.confirm")) {
					const index = controller.selectedCopyItemIndex();
					if (index !== undefined) done(`copy:${index}`);
					return;
				}
				if (matchesKey(data, "right")) {
					const index = controller.selectedCopyItemIndex();
					if (index !== undefined && isInsertableCopyItem(copyItems[index]!)) {
						done(`insert:${index}`);
					}
					return;
				}
				if (matchesKey(data, "backspace")) {
					if (controller.filter.length > 0) {
						controller.updateFilter(controller.filter.slice(0, -1));
					}
					return;
				}
				if (keybindings.matches(data, "tui.select.up")) {
					controller.moveSelection(-1, true);
					return;
				}
				if (keybindings.matches(data, "tui.select.down")) {
					controller.moveSelection(1, true);
					return;
				}
				if (keybindings.matches(data, "tui.select.pageUp")) {
					controller.moveSelection(-maxVisible, false);
					return;
				}
				if (keybindings.matches(data, "tui.select.pageDown")) {
					controller.moveSelection(maxVisible, false);
					return;
				}
				const printable = printableInput(data);
				if (printable) {
					controller.updateFilter(controller.filter + printable);
					return;
				}
				controller.handleListInput(data);
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
