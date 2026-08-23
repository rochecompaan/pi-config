import test from "node:test";
import assert from "node:assert/strict";
import type { ReviewProfileId } from "./review-profile.ts";
import {
	applyPendingReviewPromptFooter,
	armScheduledReviewPromptFooter,
	clearReviewPromptFooter,
	createReviewPromptFooterState,
	scheduleReviewPromptFooter,
	type ReviewPromptFooterState,
} from "./review-output-footer.ts";

const REVIEW_PROMPT = "review rubric\n\n---\n\nreview target";

function scheduleAndArm(
	state: ReviewPromptFooterState,
	profile: ReviewProfileId = "standard",
	prompt = REVIEW_PROMPT,
): void {
	scheduleReviewPromptFooter(state, prompt, profile);
	assert.equal(armScheduledReviewPromptFooter(state, prompt), true);
}

test("appends the codex footer to a completed standard review", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "standard");
	const result = applyPendingReviewPromptFooter(state, {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "## Findings\n- (none)" }],
	});

	assert.equal(result?.content[0].text, "## Findings\n- (none)\n\nreview prompt: codex");
	assert.equal(state.armedPrompt, undefined);
});

test("appends the thermo-nuclear footer", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "thermo-nuclear");
	const result = applyPendingReviewPromptFooter(state, {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "## Findings" }],
	});

	assert.equal(result?.content[0].text, "## Findings\n\nreview prompt: thermo-nuclear");
});

test("trims trailing whitespace before adding one blank line", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "standard");
	const result = applyPendingReviewPromptFooter(state, {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "## Findings\n- (none) \t\n" }],
	});

	assert.equal(result?.content[0].text, "## Findings\n- (none)\n\nreview prompt: codex");
});

test("appends the footer to the last nonempty text block", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "standard");
	const result = applyPendingReviewPromptFooter(state, {
		role: "assistant",
		stopReason: "stop",
		content: [
			{ type: "text", text: "Reasoning" },
			{ type: "thinking", text: "more reasoning" },
			{ type: "text", text: "## Findings" },
		],
	});

	assert.equal(result?.content[0].text, "Reasoning");
	assert.equal(result?.content[2].text, "## Findings\n\nreview prompt: codex");
});

test("does not duplicate an existing footer", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "standard");
	const message = {
		role: "assistant",
		stopReason: "stop" as const,
		content: [{ type: "text", text: "## Findings\n\nreview prompt: codex" }],
	};

	assert.equal(applyPendingReviewPromptFooter(state, message), message);
	assert.equal(state.armedPrompt, undefined);
});

test("appends a standalone footer when prose ends with the footer text", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "standard");
	const result = applyPendingReviewPromptFooter(state, {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "Conclusion: selected review prompt: codex" }],
	});

	assert.equal(
		result?.content[0].text,
		"Conclusion: selected review prompt: codex\n\nreview prompt: codex",
	);
});

test("normalizes trailing whitespace after an existing footer", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "standard");
	const result = applyPendingReviewPromptFooter(state, {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "## Findings\n\nreview prompt: codex \t\n" }],
	});

	assert.equal(result?.content[0].text, "## Findings\n\nreview prompt: codex");
});

test("normalizes excess blank lines before an existing footer", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "standard");
	const result = applyPendingReviewPromptFooter(state, {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "## Findings\n\n\n\nreview prompt: codex" }],
	});

	assert.equal(result?.content[0].text, "## Findings\n\nreview prompt: codex");
});

test("collapses repeated standalone footers to one canonical footer", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "standard");
	const result = applyPendingReviewPromptFooter(state, {
		role: "assistant",
		stopReason: "stop",
		content: [
			{
				type: "text",
				text: "## Findings\n\nreview prompt: codex\n\nreview prompt: codex",
			},
		],
	});

	assert.equal(result?.content[0].text, "## Findings\n\nreview prompt: codex");
});

test("normalizes an indented standalone footer", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "standard");
	const result = applyPendingReviewPromptFooter(state, {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "## Findings\n\n  review prompt: codex \t" }],
	});

	assert.equal(result?.content[0].text, "## Findings\n\nreview prompt: codex");
});

test("replaces a trailing footer for the wrong profile", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "standard");
	const result = applyPendingReviewPromptFooter(state, {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "## Findings\n\n  review prompt: thermo-nuclear" }],
	});

	assert.equal(result?.content[0].text, "## Findings\n\nreview prompt: codex");
});

test("collapses alternating profile footer candidates to the selected footer", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "thermo-nuclear");
	const result = applyPendingReviewPromptFooter(state, {
		role: "assistant",
		stopReason: "stop",
		content: [
			{
				type: "text",
				text:
					"## Findings\n\nreview prompt: thermo-nuclear\n\nreview prompt: codex\n\nreview prompt: thermo-nuclear\n\nreview prompt: codex",
			},
		],
	});

	assert.equal(result?.content[0].text, "## Findings\n\nreview prompt: thermo-nuclear");
});

