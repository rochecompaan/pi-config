import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.BRIDGE_HISTORY_MODULE;
if (!modulePath) {
	throw new Error("BRIDGE_HISTORY_MODULE is required");
}

const {
	planAskClaudeSession,
	planHistoryReconstruction,
	prependHistoryTranscript,
} = await import(pathToFileURL(modulePath).href);

const multiToolThinkingHistory = [
	{ role: "user", content: "Inspect both files" },
	{
		role: "assistant",
		provider: "claude-bridge",
		content: [
			{
				type: "thinking",
				thinking: "private reasoning that must not be replayed",
				thinkingSignature: "signed-thinking-value",
			},
			{ type: "redacted_thinking", data: "redacted-thinking-value" },
			{ type: "toolCall", id: "toolu_first", name: "read", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "toolu_second", name: "read", arguments: { path: "b.ts" } },
		],
	},
	{
		role: "toolResult",
		toolCallId: "toolu_first",
		toolName: "read",
		content: [{ type: "text", text: "alpha" }],
	},
	{
		role: "toolResult",
		toolCallId: "toolu_second",
		toolName: "read",
		content: [{ type: "text", text: "beta" }],
	},
];

test("tree reconstruction after a multi-tool thinking turn uses plain transcript context", () => {
	const plan = planHistoryReconstruction(multiToolThinkingHistory, "claude-bridge");
	assert.equal(plan.kind, "transcript");
	assert.match(plan.transcript, /Inspect both files/);
	assert.match(plan.transcript, /Tool call: read/);
	assert.match(plan.transcript, /alpha/);
	assert.match(plan.transcript, /beta/);
	assert.doesNotMatch(plan.transcript, /private reasoning/);
	assert.doesNotMatch(plan.transcript, /signed-thinking-value/);
	assert.doesNotMatch(plan.transcript, /redacted-thinking-value/);
	assert.doesNotMatch(plan.transcript, /toolu_first|toolu_second/);
});

test("history without a Claude assistant turn keeps the import path", () => {
	assert.deepEqual(
		planHistoryReconstruction([
			{ role: "user", content: "question" },
			{ role: "assistant", provider: "openai-codex", content: [{ type: "text", text: "answer" }] },
		], "claude-bridge"),
		{ kind: "import" },
	);
});

test("fresh shared AskClaude queries neither resume nor persist", () => {
	assert.deepEqual(planAskClaudeSession(null), {
		resumeSessionId: null,
		persistSession: false,
	});
	assert.deepEqual(planAskClaudeSession("existing-session"), {
		resumeSessionId: "existing-session",
		persistSession: true,
	});
});

test("transcript context precedes current image prompt blocks", () => {
	const currentBlocks = [
		{ type: "text", text: "Inspect this image" },
		{ type: "image", data: "base64-data", mimeType: "image/png" },
	];
	const prepared = prependHistoryTranscript("plain transcript", "", currentBlocks);
	assert.equal(prepared.promptText, "");
	assert.deepEqual(prepared.promptBlocks.slice(1), currentBlocks);
	assert.match(prepared.promptBlocks[0].text, /plain transcript/);
	assert.match(prepared.promptBlocks[0].text, /Current request/);
});
