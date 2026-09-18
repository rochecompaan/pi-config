import test from "node:test";
import assert from "node:assert/strict";
import { collectCopyItems, extractAssistantText } from "./copy-items.ts";

const older = {
	type: "message",
	id: "older",
	timestamp: "2026-09-05T09:00:00.000Z",
	message: { role: "assistant", content: "```sh\necho old\n```" },
};

const newer = {
	type: "message",
	id: "newer",
	timestamp: "2026-09-05T10:00:00.000Z",
	message: { role: "assistant", content: "> Keep this quote\n| Hello,\n| world\nUse `main`." },
};

test("joins assistant text blocks and ignores non-text blocks", () => {
	assert.equal(
		extractAssistantText([
			{ type: "text", text: "First" },
			{ type: "thinking", thinking: "hidden" },
			{ type: "text", text: "Second" },
		]),
		"First\n\nSecond",
	);
});

test("collects newest messages first with the full message before extracts", () => {
	const items = collectCopyItems([older, newer] as never);
	assert.deepEqual(
		items.map((item) => [item.messageId, item.kind, item.content]),
		[
			["newer", "message", "> Keep this quote\n| Hello,\n| world\nUse `main`."],
			["newer", "quote", "Keep this quote"],
			["newer", "pipe-message", "Hello,world"],
			["older", "message", "```sh\necho old\n```"],
			["older", "code", "echo old"],
		],
	);
});

test("inline code stays in the full message but is never a standalone option", () => {
	const content = "Use `main` and ``code with ` backticks``.\n\n```sh\necho kept\n```";
	const items = collectCopyItems([{ ...newer, message: { role: "assistant", content } }] as never);
	assert.deepEqual(items.map((item) => item.kind), ["message", "code"]);
	assert.equal(items[0]?.content, content);
	assert.equal(items[1]?.content, "echo kept");
});

test("excludes non-assistant, non-message, and empty assistant entries", () => {
	const items = collectCopyItems([
		{ ...older, id: "user", message: { role: "user", content: "ignored" } },
		{ type: "custom", id: "custom", timestamp: older.timestamp },
		{ ...older, id: "empty", message: { role: "assistant", content: [] } },
	] as never);
	assert.deepEqual(items, []);
});

test("creates stable unique item identifiers", () => {
	const items = collectCopyItems([newer] as never);
	assert.equal(new Set(items.map((item) => item.id)).size, items.length);
	assert.equal(items[0]?.id, "newer:message");
});
