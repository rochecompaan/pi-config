import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type HandoffGenerationInput = {
	ctx: ExtensionCommandContext;
	messages: AgentMessage[];
	goal: string;
};

export type HandoffGenerationRuntime = {
	uuidv7: typeof import("@earendil-works/pi-ai").uuidv7;
	BorderedLoader: typeof import("@earendil-works/pi-coding-agent").BorderedLoader;
	convertToLlm: typeof import("@earendil-works/pi-coding-agent").convertToLlm;
	serializeConversation: typeof import("@earendil-works/pi-coding-agent").serializeConversation;
};

export type LoadHandoffGenerationRuntime = () => Promise<HandoffGenerationRuntime>;

const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

export async function completeHandoffPrompt(
	ctx: ExtensionCommandContext,
	userMessage: Message,
	signal: AbortSignal,
	sessionId: string,
): Promise<string | null> {
	const response = await ctx.modelRegistry.complete(
		ctx.model!,
		{ systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [userMessage] },
		{ signal, cacheRetention: "none", sessionId },
	);
	if (response.stopReason === "aborted") return null;
	return response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

const loadDefaultRuntime: LoadHandoffGenerationRuntime = async () => {
	const [ai, codingAgent] = await Promise.all([
		import("@earendil-works/pi-ai"),
		import("@earendil-works/pi-coding-agent"),
	]);
	return {
		uuidv7: ai.uuidv7,
		BorderedLoader: codingAgent.BorderedLoader,
		convertToLlm: codingAgent.convertToLlm,
		serializeConversation: codingAgent.serializeConversation,
	};
};

export async function generateHandoffPrompt(
	{ ctx, messages, goal }: HandoffGenerationInput,
	loadRuntime: LoadHandoffGenerationRuntime = loadDefaultRuntime,
): Promise<string | null> {
	const { uuidv7, BorderedLoader, convertToLlm, serializeConversation } = await loadRuntime();
	const conversationText = serializeConversation(convertToLlm(messages));
	return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, "Generating handoff prompt...");
		loader.onAbort = () => done(null);
		const generate = async () => {
			const userMessage: Message = {
				role: "user",
				content: [{
					type: "text",
					text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
				}],
				timestamp: Date.now(),
			};
			return completeHandoffPrompt(ctx, userMessage, loader.signal, uuidv7());
		};
		generate().then(done).catch((error) => {
			console.error("Handoff generation failed:", error);
			done(null);
		});
		return loader;
	});
}

export default function handoffGenerationExtension(): void {}
