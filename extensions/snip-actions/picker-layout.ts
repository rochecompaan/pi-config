import { limitPreviewLines } from "./preview.ts";

type PickerLayout = {
	height: number;
	width: number;
	title: string;
	filter: string;
	previewTitle: string;
	help: string[];
	preview: string[];
	dialogBorder(text: string): string;
	previewBorder(text: string): string;
	visibleWidth(text: string): number;
	truncate(text: string, maxWidth: number): string;
	/** Content rows only; the list may add one scroll-indicator row. */
	renderList(maxRows: number): string[];
};

function centeredRule(
	width: number,
	title: string,
	left: string,
	fill: string,
	right: string,
	style: (text: string) => string,
	parts: Pick<PickerLayout, "truncate" | "visibleWidth">,
): string {
	const innerWidth = Math.max(0, width - 2);
	const label = innerWidth >= 4
		? ` ${parts.truncate(title, Math.max(0, innerWidth - 2))} `
		: "";
	const fillWidth = Math.max(0, innerWidth - parts.visibleWidth(label));
	const leftWidth = Math.floor(fillWidth / 2);
	const rightWidth = fillWidth - leftWidth;
	return style(`${left}${fill.repeat(leftWidth)}`) + label + style(`${fill.repeat(rightWidth)}${right}`);
}

function framedContent(
	text: string,
	width: number,
	styleBorder: (text: string) => string,
	parts: Pick<PickerLayout, "truncate" | "visibleWidth">,
): string {
	const innerWidth = Math.max(0, width - 2);
	const leftPadding = innerWidth >= 1 ? " " : "";
	const rightPadding = innerWidth >= 2 ? " " : "";
	const contentWidth = Math.max(0, innerWidth - leftPadding.length - rightPadding.length);
	const content = parts.truncate(text, contentWidth);
	const padding = " ".repeat(Math.max(0, contentWidth - parts.visibleWidth(content)));
	return styleBorder("│") + leftPadding + content + padding + rightPadding + styleBorder("│");
}

/** Fit a framed picker to its overlay, keeping selection usable before spending rows on preview. */
export function renderPickerLayout(parts: PickerLayout): string[] {
	const height = Math.max(1, Math.floor(parts.height));
	const width = Math.max(2, Math.floor(parts.width));
	const top = centeredRule(width, parts.title, "┌", "─", "┐", parts.dialogBorder, parts);
	const bottom = parts.dialogBorder(`└${"─".repeat(Math.max(0, width - 2))}┘`);
	const divider = parts.dialogBorder(`├${"─".repeat(Math.max(0, width - 2))}┤`);
	const maxHelpRows = Math.max(1, height - 5); // Top, filter, two list rows and bottom.
	const help = parts.help.slice(-maxHelpRows)
		.map((line) => framedContent(line, width, parts.dialogBorder, parts));
	const header = [top, framedContent(parts.filter, width, parts.dialogBorder, parts)];
	if (height >= header.length + help.length + 1 + 2 + 1) header.push(divider);
	const footer = [...help, bottom];
	const available = Math.max(0, height - header.length - footer.length);
	const fullListRows = 13;
	const previewChromeRows = 5; // Gap, titled rule, two padding rows and bottom rule.
	const canShowPreview = parts.preview.length > 0 && available >= 2 + previewChromeRows + 1;
	const previewRows = canShowPreview
		? Math.min(10, Math.max(1, available - fullListRows - previewChromeRows))
		: 0;
	const listRows = Math.min(
		fullListRows,
		available - (previewRows > 0 ? previewChromeRows + previewRows : 0),
	);
	const list = parts.renderList(Math.max(2, Math.min(12, listRows - 1))).slice(0, listRows);
	while (list.length < listRows) list.push("");
	const preview = limitPreviewLines(parts.preview, previewRows);
	return [
		...header,
		...list.map((line) => framedContent(line, width, parts.dialogBorder, parts)),
		...(previewRows > 0
			? [
				framedContent("", width, parts.dialogBorder, parts),
				centeredRule(width, parts.previewTitle, "╞", "═", "╡", parts.previewBorder, parts),
				framedContent("", width, parts.dialogBorder, parts),
				...preview.map((line) => framedContent(line, width, parts.dialogBorder, parts)),
				framedContent("", width, parts.dialogBorder, parts),
				parts.previewBorder(`╞${"═".repeat(Math.max(0, width - 2))}╡`),
			]
			: []),
		...footer,
	].slice(0, height);
}
