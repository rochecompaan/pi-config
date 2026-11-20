import test from "node:test";
import assert from "node:assert/strict";
import { PIN_ENTRY_TYPE, clampScroll, currentPin, lastReplyText } from "./pin-state.ts";

const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (...content: unknown[]) => ({ type: "message", message: { role: "assistant", content } });
const text = (value: string) => ({ type: "text", text: value });
const pinEntry = (data: unknown) => ({ type: "custom", customType: PIN_ENTRY_TYPE, data });

test("lastReplyText skips a newer assistant message that has no text", () => {
	const branch = [
		user("status?"),
		assistant(text("## Next steps\n1. Do it")),
		assistant({ type: "thinking", thinking: "hmm" }, { type: "toolCall", id: "1", name: "bash", arguments: {} }),
	];
	assert.equal(lastReplyText(branch), "## Next steps\n1. Do it");
});

test("lastReplyText joins text parts and ignores thinking", () => {
	const branch = [assistant(text("first"), { type: "thinking", thinking: "x" }, text("second"))];
	assert.equal(lastReplyText(branch), "first\nsecond");
});

test("lastReplyText ignores user messages and returns undefined without assistant text", () => {
	assert.equal(lastReplyText([user("hello")]), undefined);
	assert.equal(lastReplyText([assistant(text("   "))]), undefined);
	assert.equal(lastReplyText([]), undefined);
});

test("currentPin returns the latest pin entry", () => {
	const branch = [pinEntry({ text: "old", pinnedAt: 1 }), user("x"), pinEntry({ text: "new", pinnedAt: 2 })];
	assert.deepEqual(currentPin(branch), { text: "new", pinnedAt: 2 });
});

test("currentPin returns undefined after a later cleared entry", () => {
	const branch = [pinEntry({ text: "old", pinnedAt: 1 }), pinEntry({ cleared: true })];
	assert.equal(currentPin(branch), undefined);
});

test("currentPin ignores malformed entries and other custom types", () => {
	const branch = [
		pinEntry({ text: "kept", pinnedAt: 1 }),
		pinEntry({ text: 42 }),
		pinEntry(undefined),
		{ type: "custom", customType: "other", data: { cleared: true } },
	];
	assert.deepEqual(currentPin(branch), { text: "kept", pinnedAt: 1 });
});

test("clampScroll keeps the offset inside the content", () => {
	assert.equal(clampScroll(-3, 100, 20), 0);
	assert.equal(clampScroll(50, 100, 20), 50);
	assert.equal(clampScroll(95, 100, 20), 80);
	assert.equal(clampScroll(5, 10, 20), 0);
});
