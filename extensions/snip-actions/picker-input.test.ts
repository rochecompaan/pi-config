import test from "node:test";
import assert from "node:assert/strict";
import type { CopyItem } from "./copy-items.ts";
import { PickerController } from "./picker-controller.ts";
import { buildPickerItems, GroupedPickerList } from "./picker-list.ts";
import { buildSearchIndex } from "./search.ts";

const copyItems: CopyItem[] = ["message", "quote", "pipe-message", "code", "inline"].map((kind, index) => ({
	id: String(index), kind: kind as CopyItem["kind"], content: `original ${kind} text`,
	messageId: "m1", sourceLabel: "12:00:00", sourcePosition: index,
}));
const keys: Record<string, string[]> = {
	"tui.select.confirm": ["\r"], "tui.select.cancel": ["\x1b", "\x03"],
	"tui.select.up": ["\x1b[A"], "tui.select.down": ["\x1b[B"],
	"tui.select.pageUp": ["\x1b[5~"], "tui.select.pageDown": ["\x1b[6~"],
};

async function createHarness() {
	const module = await import("./picker-input.ts").catch(() => undefined);
	assert.ok(module, "picker input routing must be testable without a terminal");
	const selectItems = buildPickerItems(copyItems);
	const list = new GroupedPickerList(selectItems, 12);
	const controller = new PickerController({
		copyItems, selectItems, list, searchIndex: buildSearchIndex(copyItems, selectItems),
		showPreview() {}, showFilter() {}, requestRender() {},
	});
	const input = {
		copyItems, controller,
		keybindings: { matches: (data: string, id: string) => keys[id]?.includes(data) ?? false },
		matchesKey: (data: string, key: string) => data === (key === "right" ? "\x1b[C" : "\x7f"),
		printableInput: (data: string) => /[\x00-\x1f\x7f]/.test(data) ? undefined : data,
	};
	return { controller, input, send: (data: string) => module.handlePickerInput(data, input) };
}

test("Enter copies each kind with the original content and identity", async () => {
	const { send } = await createHarness();
	for (const item of copyItems) {
		assert.deepEqual(send("\r"), { item, action: "copy" });
		send("\x1b[B");
	}
});

test("Right inserts only fenced or inline code and leaves other kinds open", async () => {
	const { send } = await createHarness();
	for (const item of copyItems) {
		const result = send("\x1b[C");
		if (item.kind === "code" || item.kind === "inline") {
			assert.deepEqual(result, { item, action: "insert" });
		} else {
			assert.equal(result, undefined);
			assert.deepEqual(send("\r"), { item, action: "copy" });
		}
		send("\x1b[B");
	}
});

test("Escape and Ctrl+C cancel, including after filtering", async () => {
	const { send } = await createHarness();
	assert.equal(send("\x1b"), null);
	send("inline");
	assert.equal(send("\x03"), null);
});

test("filtering keeps copy and insert mapped to the original item and handles no match", async () => {
	const { send, controller } = await createHarness();
	send("inline");
	assert.deepEqual(send("\r"), { item: copyItems[4], action: "copy" });
	assert.deepEqual(send("\x1b[C"), { item: copyItems[4], action: "insert" });
	send("absent");
	assert.equal(send("\r"), undefined);
	assert.equal(send("\x1b[C"), undefined);
	for (let index = 0; index < 12; index++) send("\x7f");
	assert.equal(controller.filter, "");
	assert.deepEqual(send("\r"), { item: copyItems[0], action: "copy" });
});

test("configured select bindings take precedence over printable search input", async () => {
	const { send, input, controller } = await createHarness();
	input.keybindings.matches = (data, id) => data === "j" && id === "tui.select.down";
	send("j");
	assert.equal(controller.selectedCopyItemIndex(), 1);
	assert.equal(controller.filter, "");
});

test("page keys update selection in both directions", async () => {
	const { send, controller } = await createHarness();
	send("\x1b[6~");
	assert.equal(controller.selectedCopyItemIndex(), 4);
	send("\x1b[5~");
	assert.equal(controller.selectedCopyItemIndex(), 0);
});
