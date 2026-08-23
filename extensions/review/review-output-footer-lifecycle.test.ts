import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	registerReviewPromptFooterLifecycle,
	sendReviewPromptWithFooter,
} from "./review-output-footer-lifecycle.ts";
import { createReviewPromptFooterState } from "./review-output-footer.ts";

const REVIEW_PROMPT = "review rubric\n\n---\n\nreview target";

type EventHandler = (event?: { prompt?: string; message?: unknown }) => unknown;

function createLifecycleHarness() {
	const state = createReviewPromptFooterState();
	const handlers = new Map<string, EventHandler>();
	const sentPrompts: string[] = [];
	const stateAtSend: Array<{ scheduledPrompt?: string; armedPrompt?: string }> = [];
	const pi = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, handler);
		},
		sendUserMessage(prompt: string) {
			sentPrompts.push(prompt);
			stateAtSend.push({
				scheduledPrompt: state.scheduledPrompt?.promptText,
				armedPrompt: state.armedPrompt,
			});
		},
	} as unknown as Pick<ExtensionAPI, "on" | "sendUserMessage">;

	registerReviewPromptFooterLifecycle(pi, state);

	return {
		state,
		sentPrompts,
		stateAtSend,
		beforeAgentStart(prompt: string) {
			return handlers.get("before_agent_start")?.({ prompt });
		},
		messageEnd(message: unknown) {
			return handlers.get("message_end")?.({ message });
		},
		agentSettled() {
			return handlers.get("agent_settled")?.();
		},
		send(profile: "standard" | "thermo-nuclear" = "standard") {
			sendReviewPromptWithFooter(pi, state, REVIEW_PROMPT, profile);
		},
	};
}

test("registered lifecycle sends after scheduling and persists a retried review footer", () => {
	const harness = createLifecycleHarness();

	harness.send("standard");
	assert.deepEqual(harness.sentPrompts, [REVIEW_PROMPT]);
	assert.deepEqual(harness.stateAtSend, [{ scheduledPrompt: REVIEW_PROMPT, armedPrompt: undefined }]);

	harness.beforeAgentStart(REVIEW_PROMPT);
	assert.equal(harness.state.scheduledPrompt, undefined);
	assert.equal(harness.state.armedPrompt, "codex");

	assert.equal(
		harness.messageEnd({
			role: "assistant",
			stopReason: "error",
			content: [{ type: "text", text: "temporary failure" }],
		}),
		undefined,
	);
	assert.equal(harness.state.armedPrompt, "codex");

	const result = harness.messageEnd({
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "## Findings\n- none" }],
	}) as { message?: { content?: Array<{ text?: string }> } } | undefined;
	assert.equal(result?.message?.content?.[0]?.text, "## Findings\n- none\n\nreview prompt: codex");
	assert.equal(harness.state.armedPrompt, undefined);
});

test("registered settlement clears a scheduled but unarmed footer", () => {
	const harness = createLifecycleHarness();

	harness.send();
	assert.equal(harness.state.scheduledPrompt?.promptText, REVIEW_PROMPT);
	assert.equal(harness.state.armedPrompt, undefined);

	harness.agentSettled();
	assert.equal(harness.state.scheduledPrompt, undefined);
	assert.equal(harness.state.armedPrompt, undefined);
});

test("registered settlement clears an armed footer after a final failure", () => {
	const harness = createLifecycleHarness();

	harness.send("thermo-nuclear");
	harness.beforeAgentStart(REVIEW_PROMPT);
	assert.equal(harness.state.armedPrompt, "thermo-nuclear");

	harness.agentSettled();
	assert.equal(harness.state.scheduledPrompt, undefined);
	assert.equal(harness.state.armedPrompt, undefined);
});

test("an asynchronously rejected dispatch cannot label an unrelated registered response", () => {
	const harness = createLifecycleHarness();

	// Pi's extension wrapper returns void and reports the rejected Promise internally.
	harness.send();
	const result = harness.messageEnd({
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "Unrelated answer" }],
	});

	assert.equal(result, undefined);
	assert.equal(harness.state.scheduledPrompt?.promptText, REVIEW_PROMPT);
	assert.equal(harness.state.armedPrompt, undefined);

	harness.agentSettled();
	assert.equal(harness.state.scheduledPrompt, undefined);
});
