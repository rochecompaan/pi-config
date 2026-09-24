import assert from "node:assert/strict";
import test from "node:test";
import { selectContext } from "./context-policy.ts";

const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 });
const assistant = (text: string) => ({ role: "assistant" as const, content: [{ type: "text", text }], timestamp: 0 });
const toolAssistant = (id: string) => ({
	role: "assistant" as const,
	content: [{ type: "toolCall" as const, id, name: "read", arguments: { path: `src/${id}.ts` } }],
	timestamp: 0,
});
const result = (id: string, text: string) => ({
	role: "toolResult" as const,
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text" as const, text }],
	isError: false,
	timestamp: 0,
});
const hasMarker = (messages: readonly any[], value: string) => messages.some((message) => {
	const text = typeof message.content === "string"
		? message.content
		: message.content?.map((block: any) => block.text ?? "").join("") ?? "";
	return text.includes(value);
});

function observedSessionFixture(input: {
	oldRequest: string;
	oldAnswer: string;
	recentRequest: string;
	recentAnswer: string;
	activeRequest: string;
	exchangeCount: number;
}) {
	const messages: object[] = [
		user(`${input.oldRequest} ${"old requirements ".repeat(12_000)}`),
		assistant(`${input.oldAnswer} ${"old answer ".repeat(12_000)}`),
		user(input.recentRequest),
		assistant(input.recentAnswer),
		user(input.activeRequest),
	];
	for (let index = 0; index < input.exchangeCount; index++) {
		const id = `active-call-${index}`;
		messages.push(toolAssistant(id), result(id, `ACTIVE_EXCHANGE_${index} ${"current output ".repeat(1_500)}`));
	}
	return messages;
}

function assertCompletedTurnsAreCoherent(messages: readonly any[]): void {
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const calls = message.content.filter((block: any) => block.type === "toolCall");
		if (calls.length === 0) continue;
		const results = messages.slice(index + 1, index + 1 + calls.length);
		assert.equal(results.length, calls.length, "assistant tool calls retain all results");
		assert.deepEqual(new Set(results.map((result) => result.toolCallId)), new Set(calls.map((call: any) => call.id)));
	}
}

test("observed session selection keeps recent active task state coherent", () => {
	const messages = observedSessionFixture({
		oldRequest: "OLD_REQUIREMENTS_REQUEST",
		oldAnswer: "OLD_REQUIREMENTS_ANSWER",
		recentRequest: "RECENT_SIMPLE_REQUEST",
		recentAnswer: "RECENT_SIMPLE_ANSWER",
		activeRequest: "ACTIVE_IMPLEMENTATION_REQUEST",
		exchangeCount: 8,
	});
	const selected = selectContext({
		messages: messages as any,
		systemPrompt: "resident prompt",
		activeTools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
		modelContextWindow: 64_000,
		tokenBudget: 64_000,
	});

	assert.equal(hasMarker(selected.messages, "ACTIVE_IMPLEMENTATION_REQUEST"), true);
	assertCompletedTurnsAreCoherent(selected.messages);
	assert.equal(
		hasMarker(selected.messages, "OLD_REQUIREMENTS_REQUEST")
			&& !hasMarker(selected.messages, "OLD_REQUIREMENTS_ANSWER"),
		false,
	);
});
