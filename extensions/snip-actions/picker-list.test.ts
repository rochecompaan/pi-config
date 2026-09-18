import test from "node:test";
import assert from "node:assert/strict";
import { collectCopyItems, type BranchEntry } from "./copy-items.ts";
import { PickerController } from "./picker-controller.ts";
import { buildSearchIndex } from "./search.ts";

const copyItems = collectCopyItems([
	{
		type: "message", id: "old", timestamp: "2026-09-14T10:00:00Z",
		message: { role: "assistant", content: "Older **message**\n\n`target_old`" },
	},
	{
		type: "message", id: "new", timestamp: "2026-09-14T11:00:00Z",
		message: {
			role: "assistant",
			content: "### Create the **cluster**\n\n```zsh\necho target_new\n```\nUse `target_name`.",
		},
	},
] as BranchEntry[]);

async function createHarness(maxRows = 12, source = copyItems) {
	const module = await import("./picker-list.ts").catch(() => undefined);
	assert.ok(module, "the message-grouped picker list must exist");
	const selectItems = module.buildPickerItems(source);
	const list = new module.GroupedPickerList(selectItems, maxRows);
	let preview = { title: "", content: "" };
	const controller = new PickerController({
		copyItems: source, selectItems, list,
		searchIndex: buildSearchIndex(source, selectItems),
		showPreview: (next) => { preview = next; },
		showFilter: () => {},
		requestRender: () => {},
	});
	controller.initialize();
	return { list, controller, preview: () => preview };
}

test("groups actions beneath message titles without repeated timestamps or numbering", async () => {
	const { list } = await createHarness();
	const rows = list.renderRows();
	assert.deepEqual(rows.filter((row) => row.style === "header").map((row) => row.text), [
		`── ${copyItems[0]!.sourceLabel} · Create the cluster`,
		`── ${copyItems[2]!.sourceLabel} · Older message`,
	]);
	const actions = rows.filter((row) => row.style === "item" || row.style === "selected");
	assert.equal(actions.length, 3);
	assert.equal(actions[0]?.text, "  › Full message");
	assert.match(actions[1]!.text, /^    Code · zsh\s+echo target_new$/);
	assert.equal(actions[2]?.text, "    Full message");
	for (const row of actions) assert.doesNotMatch(row.text, /\d+[:.] /);
});

test("navigation skips headers and previews the exact selected copy target", async () => {
	const { controller, preview } = await createHarness();
	assert.equal(controller.selectedCopyItemIndex(), 0);
	controller.moveSelection(1, true);
	assert.equal(controller.selectedCopyItemIndex(), 1);
	assert.equal(preview().content, "echo target_new");
	controller.moveSelection(1, true);
	assert.equal(controller.selectedCopyItemIndex(), 2);
	assert.equal(preview().content, "Older **message**\n\n`target_old`");
	controller.moveSelection(1, true);
	assert.equal(controller.selectedCopyItemIndex(), 0);
	controller.moveSelection(-1, true);
	assert.equal(controller.selectedCopyItemIndex(), 2);
});

test("filtering preserves newest-message and source order instead of interleaving ranked hits", async () => {
	const { controller, list } = await createHarness();
	controller.updateFilter("target");
	const selected: number[] = [];
	for (let i = 0; i < 3; i++) {
		selected.push(controller.selectedCopyItemIndex()!);
		controller.moveSelection(1, true);
	}
	assert.deepEqual(selected, [0, 1, 2]);
	assert.equal(list.renderRows().filter((row) => row.style === "header").length, 2);
});

test("a snippet-only match retains its parent header and its original copy target", async () => {
	const { controller, list, preview } = await createHarness();
	controller.updateFilter("code zsh target_new");
	assert.equal(controller.selectedCopyItemIndex(), 1);
	assert.equal(preview().content, "echo target_new");
	const rows = list.renderRows();
	assert.equal(rows[0]?.text, `── ${copyItems[0]!.sourceLabel} · Create the cluster`);
	assert.equal(rows.filter((row) => row.style === "selected").length, 1);
	assert.equal(rows.filter((row) => row.style === "item").length, 0);
});

test("scrolling keeps the selected action and its header visible within the row budget", async () => {
	const { controller, list } = await createHarness(4);
	for (const offset of [1, 1, 1, 1, -1, -1, -1, -1, 12, -12]) {
		controller.moveSelection(offset, false);
		const rows = list.renderRows();
		assert.ok(rows.length <= 5, "four content rows plus a scroll indicator");
		assert.equal(rows[0]?.style, "header");
		assert.equal(rows.filter((row) => row.style === "selected").length, 1);
		assert.notEqual(rows.at(-1)?.style, "header", "never show a stranded header");
	}
});

test("empty results have no selectable header and clearing the filter restores the list", async () => {
	const { controller, list, preview } = await createHarness();
	controller.updateFilter("absent");
	assert.equal(controller.selectedCopyItemIndex(), undefined);
	assert.equal(preview().content, "No matching item.");
	assert.deepEqual(list.renderRows().map((row) => row.style), ["warning"]);
	controller.moveSelection(1, true);
	assert.equal(controller.selectedCopyItemIndex(), undefined);
	controller.updateFilter("");
	assert.equal(controller.selectedCopyItemIndex(), 0);
	assert.equal(list.renderRows()[0]?.style, "header");
});

test("page navigation visits every message group without skipping unseen actions", async () => {
	const source = Array.from({ length: 20 }, (_, index) => ({
		...copyItems[0]!, id: `message-${index}`, messageId: `message-${index}`, content: `Message ${index}`,
	}));
	const { list, controller, preview } = await createHarness(12, source);
	assert.equal(typeof controller.pageSelection, "function", "paging must account for header rows");
	for (const direction of [1, -1] as const) {
		const seen = new Set<number>();
		for (let page = 0; page < 20; page++) {
			for (const row of list.renderRows()) {
				const match = row.text.match(/ · Message (\d+)$/);
				if (match) seen.add(Number(match[1]));
			}
			const selected = controller.selectedCopyItemIndex();
			assert.equal(preview().content, `Message ${selected}`);
			if (selected === (direction === 1 ? 19 : 0)) break;
			controller.pageSelection(direction);
		}
		assert.equal(controller.selectedCopyItemIndex(), direction === 1 ? 19 : 0);
		assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index));
	}
});

test("message titles skip Markdown structure and retain readable opening text", async () => {
	const module = await import("./picker-list.ts");
	for (const [content, title] of [
		["```typescript\nconst answer = 42;\n```", "const answer = 42;"],
		["---\n\n# Release **ready** #", "Release ready"],
		["- First point\n- Second point", "First point"],
		["1. First point", "First point"],
		["> Quoted opening", "Quoted opening"],
		["***\n___\n```\n```", "Assistant message"],
		["###\tCreate\tthe `cluster`", "Create the cluster"],
	] as const) {
		const source = [{ ...copyItems[0]!, content }];
		const list = new module.GroupedPickerList(module.buildPickerItems(source), 12);
		assert.equal(list.renderRows()[0]?.text, `── ${source[0]!.sourceLabel} · ${title}`);
	}
});

test("messages with the same timestamp remain separate groups", async () => {
	const module = await import("./picker-list.ts");
	const items = copyItems.map((item) => ({ ...item, sourceLabel: "12:00:00" }));
	const list = new module.GroupedPickerList(module.buildPickerItems(items), 12);
	assert.equal(list.renderRows().filter((row) => row.style === "header").length, 2);
});
