import type { ReviewProfileId } from "./review-profile.ts";

export type ReviewPromptName = "codex" | "thermo-nuclear";

export type ReviewOutputMessage = {
	role: string;
	stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted" | "pending";
	content?: unknown;
};

export type ReviewPromptFooterState = {
	scheduledPrompt?: {
		promptText: string;
		promptName: ReviewPromptName;
	};
	armedPrompt?: ReviewPromptName;
};

const REVIEW_PROMPT_NAMES: Record<ReviewProfileId, ReviewPromptName> = {
	standard: "codex",
	"thermo-nuclear": "thermo-nuclear",
};

const REVIEW_PROMPT_FOOTERS = new Set(
	Object.values(REVIEW_PROMPT_NAMES).map((name) => `review prompt: ${name}`),
);

export function createReviewPromptFooterState(): ReviewPromptFooterState {
	return {};
}

export function scheduleReviewPromptFooter(
	state: ReviewPromptFooterState,
	promptText: string,
	profile: ReviewProfileId,
): void {
	if (state.armedPrompt) {
		return;
	}

	state.scheduledPrompt = {
		promptText,
		promptName: REVIEW_PROMPT_NAMES[profile],
	};
}

export function armScheduledReviewPromptFooter(state: ReviewPromptFooterState, promptText: string): boolean {
	const scheduledPrompt = state.scheduledPrompt;
	if (!scheduledPrompt || state.armedPrompt) {
		return false;
	}

	state.scheduledPrompt = undefined;
	if (scheduledPrompt.promptText !== promptText) {
		return false;
	}

	state.armedPrompt = scheduledPrompt.promptName;
	return true;
}

export function clearReviewPromptFooter(state: ReviewPromptFooterState): void {
	state.scheduledPrompt = undefined;
	state.armedPrompt = undefined;
}

function findLastNonemptyTextBlock(content: unknown): { index: number; text: string } | undefined {
	if (!Array.isArray(content)) {
		return undefined;
	}

	for (let index = content.length - 1; index >= 0; index -= 1) {
		const block = content[index];
		if (
			block &&
			typeof block === "object" &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string" &&
			block.text.trim().length > 0
		) {
			return { index, text: block.text };
		}
	}

	return undefined;
}

function withoutTrailingReviewPromptFooters(text: string): string {
	let body = text.trimEnd();

	while (body) {
		const lineStart = body.lastIndexOf("\n") + 1;
		if (!REVIEW_PROMPT_FOOTERS.has(body.slice(lineStart).trim())) {
			break;
		}
		body = body.slice(0, lineStart).trimEnd();
	}

	return body;
}

function withCanonicalFooter(text: string, footer: string): string {
	const body = withoutTrailingReviewPromptFooters(text);
	return body ? `${body}\n\n${footer}` : footer;
}

export function applyPendingReviewPromptFooter<T extends ReviewOutputMessage>(
	state: ReviewPromptFooterState,
	message: T,
): T | undefined {
	const prompt = state.armedPrompt;
	if (!prompt || message.role !== "assistant") {
		return undefined;
	}

	if (
		message.stopReason === "toolUse" ||
		message.stopReason === "length" ||
		message.stopReason === "error"
	) {
		return undefined;
	}

	if (message.stopReason === "aborted") {
		clearReviewPromptFooter(state);
		return undefined;
	}

	if (message.stopReason !== "stop") {
		return undefined;
	}

	clearReviewPromptFooter(state);
	const textBlock = findLastNonemptyTextBlock(message.content);
	if (!textBlock) {
		return undefined;
	}

	const footer = `review prompt: ${prompt}`;
	if (!Array.isArray(message.content)) {
		return undefined;
	}

	const textUpdates = new Map<number, string>();
	let targetIndex: number | undefined;
	for (let index = textBlock.index; index >= 0; index -= 1) {
		const block = message.content[index];
		if (
			!block ||
			typeof block !== "object" ||
			!("type" in block) ||
			block.type !== "text" ||
			!("text" in block) ||
			typeof block.text !== "string"
		) {
			continue;
		}

		const body = withoutTrailingReviewPromptFooters(block.text);
		textUpdates.set(index, body);
		if (body.trim().length > 0) {
			targetIndex = index;
			break;
		}
	}

	targetIndex ??= textBlock.index;
	textUpdates.set(targetIndex, withCanonicalFooter(textUpdates.get(targetIndex) ?? "", footer));

	const content = [...message.content] as Array<Record<string, unknown>>;
	let changed = false;
	for (const [index, updatedText] of textUpdates) {
		const block = content[index];
		if (block.text === updatedText) {
			continue;
		}
		content[index] = { ...block, text: updatedText };
		changed = true;
	}

	if (!changed) {
		return message;
	}

	return { ...message, content } as T;
}
