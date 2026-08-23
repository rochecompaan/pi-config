import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ReviewProfileId } from "./review-profile.ts";
import {
	applyPendingReviewPromptFooter,
	armScheduledReviewPromptFooter,
	clearReviewPromptFooter,
	scheduleReviewPromptFooter,
	type ReviewPromptFooterState,
} from "./review-output-footer.ts";

export function registerReviewPromptFooterLifecycle(
	pi: Pick<ExtensionAPI, "on">,
	state: ReviewPromptFooterState,
): void {
	pi.on("before_agent_start", (event) => {
		armScheduledReviewPromptFooter(state, event.prompt);
	});

	pi.on("message_end", (event) => {
		const message = applyPendingReviewPromptFooter(state, event.message);
		return message ? { message } : undefined;
	});

	pi.on("agent_settled", () => {
		clearReviewPromptFooter(state);
	});
}

export function sendReviewPromptWithFooter(
	pi: Pick<ExtensionAPI, "sendUserMessage">,
	state: ReviewPromptFooterState,
	fullPrompt: string,
	profile: ReviewProfileId,
): void {
	try {
		scheduleReviewPromptFooter(state, fullPrompt, profile);
		pi.sendUserMessage(fullPrompt);
	} catch (error) {
		clearReviewPromptFooter(state);
		throw error;
	}
}
