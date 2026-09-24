import test from "node:test";
import assert from "node:assert/strict";
import { buildPickerItems, GroupedPickerList } from "./picker-list.ts";
import type { CopyItem } from "./copy-items.ts";
import { renderPickerLayout } from "./picker-layout.ts";

const items: CopyItem[] = Array.from({ length: 20 }, (_, index) => ({
	id: `message-${index}`, messageId: `message-${index}`, kind: "message",
	content: `Message ${index}`, sourceLabel: "12:00", sourcePosition: -1,
}));

const plainFrame = {
	width: 80,
	dialogBorder: (text: string) => text,
	previewBorder: (text: string) => text,
	visibleWidth: (text: string) => text.length,
	truncate: (text: string, maxWidth: number) => text.slice(0, maxWidth),
};

function includesLine(lines: readonly string[], text: string): boolean {
	return lines.some((line) => line.includes(text));
}

async function createLayout() {
	const list = new GroupedPickerList(buildPickerItems(items), 12);
	return {
		list,
		render(height: number, help = ["up/down select · enter copy · Right insert · esc cancel"]) {
			return renderPickerLayout({
				...plainFrame,
				height, title: "Copy message or snippet", filter: "Filter: (none)", help,
				previewTitle: "Preview — message",
				preview: Array.from({ length: 30 }, (_, i) => `Preview line ${i}`),
				renderList(maxRows: number) {
					list.setMaxRows(maxRows);
					return list.renderRows().map((row) => row.text);
				},
			});
		},
	};
}

// Catches the original fixed-height overflow, including the list's scroll counter.
test("short layouts keep the filter, selected action and controls inside terminal height", async () => {
	const { list, render } = await createLayout();
	for (const height of [24, 20, 16, 12, 8, 6]) {
		list.setSelectedIndex(10);
		const lines = render(height);
		assert.ok(lines.length <= height, `${height} rows must fit; got ${lines.length}`);
		assert.ok(includesLine(lines, "Filter: (none)"));
		assert.ok(lines.some((line) => line.includes("· Message 10")));
		assert.ok(includesLine(lines, "› Full message"));
		assert.ok(lines.some((line) => line.includes("esc cancel")));
		assert.equal(list.getSelectedItem()?.value, "10", "resize must not change the copy target");
	}
});

test("wrapped help leaves space for the selected row rather than overflowing", async () => {
	const { render } = await createLayout();
	const lines = render(24, ["up/down select · enter copy", "Right insert · esc cancel"]);
	assert.ok(lines.length <= 24);
	assert.ok(includesLine(lines, "› Full message"));
	assert.ok(includesLine(lines, "Right insert · esc cancel"));
});

test("preview shrinks on short screens and expands again after resize", async () => {
	const { render } = await createLayout();
	const tall = render(45);
	const short = render(24);
	assert.ok(short.filter((line) => line.includes("Preview line")).length
		< tall.filter((line) => line.includes("Preview line")).length);
	assert.ok(includesLine(short, "Preview — message"));
	assert.ok(includesLine(short, "…"), "indicate that the preview is shortened");
	assert.deepEqual(render(45), tall);
});

test("paging follows the resized list budget in both directions without skipping groups", async () => {
	const { list, render } = await createLayout();
	for (const height of [24, 12, 20]) {
		for (const direction of [1, -1] as const) {
			const seen = new Set<number>();
			for (let page = 0; page < 25; page++) {
				const lines = render(height);
				assert.ok(lines.length <= height);
				assert.ok(includesLine(lines, "› Full message"));
				for (const line of lines) {
					const match = line.match(/ · Message (\d+)/);
					if (match) seen.add(Number(match[1]));
				}
				if (list.getSelectedItem()?.value === (direction === 1 ? "19" : "0")) break;
				list.pageSelection(direction);
			}
			assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
		}
	}
});

test("the list keeps its space when filtering or scrolling changes its rendered row count", () => {
	for (const height of [24, 45]) {
		const render = (list: string[]) => renderPickerLayout({
			...plainFrame,
			height, title: "Copy", filter: "Filter", help: ["esc cancel"],
			previewTitle: "Preview", preview: ["short content"], renderList: () => list,
		});
		const full = render(["group", "selected", "another item", "counter"]);
		for (const rows of [["group", "selected"], ["No matching items"]]) {
			const sparse = render(rows);
			assert.equal(
				sparse.findIndex((line) => line.includes("Preview")),
				full.findIndex((line) => line.includes("Preview")),
				"list/preview boundary must not jump",
			);
		}
	}
});

test("short previews shrink below the list without changing its row budget", () => {
	const budgets: number[] = [];
	const render = (preview: string[]) => renderPickerLayout({
		...plainFrame,
		height: 45, title: "Copy", filter: "Filter", help: ["esc cancel"],
		previewTitle: "Preview", preview,
		renderList: (maxRows) => { budgets.push(maxRows); return ["group", "selected"]; },
	});
	const short = render(["short content"]);
	const long = render(Array(30).fill("long content"));
	assert.equal(
		short.findIndex((line) => line.includes("selected")),
		long.findIndex((line) => line.includes("selected")),
	);
	assert.equal(
		short.findIndex((line) => line.includes("Preview")),
		long.findIndex((line) => line.includes("Preview")),
	);
	assert.deepEqual(budgets, [12, 12]);
	assert.ok(short.length < long.length, "only the preview area should grow");
});

