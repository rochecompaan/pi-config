import { limitPreviewLines } from "./preview.ts";

type PickerLayout = {
	height: number;
	title: string;
	filter: string;
	border: string;
	help: string[];
	preview: string[];
	/** Content rows only; the list may add one scroll-indicator row. */
	renderList(maxRows: number): string[];
};

/** Fit a picker to its overlay, keeping selection usable before spending rows on preview. */
export function renderPickerLayout(parts: PickerLayout): string[] {
	const height = Math.max(1, Math.floor(parts.height));
	let header = [parts.border, parts.title, parts.filter];
	let footer = [...parts.help, parts.border];
	// On very short screens, remove decoration before sacrificing the list or cancel hint.
	if (height < header.length + footer.length + 3) {
		header = [parts.filter];
		footer = parts.help.slice(-Math.max(1, height - 4));
	}
	const available = Math.max(0, height - header.length - footer.length);
	// Preview needs two separators; leave at least a header, an action and a counter.
	const fullListRows = 12 + 1; // Content plus the scroll counter.
	const previewRows = available >= 8 ? Math.min(10, Math.max(3, available - fullListRows - 2)) : 0;
	const listRows = Math.min(fullListRows, available - (previewRows > 0 ? previewRows + 2 : 0));
	const list = parts.renderList(Math.max(2, Math.min(12, listRows - 1))).slice(0, listRows);
	// Keep the options viewport stable as groups, search results and counters change.
	while (list.length < listRows) list.push("");
	return [
		...header,
		...list,
		...(previewRows > 0
			? [parts.border, ...limitPreviewLines(parts.preview, previewRows), parts.border]
			: []),
		...footer,
	].slice(0, height);
}
