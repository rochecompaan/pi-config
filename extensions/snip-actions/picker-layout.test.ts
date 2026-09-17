import test from "node:test";
import assert from "node:assert/strict";
import { buildPickerItems, GroupedPickerList } from "./picker-list.ts";
import type { CopyItem } from "./copy-items.ts";
import { renderPickerLayout } from "./picker-layout.ts";

const items: CopyItem[] = Array.from({ length: 20 }, (_, index) => ({
	id: `message-${index}`, messageId: `message-${index}`, kind: "message",
	content: `Message ${index}`, sourceLabel: "12:00", sourcePosition: -1,
}));

async function createLayout() {
	const list = new GroupedPickerList(buildPickerItems(items), 12);
	return {
		list,
		render(height: number, help = ["up/down select · enter copy · Right insert · esc cancel"]) {
			return renderPickerLayout({
				height, title: "Copy message or snippet", filter: "Filter: (none)",
				border: "────────", help,
				preview: ["Preview — message", ...Array.from({ length: 30 }, (_, i) => `Preview line ${i}`)],
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
		assert.ok(lines.includes("Filter: (none)"));
		assert.ok(lines.some((line) => line.includes("· Message 10")));
		assert.ok(lines.includes("  › Full message"));
		assert.ok(lines.some((line) => line.includes("esc cancel")));
		assert.equal(list.getSelectedItem()?.value, "10", "resize must not change the copy target");
	}
});

test("wrapped help leaves space for the selected row rather than overflowing", async () => {
	const { render } = await createLayout();
	const lines = render(24, ["up/down select · enter copy", "Right insert · esc cancel"]);
	assert.ok(lines.length <= 24);
	assert.ok(lines.includes("  › Full message"));
	assert.ok(lines.includes("Right insert · esc cancel"));
});

test("preview shrinks on short screens and expands again after resize", async () => {
	const { render } = await createLayout();
	const tall = render(45);
	const short = render(24);
	assert.ok(short.filter((line) => line.startsWith("Preview line")).length
		< tall.filter((line) => line.startsWith("Preview line")).length);
	assert.ok(short.includes("Preview — message"));
	assert.ok(short.includes("…"), "indicate that the preview is shortened");
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
				assert.ok(lines.includes("  › Full message"));
				for (const line of lines) {
					const match = line.match(/ · Message (\d+)$/);
					if (match) seen.add(Number(match[1]));
				}
				if (list.getSelectedItem()?.value === (direction === 1 ? "19" : "0")) break;
				list.pageSelection(direction);
			}
			assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
		}
	}
});

test("an empty filtered list still fits and has no selected action", async () => {
	const { list, render } = await createLayout();
	list.replaceItems([]);
	const lines = render(12);
	assert.ok(lines.length <= 12);
	assert.ok(lines.includes("  No matching items"));
	assert.ok(lines.includes("Filter: (none)"));
	assert.ok(!lines.some((line) => line.includes("›")));
});