test("an empty filtered list still fits and has no selected action", async () => {
	const { list, render } = await createLayout();
	list.replaceItems([]);
	const lines = render(12);
	assert.ok(lines.length <= 12);
	assert.ok(includesLine(lines, "No matching items"));
	assert.ok(includesLine(lines, "Filter: (none)"));
	assert.ok(!lines.some((line) => line.includes("›")));
});

test("frames the dialog and centers its title across the available width", () => {
	const width = 30;
	const lines = renderPickerLayout({
		height: 8,
		width,
		title: "SNIP",
		filter: "Filter: none",
		previewTitle: "PREVIEW",
		help: ["esc cancel"],
		preview: ["preview content"],
		dialogBorder: (text) => text,
		previewBorder: (text) => text,
		visibleWidth: (text) => text.length,
		truncate: (text, maxWidth) => text.slice(0, maxWidth),
		renderList: () => ["selected"],
	});

	assert.equal(lines[0], "┌─────────── SNIP ───────────┐");
	assert.equal(lines.at(-1), "└────────────────────────────┘");
	assert.ok(lines.slice(1, -1).every((line) => line.length === width));
	assert.ok(lines.slice(1, -1).every((line) => line.startsWith("│") || line.startsWith("├")));
});

test("keeps blank rows around visible preview content", () => {
	const lines = renderPickerLayout({
		height: 30,
		width: 42,
		title: "SNIP",
		filter: "Filter: none",
		previewTitle: "PREVIEW · CODE · BASH",
		help: ["esc cancel"],
		preview: ["first preview line", "second preview line"],
		dialogBorder: (text) => text,
		previewBorder: (text) => text,
		visibleWidth: (text) => text.length,
		truncate: (text, maxWidth) => text.slice(0, maxWidth),
		renderList: () => ["group", "selected"],
	});

	const previewTop = lines.findIndex((line) => line.includes("PREVIEW · CODE · BASH"));
	const previewBottom = lines.findIndex((line, index) => index > previewTop && line.startsWith("╞"));
	assert.ok(previewTop > 0);
	assert.ok(previewBottom > previewTop);
	assert.match(lines[previewTop - 1]!, /^│ +│$/);
	assert.match(lines[previewTop + 1]!, /^│ +│$/);
	assert.ok(lines[previewTop + 2]!.includes("first preview line"));
	assert.ok(lines[previewTop + 3]!.includes("second preview line"));
	assert.match(lines[previewBottom - 1]!, /^│ +│$/);
});

test("uses a separate renderer for preview rules", () => {
	const dialogSegments: string[] = [];
	const previewSegments: string[] = [];
	renderPickerLayout({
		height: 30,
		width: 42,
		title: "SNIP",
		filter: "Filter: none",
		previewTitle: "PREVIEW",
		help: ["esc cancel"],
		preview: ["preview content"],
		dialogBorder: (text) => { dialogSegments.push(text); return text; },
		previewBorder: (text) => { previewSegments.push(text); return text; },
		visibleWidth: (text) => text.length,
		truncate: (text, maxWidth) => text.slice(0, maxWidth),
		renderList: () => ["group", "selected"],
	});

	assert.ok(previewSegments.some((segment) => segment.includes("╞")));
	assert.ok(previewSegments.some((segment) => segment.includes("╡")));
	assert.ok(dialogSegments.some((segment) => segment.includes("┌")));
	assert.ok(dialogSegments.every((segment) => !segment.includes("═")));
});

test("preserves the selected row and controls in a six-line frame", () => {
	const lines = renderPickerLayout({
		height: 6,
		width: 42,
		title: "SNIP",
		filter: "Filter: none",
		previewTitle: "PREVIEW",
		help: ["esc cancel"],
		preview: ["preview content"],
		dialogBorder: (text) => text,
		previewBorder: (text) => text,
		visibleWidth: (text) => text.length,
		truncate: (text, maxWidth) => text.slice(0, maxWidth),
		renderList: () => ["group", "selected"],
	});

	assert.equal(lines.length, 6);
	assert.ok(lines.some((line) => line.includes("Filter: none")));
	assert.ok(lines.some((line) => line.includes("selected")));
	assert.ok(lines.some((line) => line.includes("esc cancel")));
	assert.ok(!lines.some((line) => line.includes("PREVIEW")));
	assert.ok(lines[0]!.startsWith("┌"));
	assert.ok(lines.at(-1)!.startsWith("└"));
});

test("never renders past the supplied width", () => {
	for (const width of [2, 3, 4, 5, 10, 30]) {
		const lines = renderPickerLayout({
			height: 8,
			width,
			title: "SNIP",
			filter: "Filter: none",
			previewTitle: "PREVIEW",
			help: ["esc cancel"],
			preview: ["preview content"],
			dialogBorder: (text) => text,
			previewBorder: (text) => text,
			visibleWidth: (text) => text.length,
			truncate: (text, maxWidth) => text.slice(0, maxWidth),
			renderList: () => ["group", "selected"],
		});
		assert.ok(lines.every((line) => line.length <= width), `width ${width}: ${JSON.stringify(lines)}`);
	}
});
