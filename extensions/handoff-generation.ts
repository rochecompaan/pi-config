import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type HandoffGenerationInput = {
	ctx: ExtensionCommandContext;
	messages: AgentMessage[];
	intent: HandoffIntent;
};

export type HandoffIntent =
	| { kind: "manual"; goal: string }
	| { kind: "automatic" };

export type HandoffAction = "continue" | "wait";

export type GeneratedHandoff = {
	action: HandoffAction;
	prompt: string;
};

export type HandoffGenerationRuntime = {
	uuidv7: typeof import("@earendil-works/pi-ai").uuidv7;
	BorderedLoader: typeof import("@earendil-works/pi-coding-agent").BorderedLoader;
	convertToLlm: typeof import("@earendil-works/pi-coding-agent").convertToLlm;
	serializeConversation: typeof import("@earendil-works/pi-coding-agent").serializeConversation;
};

export type LoadHandoffGenerationRuntime = () => Promise<HandoffGenerationRuntime>;

type HandoffGenerationOutcome =
	| { kind: "completed"; value: GeneratedHandoff | null }
	| { kind: "failed"; error: unknown };

const HANDOFF_SYSTEM_PROMPT = `Create a faithful context handoff for a replacement coding-agent session.

Never create work that the user did not request.

First decide whether the replacement agent must CONTINUE or WAIT.

Choose CONTINUE only when an explicit user request remains unfinished and the agent can make progress without more user input.

Choose WAIT when the latest requested work is complete, work needs user input, work is blocked, no explicit unfinished request exists, or the state is unclear.

The input identifies the handoff mode:
- A MANUAL goal is an explicit user request for the new session.
- An AUTOMATIC rollover is extension policy, not a user request. Infer work only from unfinished user requests in the conversation.

Use the latest relevant messages as the current state. A completion report is terminal unless a later user message requests more work.

Passing tests, a clean worktree, unpushed commits, residual risks, possible follow-ups, and constraints are state information. They are not pending tasks. Do not turn them into instructions to verify, review, push, merge, clean up, or perform branch-completion work.

Do not add tools, skills, workflows, checks, constraints, or next steps that do not appear in the conversation or the manual goal.

Start the response with exactly one of these lines:
HANDOFF_ACTION: CONTINUE
HANDOFF_ACTION: WAIT

Then write a concise, self-contained prompt with the relevant decisions, progress, files, verification results, blockers, and constraints.

For CONTINUE, use these sections:
## Context
## Unfinished User Request
## Current State
## Next Action

For WAIT, use these sections:
## Context
## Current State
## Pending User-Requested Work
None.
## Instruction
Wait for the user. Do not run tools or change repository state until the user asks.

Example: If the conversation ends with "Completed", passing tests, a clean worktree, and nothing pushed, choose WAIT. Preserve those facts, but do not ask the replacement agent to verify them or perform a branch-completion action.

Do not include a preamble.`;

function buildHandoffRequest(conversationText: string, intent: HandoffIntent): string {
	const handoffMode = intent.kind === "manual"
		? [
			"## Handoff Mode",
			"",
			"MANUAL",
			"",
			"## User's Goal for New Thread",
			"",
			intent.goal,
		]
		: [
			"## Handoff Mode",
			"",
			"AUTOMATIC",
			"",
			"No new user goal was provided. Determine continuation only from explicit unfinished user-requested work in the conversation.",
		];
	return [
		"## Conversation History",
		"",
		conversationText,
		"",
		...handoffMode,
	].join("\n");
}

export async function completeHandoffPrompt(
	ctx: ExtensionCommandContext,
	userMessage: Message,
	signal: AbortSignal,
	sessionId: string,
): Promise<GeneratedHandoff | null> {
	const response = await ctx.modelRegistry.complete(
		ctx.model!,
		{ systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [userMessage] },
		{ signal, cacheRetention: "none", sessionId },
	);
	switch (response.stopReason) {
		case "aborted":
			return null;
		case "error":
			throw new Error(response.errorMessage || "Handoff generation failed");
		case "length":
			throw new Error("Handoff generation was truncated");
		case "stop":
			break;
		default:
			throw new Error(`Handoff generation was incomplete (${response.stopReason})`);
	}

	const output = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	if (output.trim().length === 0) {
		throw new Error("Handoff generation returned an empty prompt");
	}

	const [actionLine, ...promptLines] = output.trim().split(/\r?\n/);
	const action =
		actionLine === "HANDOFF_ACTION: CONTINUE" ? "continue"
		: actionLine === "HANDOFF_ACTION: WAIT" ? "wait"
		: undefined;
	if (!action) {
		throw new Error("Handoff generation returned an invalid action");
	}
	const prompt = promptLines.join("\n").trim();
	if (prompt.length === 0) {
		throw new Error("Handoff generation returned an empty prompt");
	}
	return { action, prompt };
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
	{ ctx, messages, intent }: HandoffGenerationInput,
	loadRuntime: LoadHandoffGenerationRuntime = loadDefaultRuntime,
): Promise<GeneratedHandoff | null> {
	const { uuidv7, BorderedLoader, convertToLlm, serializeConversation } = await loadRuntime();
	const conversationText = serializeConversation(convertToLlm(messages));
	const outcome = await ctx.ui.custom<HandoffGenerationOutcome>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, "Generating handoff prompt...");
		loader.onAbort = () => done({ kind: "completed", value: null });
		const generate = async () => {
			const userMessage: Message = {
				role: "user",
				content: [{
					type: "text",
					text: buildHandoffRequest(conversationText, intent),
				}],
				timestamp: Date.now(),
			};
			return completeHandoffPrompt(ctx, userMessage, loader.signal, uuidv7());
		};
		generate()
			.then((value) => done({ kind: "completed", value }))
			.catch((error) => done({ kind: "failed", error }));
		return loader;
	});
	if (outcome.kind === "failed") {
		throw outcome.error;
	}
	return outcome.value;
}

export default function handoffGenerationExtension(): void {}
