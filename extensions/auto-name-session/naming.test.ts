import assert from "node:assert/strict";
import test from "node:test";
import { buildNamingPrompt, parseSessionName } from "./naming.ts";

const message = (role: string, content: unknown) => ({ type: "message", message: { role, content } });

test("uses only recent visible conversation text, not tools or thinking", () => {
	const prompt = buildNamingPrompt("auto name session", [
		message("user", "old subject"),
		message("assistant", [{ type: "text", text: "old answer" }]),
		message("user", "name sessions automatically"),
		message("toolResult", "secret tool output"),
		message("assistant", [
			{ type: "thinking", thinking: "private reasoning" },
			{ type: "text", text: "Use a small model." },
			{ type: "toolCall", name: "bash", arguments: { command: "secret command" } },
		]),
		message("user", [{ type: "text", text: "use luna with low thinking" }, { type: "image", data: "secret image" }]),
		message("assistant", [{ type: "text", text: "I will use gpt-6-luna." }]),
	] as any);
	assert.ok(prompt);
	const data = JSON.parse(prompt);
	assert.equal(data.currentName, "auto name session");
	assert.deepEqual(data.messages, [
		{ role: "user", text: "name sessions automatically" },
		{ role: "assistant", text: "Use a small model." },
		{ role: "user", text: "use luna with low thinking" },
		{ role: "assistant", text: "I will use gpt-6-luna." },
	]);
	assert.doesNotMatch(prompt, /secret|private reasoning|old subject|old answer/);
});

test("keeps user goals when a tool-heavy reply has many assistant progress messages", () => {
	const prompt = buildNamingPrompt("old topic", [
		message("user", "fix the login bug"),
		...Array.from({ length: 12 }, () => message("assistant", [{ type: "text", text: "running another check" }])),
		message("assistant", [{ type: "text", text: "The login bug is fixed." }]),
	] as any)!;
	assert.deepEqual(JSON.parse(prompt).messages, [
		{ role: "user", text: "fix the login bug" },
		{ role: "assistant", text: "The login bug is fixed." },
	]);
});

test("bounds the request even with huge messages, long history, and JSON escapes", () => {
	const entries = Array.from({ length: 1_000 }, (_, i) => message("user", "older " + i));
	entries.push(message("user", "LATEST GOAL " + "\n".repeat(50_000)));
	entries.push(message("assistant", [{ type: "text", text: "LATEST ANSWER " + "x".repeat(50_000) }]));
	const prompt = buildNamingPrompt("current title", entries as any)!;
	assert.ok(prompt.length <= 4_000, `request has ${prompt.length} characters`);
	assert.match(prompt, /LATEST GOAL/);
	assert.match(prompt, /LATEST ANSWER/);
	assert.doesNotMatch(prompt, /older 0"/);
});

test("bounds requests containing heavily escaped control characters without dropping the latest user goal", () => {
	const prompt = buildNamingPrompt("existing name", [
		message("user", "latest goal " + "\u0000".repeat(5_000)),
		message("assistant", [{ type: "text", text: "latest reply " + "\u0000".repeat(5_000) }]),
	] as any)!;
	assert.ok(prompt.length <= 4_000, `request has ${prompt.length} characters`);
	assert.match(prompt, /latest goal/);
	assert.match(prompt, /latest reply/);
});

test("does not request a name for tool-only or empty conversation content", () => {
	assert.equal(buildNamingPrompt(undefined, [message("toolResult", "output")] as any), undefined);
	assert.equal(buildNamingPrompt(undefined, [message("user", [{ type: "image", data: "image" }])] as any), undefined);
});

test("accepts a short plain name and normalizes harmless casing or outer quotes", () => {
	assert.equal(parseSessionName("Auto Name Session"), "auto name session");
	assert.equal(parseSessionName('  "fix login bug"  '), "fix login bug");
	assert.equal(parseSessionName("fix   login bug"), "fix login bug");
});

test("keeps the old name for KEEP, empty, malformed, or verbose responses", () => {
	for (const output of ["KEEP", "", "   ", "new name\nexplanation", '{"name":"new name"}',
		"# new name", "<name>new name</name>", "one two three four five six seven",
		"x".repeat(81), "bad\u001b[31m name"]) {
		assert.equal(parseSessionName(output), undefined, JSON.stringify(output));
	}
});
