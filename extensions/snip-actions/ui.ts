// Adapted from @signalridge/pi-code-actions. See NOTICE.
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyHint, keyText } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	matchesKey,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { CopyItem, CopySelection } from "./copy-items.ts";
import { PickerController } from "./picker-controller.ts";
import { buildPickerItems, GroupedPickerList } from "./picker-list.ts";
import { handlePickerInput } from "./picker-input.ts";
import { renderPickerLayout } from "./picker-layout.ts";
import { buildSearchIndex } from "./search.ts";

const LIST_MAX_ROWS = 12;

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
	const selectItems = buildPickerItems(copyItems);
	const searchIndex = buildSearchIndex(copyItems, selectItems);

	return ctx.ui.custom<CopySelection | undefined>((tui, theme, keybindings, done) => {
		const border = new DynamicBorder((text: string) => theme.fg("borderAccent", text));
		let title = "";
		let filterText = "";
		const list = new GroupedPickerList(selectItems, LIST_MAX_ROWS);
		const previewText = new Text("", 1, 0);

		const help = new Text("", 1, 0);
		const controller = new PickerController({
			copyItems,
			selectItems,
			searchIndex,
			list,
			showPreview: (preview) => {
				const heading = preview.item ? `${preview.title} · ${preview.item.sourceLabel}` : preview.title;
				previewText.setText(`${theme.fg("accent", theme.bold(heading))}\n${preview.content}`);
			},
			showFilter: (filter) => {
				title = theme.fg("accent", theme.bold(" Copy message or snippet"));
				filterText = theme.fg("dim", ` Filter: ${filter || "(none)"}`);
				help.setText(theme.fg(
					"dim",
					`${keyText("tui.select.up")}/${keyText("tui.select.down")} select · ${keyHint("tui.select.confirm", "copy")} · Right insert code · ${keyHint("tui.select.cancel", "cancel")}`,
				));
			},
			requestRender: () => tui.requestRender(),
		});

		controller.initialize();

		return {
			render: (width: number) => renderPickerLayout({
				height: tui.terminal.rows || 24,
				title: truncateToWidth(title, width),
				filter: truncateToWidth(filterText, width),
				border: border.render(width)[0]!,
				help: help.render(width),
				preview: previewText.render(width),
				renderList: (maxRows) => {
					list.setMaxRows(maxRows);
					return list.renderRows().map((row) => {
						const color = row.style === "header" ? "muted"
							: row.style === "selected" ? "accent"
								: row.style === "item" ? "text" : row.style;
						const text = row.style === "header" ? `${row.text} ${"─".repeat(Math.max(0, width))}` : row.text;
						return theme.fg(color, truncateToWidth(text, width, row.style === "header" ? "" : "…"));
					});
				},
			}),
			invalidate: () => {
				previewText.invalidate();
				help.invalidate();
				controller.refresh();
			},
			handleInput: (data: string) => {
				const selection = handlePickerInput(data, { controller, copyItems, keybindings, matchesKey, printableInput });
				if (selection !== undefined) done(selection ?? undefined);
			},
		};
	}, {
		// Overlays own their height; editor replacements also have an unknown footer/widget height.
		overlay: true,
		overlayOptions: { width: "100%", maxHeight: "100%", anchor: "bottom-center" },
	});
}
