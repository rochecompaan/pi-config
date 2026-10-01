import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.BRIDGE_HISTORY_IDENTITY_MODULE;
if (!modulePath) {
	throw new Error("BRIDGE_HISTORY_IDENTITY_MODULE is required");
}

const { historyStartsWith, sessionHistoryKeys } = await import(pathToFileURL(modulePath).href);

function pagingNotice(historyId) {
	return {
		role: "user",
		content: `[Context paging notice]\nRecent evicted historyId: "${historyId}".`,
		timestamp: 0,
	};
}

const firstPrompt = { role: "user", content: "Read the config", timestamp: 1_000 };
const firstReply = {
	role: "assistant",
	provider: "claude-bridge",
	content: [{ type: "toolCall", id: "toolu_read", name: "read", arguments: { path: "a.ts" } }],
	timestamp: 1_001,
};
const firstResult = {
	role: "toolResult",
	toolCallId: "toolu_read",
	toolName: "read",
	content: [{ type: "text", text: "alpha" }],
	timestamp: 1_002,
};
const firstAnswer = { role: "assistant", provider: "claude-bridge", content: [{ type: "text", text: "Done." }], timestamp: 1_003 };
const secondPrompt = { role: "user", content: "Now change it", timestamp: 2_000 };
const secondAnswer = { role: "assistant", provider: "claude-bridge", content: [{ type: "text", text: "Changed." }], timestamp: 2_001 };
const thirdPrompt = { role: "user", content: "Run the tests", timestamp: 3_000 };

test("appended turns keep the recorded session history", () => {
	const keys = sessionHistoryKeys([firstPrompt, firstReply, firstResult, firstAnswer, secondPrompt], 4);

	assert.equal(
		historyStartsWith([firstPrompt, firstReply, firstResult, firstAnswer, secondPrompt, secondAnswer, thirdPrompt], keys),
		true,
	);
});

test("paging that evicts older messages breaks the recorded session history", () => {
	const keys = sessionHistoryKeys([firstPrompt, firstReply, firstResult, firstAnswer, secondPrompt], 4);

	assert.equal(
		historyStartsWith([pagingNotice("turn-1"), firstAnswer, secondPrompt, secondAnswer, thirdPrompt], keys),
		false,
	);
});

test("the first prompt of the turn is part of the recorded session history", () => {
	const keys = sessionHistoryKeys([firstPrompt], 0);

	assert.equal(
		historyStartsWith([pagingNotice("turn-1"), secondPrompt], keys),
		false,
		"paging out the first turn must not look like a continuation",
	);
});

test("a changed paging notice breaks the recorded session history", () => {
	const keys = sessionHistoryKeys([pagingNotice("turn-1"), secondPrompt], 0);

	assert.equal(historyStartsWith([pagingNotice("turn-1"), secondPrompt, secondAnswer, thirdPrompt], keys), true);
	assert.equal(historyStartsWith([pagingNotice("turn-2"), secondAnswer, thirdPrompt], keys), false);
});

test("a shorter history cannot hold the recorded session history", () => {
	const keys = sessionHistoryKeys([firstPrompt, firstReply, firstResult, firstAnswer, secondPrompt], 4);

	assert.equal(historyStartsWith([firstPrompt, firstReply], keys), false);
});