test("collapses repeated footer candidates across trailing text blocks", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "standard");
	const result = applyPendingReviewPromptFooter(state, {
		role: "assistant",
		stopReason: "stop",
		content: [
			{ type: "text", text: "## Findings\n\nreview prompt: codex" },
			{ type: "text", text: "review prompt: codex" },
		],
	});

	assert.equal(result?.content[0].text, "## Findings\n\nreview prompt: codex");
	assert.equal(result?.content[1].text, "");
});

test("replaces wrong-profile footer candidates across trailing text blocks", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "standard");
	const thinking = { type: "thinking", thinking: "review reasoning" };
	const result = applyPendingReviewPromptFooter(state, {
		role: "assistant",
		stopReason: "stop",
		content: [
			{ type: "text", text: "## Findings\n\nreview prompt: thermo-nuclear" },
			thinking,
			{ type: "text", text: "review prompt: codex" },
		],
	});

	assert.equal(result?.content[0].text, "## Findings\n\nreview prompt: codex");
	assert.equal(result?.content[1], thinking);
	assert.equal(result?.content[2].text, "");
});

test("leaves tool-use messages unchanged and keeps the footer armed", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "standard");
	const message = {
		role: "assistant",
		stopReason: "toolUse" as const,
		content: [{ type: "toolCall", id: "call-1" }],
	};

	assert.equal(applyPendingReviewPromptFooter(state, message), undefined);
	assert.equal(state.armedPrompt, "codex");
});

for (const stopReason of ["length", "error"] as const) {
	test(`preserves the footer across a ${stopReason} response and appends it after retry`, () => {
		const state = createReviewPromptFooterState();
		scheduleAndArm(state, "standard");
		const partial = { role: "assistant", stopReason, content: [{ type: "text", text: "partial" }] };

		assert.equal(applyPendingReviewPromptFooter(state, partial), undefined);
		assert.equal(state.armedPrompt, "codex");

		const completed = applyPendingReviewPromptFooter(state, {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "Retried review" }],
		});
		assert.equal(completed?.content[0].text, "Retried review\n\nreview prompt: codex");
		assert.equal(state.armedPrompt, undefined);
	});
}

test("clears the footer after an aborted response", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "standard");
	const message = {
		role: "assistant",
		stopReason: "aborted" as const,
		content: [{ type: "text", text: "partial" }],
	};

	assert.equal(applyPendingReviewPromptFooter(state, message), undefined);
	assert.equal(state.armedPrompt, undefined);
});

test("leaves non-assistant messages unchanged", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "standard");
	const message = { role: "user", content: [{ type: "text", text: "hello" }] };

	assert.equal(applyPendingReviewPromptFooter(state, message), undefined);
	assert.equal(state.armedPrompt, "codex");
});

test("clears the footer when a completed assistant message has no nonempty text", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "standard");
	const message = {
		role: "assistant",
		stopReason: "stop" as const,
		content: [{ type: "thinking", text: "reasoning" }, { type: "text", text: " \n\t" }],
	};

	assert.equal(applyPendingReviewPromptFooter(state, message), undefined);
	assert.equal(state.armedPrompt, undefined);
});

test("explicitly clears stale scheduled and armed footer state", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "thermo-nuclear");

	clearReviewPromptFooter(state);

	assert.equal(state.scheduledPrompt, undefined);
	assert.equal(state.armedPrompt, undefined);
});

test("arms a scheduled footer only for the exact review prompt", () => {
	const state = createReviewPromptFooterState();
	scheduleReviewPromptFooter(state, REVIEW_PROMPT, "standard");

	assert.equal(armScheduledReviewPromptFooter(state, REVIEW_PROMPT), true);
	assert.equal(state.scheduledPrompt, undefined);
	assert.equal(state.armedPrompt, "codex");
});

test("an asynchronous dispatch rejection cannot label a later unrelated response", () => {
	const state = createReviewPromptFooterState();
	scheduleReviewPromptFooter(state, REVIEW_PROMPT, "standard");

	assert.equal(armScheduledReviewPromptFooter(state, "ordinary user prompt"), false);
	const result = applyPendingReviewPromptFooter(state, {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "Ordinary answer" }],
	});

	assert.equal(result, undefined);
	assert.equal(state.scheduledPrompt, undefined);
	assert.equal(state.armedPrompt, undefined);
});

test("a review attempted during streaming cannot label the active unrelated response", () => {
	const state = createReviewPromptFooterState();
	scheduleReviewPromptFooter(state, REVIEW_PROMPT, "thermo-nuclear");

	const result = applyPendingReviewPromptFooter(state, {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "Already-streaming answer" }],
	});

	assert.equal(result, undefined);
	assert.equal(state.scheduledPrompt?.promptText, REVIEW_PROMPT);
	assert.equal(state.armedPrompt, undefined);
});

test("a second review attempt does not replace an armed footer", () => {
	const state = createReviewPromptFooterState();
	scheduleAndArm(state, "standard", REVIEW_PROMPT);
	scheduleReviewPromptFooter(state, "second review prompt", "thermo-nuclear");

	const result = applyPendingReviewPromptFooter(state, {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "Review result" }],
	});

	assert.equal(result?.content[0].text, "Review result\n\nreview prompt: codex");
});
