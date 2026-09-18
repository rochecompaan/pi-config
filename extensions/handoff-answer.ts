import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Select visible text only; whether it answers a question is the generator's decision. */
export function getLastAnswerCandidate(messages: AgentMessage[]): string | undefined {
	const index = messages.findLastIndex((message) => message.role === "assistant");
	const last = messages[index];
	// Unrelated internal notices do not supersede an answer; user messages and prior replays do.
	const superseded = messages.slice(index + 1).some((message) =>
		message.role !== "custom" || message.customType === "handoff-answer",
	);
	if (
		superseded ||
		last?.role !== "assistant" ||
		last.stopReason !== "stop" ||
		!messages.some((message) => message.role === "user") ||
		last.content.some((part) => part.type === "toolCall")
	) return undefined;

	const text = last.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return text.trim() ? text : undefined;
}

// Helper files in this directory are also discovered as extensions.
export default function handoffAnswerExtension(): void {}
