// Adapted from @signalridge/pi-code-actions. See NOTICE.
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyText } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { CopyItem, CopySelection } from "./copy-items.ts";
import { PickerController } from "./picker-controller.ts";
import { buildPickerItems, GroupedPickerList, type PickerRow } from "./picker-list.ts";
import { handlePickerInput } from "./picker-input.ts";
import { renderPickerLayout } from "./picker-layout.ts";
import { buildSearchIndex } from "./search.ts";

const LIST_MAX_ROWS = 12;

function renderPickerRow(row: PickerRow, theme: Theme, width: number): string {
	if (row.style === "header") {
		const heading = row.group?.title
			? `${theme.fg("muted", row.group.sourceLabel ?? "")} ${theme.fg("dim", "·")} ${theme.fg("mdHeading", theme.bold(row.group.title))}`
			: theme.fg("mdHeading", theme.bold(row.group?.label ?? row.text));
		return truncateToWidth(`${theme.fg("borderMuted", "──")} ${heading} ${theme.fg("borderMuted", "─".repeat(width))}`, width, "");
	}
	if (!row.item) return theme.fg(row.style === "warning" ? "warning" : "dim", truncateToWidth(row.text, width));
	const selected = row.style === "selected";
	const color = row.item.kind === "code" ? "mdCode"
		: row.item.kind === "quote" ? "mdQuote"
			: row.item.kind === "pipe-message" ? "syntaxString" : "text";
	const label = theme.fg(color, selected ? theme.bold(row.item.label) : row.item.label);
	const description = row.item.description ? `  ${theme.fg(selected ? "text" : "muted", row.item.description)}` : "";
	const text = truncateToWidth(`${theme.fg("accent", selected ? "  › " : "    ")}${label}${description}`, width);
	return selected ? theme.bg("selectedBg", text + " ".repeat(Math.max(0, width - visibleWidth(text)))) : text;
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
	const selectItems = buildPickerItems(copyItems);
	const searchIndex = buildSearchIndex(copyItems, selectItems);

	return ctx.ui.custom<CopySelection | undefined>((tui, theme, keybindings, done) => {
		const border = new DynamicBorder((text: string) => theme.fg("borderMuted", text));
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
				const source = preview.item ? theme.fg("muted", ` · ${preview.item.sourceLabel}`) : "";
				previewText.setText(`${theme.fg("mdHeading", theme.bold(preview.title))}${source}\n${theme.fg("text", preview.content)}`);
			},
			showFilter: (filter) => {
				title = theme.fg("accent", theme.bold(" Copy message or snippet"));
				filterText = `${theme.fg("muted", " Filter: ")}${theme.fg(filter ? "accent" : "dim", filter || "(none)")}`;
				const hint = (key: string, action: string) => `${theme.fg("accent", theme.bold(key))} ${theme.fg("muted", action)}`;
				help.setText([
					hint(`${keyText("tui.select.up")}/${keyText("tui.select.down")}`, "select"),
					hint(keyText("tui.select.confirm"), "copy"),
					hint("Right", "insert code"),
					hint(keyText("tui.select.cancel"), "cancel"),
				].join(theme.fg("dim", " · ")));
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
					return list.renderRows().map((row) => renderPickerRow(row, theme, width));
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
		// Preview height changes below the options instead of moving the entire picker.
		overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-center" },
	});
}
