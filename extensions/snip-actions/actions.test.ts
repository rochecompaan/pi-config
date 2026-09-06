import test from "node:test";
import assert from "node:assert/strict";
import { performCopyAction } from "./actions.ts";
import type { CopyItem } from "./copy-items.ts";

function item(kind: CopyItem["kind"], content = "content"): CopyItem {
	return {
		id: `item:${kind}`,
		kind,
		content,
		messageId: "message-1",
		sourceLabel: "10:00:00",
		sourcePosition: 0,
	};
}

function context(existing = "") {
	const state = { editor: existing, notifications: [] as Array<[string, string]> };
	const ctx = {
		ui: {
			getEditorText: () => state.editor,
			setEditorText: (value: string) => { state.editor = value; },
			notify: (message: string, level: string) => state.notifications.push([message, level]),
		},
	};
	return { ctx: ctx as never, state };
}

test("copies every item type through the clipboard dependency", async () => {
	for (const kind of ["message", "pipe-message", "code", "inline"] as const) {
		const { ctx, state } = context();
		const copied: string[] = [];
		await performCopyAction(ctx, { item: item(kind, kind), action: "copy" }, async (text) => {
			copied.push(text);
		});
		assert.deepEqual(copied, [kind]);
		assert.deepEqual(state.notifications, [[`Copied ${kind === "pipe-message" ? "pipe message" : kind} to clipboard.`, "info"]]);
	}
});

test("inserts code and inline items into empty and non-empty editors", async () => {
	for (const [kind, content] of [["code", "echo ok"], ["inline", "main"]] as const) {
		for (const [existing, expected] of [["", content], ["existing", `existing\n${content}`]]) {
			const { ctx, state } = context(existing);
			await performCopyAction(ctx, { item: item(kind, content), action: "insert" }, async () => {});
			assert.equal(state.editor, expected);
			assert.deepEqual(state.notifications, [["Inserted code into editor.", "info"]]);
		}
	}
});

test("rejects insertion for message and pipe-message items without changing the editor", async () => {
	for (const kind of ["message", "pipe-message"] as const) {
		const { ctx, state } = context("existing");
		await performCopyAction(ctx, { item: item(kind), action: "insert" }, async () => {});
		assert.equal(state.editor, "existing");
		assert.deepEqual(state.notifications, [["Only code items can be inserted.", "error"]]);
	}
});

test("shows the clipboard error without changing the editor", async () => {
	const { ctx, state } = context("existing");
	await performCopyAction(ctx, { item: item("message"), action: "copy" }, async () => {
		throw new Error("Clipboard unavailable");
	});
	assert.equal(state.editor, "existing");
	assert.deepEqual(state.notifications, [["Clipboard unavailable", "error"]]);
});

test("uses a fallback message for non-Error clipboard rejections", async () => {
	const { ctx, state } = context("existing");
	await performCopyAction(ctx, { item: item("message"), action: "copy" }, async () => {
		throw "Clipboard unavailable";
	});
	assert.equal(state.editor, "existing");
	assert.deepEqual(state.notifications, [["Failed to copy to clipboard.", "error"]]);
});
