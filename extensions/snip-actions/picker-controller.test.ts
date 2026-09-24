import test from "node:test";
import assert from "node:assert/strict";
import type { CopyItem } from "./copy-items.ts";
import { buildSearchIndex } from "./search.ts";

const copyItems: CopyItem[] = [
	{
		id: "message",
		kind: "message",
		content: "Complete assistant message",
		messageId: "m1",
		sourceLabel: "10:00:00",
		sourcePosition: -1,
	},
	{
		id: "quote",
		kind: "quote",
		content: "Selected quote",
		messageId: "m1",
		sourceLabel: "10:00:00",
		sourcePosition: 10,
	},
	{
		id: "code",
		kind: "code",
		content: "const answer = 42;",
		messageId: "m1",
		sourceLabel: "10:00:00",
		sourcePosition: 40,
		language: "typescript",
	},
];

const selectItems = copyItems.map((item, index) => ({
	value: String(index),
	label: item.id,
	description: "",
}));
const searchIndex = buildSearchIndex(copyItems, selectItems);

class FakeList {
	items = [...selectItems];
	selectedIndex = 0;
	invalidations = 0;

	getSelectedItem() {
		return this.items[this.selectedIndex];
	}

	replaceItems(items: typeof selectItems): void {
		this.items = [...items];
		this.selectedIndex = 0;
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.items.length - 1));
	}

	pageSelection(direction: -1 | 1): void {
		this.setSelectedIndex(this.selectedIndex + direction * 12);
	}

	handleInput(data: string): void {
		if (data === "end") this.selectedIndex = Math.max(0, this.items.length - 1);
	}

	invalidate(): void {
		this.invalidations += 1;
	}
}

async function createHarness() {
	const controllerModule = await import("./picker-controller.ts").catch(() => undefined);
	assert.ok(controllerModule, "the picker controller must exist");
	const list = new FakeList();
	const previews: Array<{ title: string; content: string }> = [];
	const filters: string[] = [];
	let renders = 0;
	const controller = new controllerModule.PickerController({
		copyItems,
		selectItems,
		searchIndex,
		list,
		showPreview: (preview) => previews.push({ title: preview.title, content: preview.content }),
		showFilter: (filter) => filters.push(filter),
		requestRender: () => { renders += 1; },
	});
	return { controller, list, previews, filters, renderCount: () => renders };
}

test("updates the selected preview after navigation, paging, fallback input, and invalidation", async () => {
	const harness = await createHarness();
	harness.controller.initialize();
	assert.equal(harness.previews.at(-1)?.content, "Complete assistant message");

	harness.controller.moveSelection(1, true);
	assert.equal(harness.previews.at(-1)?.content, "Selected quote");

	harness.controller.moveSelection(12, false);
	assert.equal(harness.previews.at(-1)?.content, "const answer = 42;");

	harness.list.setSelectedIndex(0);
	harness.controller.handleListInput("end");
	assert.equal(harness.previews.at(-1)?.content, "const answer = 42;");

	const previewCount = harness.previews.length;
	harness.controller.refresh();
	assert.equal(harness.previews.length, previewCount + 1);
	assert.equal(harness.previews.at(-1)?.content, "const answer = 42;");
	assert.equal(harness.renderCount(), 3);
});

test("updates the preview after filtering and shows the empty state", async () => {
	const harness = await createHarness();
	harness.controller.initialize();

	harness.controller.updateFilter("typescript");
	assert.equal(harness.previews.at(-1)?.title, "Preview · code · typescript");
	assert.equal(harness.list.getSelectedItem()?.value, "2");

	harness.controller.updateFilter("missing");
	assert.equal(harness.previews.at(-1)?.content, "No matching item.");
	assert.equal(harness.list.getSelectedItem(), undefined);

	harness.controller.updateFilter("");
	assert.equal(harness.previews.at(-1)?.content, "Complete assistant message");
	assert.deepEqual(harness.filters, ["", "typescript", "missing", ""]);
	assert.equal(harness.list.invalidations, 3);
	assert.equal(harness.renderCount(), 3);
});
