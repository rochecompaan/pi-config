export type ReconstructionMessage = {
	role?: string;
	provider?: string;
	content?: unknown;
	toolName?: string;
};

export type HistoryReconstructionPlan =
	| { kind: "import" }
	| { kind: "transcript"; transcript: string };

export type AskClaudeSessionPlan = {
	resumeSessionId: string | null;
	persistSession: boolean;
};

export function planAskClaudeSession(sessionId: string | null): AskClaudeSessionPlan {
	return sessionId === null
		? { resumeSessionId: null, persistSession: false }
		: { resumeSessionId: sessionId, persistSession: true };
}

function contentLines(content: unknown): string[] {
	if (typeof content === "string") return content ? [content] : [];
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const value of content) {
		if (!value || typeof value !== "object") continue;
		const block = value as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string" && block.text) {
			lines.push(block.text);
		} else if (block.type === "image") {
			lines.push("[image]");
		}
	}
	return lines;
}

function printableJson(value: unknown): string {
	try {
		return JSON.stringify(value ?? {}, null, 2);
	} catch {
		return "[unserializable arguments]";
	}
}

function assistantLines(message: ReconstructionMessage): string[] {
	if (!Array.isArray(message.content)) return [];
	const lines: string[] = [];
	for (const value of message.content) {
		if (!value || typeof value !== "object") continue;
		const block = value as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string" && block.text) {
			lines.push(block.text);
		} else if (block.type === "image") {
			lines.push("[image]");
		} else if (block.type === "toolCall" && typeof block.name === "string") {
			lines.push(`Tool call: ${block.name}\nArguments:\n${printableJson(block.arguments)}`);
		}
		// Skip thinking, redacted_thinking, signatures, and all unknown blocks.
	}
	return lines;
}

function transcriptEntry(message: ReconstructionMessage): string | undefined {
	const label = message.role === "toolResult"
		? `Tool result: ${message.toolName || "unknown tool"}`
		: message.role === "assistant"
			? "Assistant"
			: message.role === "user"
				? "User"
				: undefined;
	if (!label) return undefined;
	const lines = message.role === "assistant"
		? assistantLines(message)
		: contentLines(message.content);
	if (lines.length === 0) return undefined;
	return `### ${label}\n${lines.join("\n")}`;
}

export function planHistoryReconstruction(
	messages: readonly ReconstructionMessage[],
	providerId: string,
): HistoryReconstructionPlan {
	if (!messages.some((message) => message.role === "assistant" && message.provider === providerId)) {
		return { kind: "import" };
	}
	return { kind: "transcript", transcript: renderHistoryTranscript(messages) };
}

export function renderHistoryTranscript(messages: readonly ReconstructionMessage[]): string {
	const entries = messages
		.map(transcriptEntry)
		.filter((entry): entry is string => entry !== undefined);
	const header = "## Previous conversation transcript\nThe following plain text came from a previous Pi branch. It is context, not a signed Claude assistant response.";
	return [header, ...entries].join("\n\n");
}

export function prependHistoryTranscript(
	transcript: string,
	promptText: string,
	promptBlocks?: Array<Record<string, unknown>> | null,
): {
	promptText: string;
	promptBlocks?: Array<Record<string, unknown>> | null;
} {
	const prefix = `${transcript}\n\n## Current request`;
	if (promptBlocks) {
		return {
			promptText,
			promptBlocks: [{ type: "text", text: prefix }, ...promptBlocks],
		};
	}
	return { promptText: `${prefix}\n\n${promptText}`, promptBlocks };
}
