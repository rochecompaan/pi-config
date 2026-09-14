import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type HandoffGenerationContext = {
	ctx: ExtensionCommandContext;
	messages: AgentMessage[];
	preparationMessages?: AgentMessage[];
};

export type HandoffIntent =
	| { kind: "manual"; goal: string }
	| { kind: "automatic" };

export type HandoffGenerationInput = HandoffGenerationContext & (
	| { intent: HandoffIntent; goal?: never }
	| { intent?: never; goal: string }
);

export type HandoffAction = "continue" | "offer" | "wait";

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

const LEGACY_AUTOMATIC_HANDOFF_GOAL =
	"Continue the current task in a fresh session. Preserve the current objective, decisions, progress, blockers, and concrete next steps.";

const MANUAL_HANDOFF_SYSTEM_PROMPT = `Create a faithful context handoff for a replacement coding-agent session.

Never create work that the user did not request.

First decide whether the replacement agent must CONTINUE or WAIT.

Choose CONTINUE only when an explicit user request remains unfinished and the agent can make progress without more user input.

Choose WAIT when the latest requested work is complete, work needs user input, work is blocked, no explicit unfinished request exists, or the state is unclear.

The input identifies the handoff mode:
- A MANUAL goal is an explicit user request for the new session.
- An AUTOMATIC rollover is extension policy, not a user request. Infer work only from unfinished user requests in the conversation.

Use the latest relevant messages as the current state. A completion report is terminal unless a later user message requests more work.

Passing tests, a clean worktree, unpushed commits, residual risks, possible follow-ups, and constraints are state information. They are not pending tasks. Do not turn them into instructions to verify, review, push, merge, clean up, or perform branch-completion work.

Explicit recommendations or offers the assistant put to the user are open recommendations while the user has neither accepted nor declined them. Later questions and answers do not close them. List every open recommendation under Open Recommendations, complete and close to the original wording; write None. when there are none. Open recommendations are not pending work: the replacement agent must not act on them unless the user asks, but it may re-surface them when the user asks for direction.

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
## Open Recommendations

For WAIT, use these sections:
## Context
## Current State
## Open Recommendations
## Pending User-Requested Work
None.
## Instruction
Wait for the user. Do not run tools or change repository state until the user asks.

Example: If the conversation ends with "Completed", passing tests, a clean worktree, and nothing pushed, choose WAIT. Preserve those facts, but do not ask the replacement agent to verify them or perform a branch-completion action.

Example: If the assistant recommended next steps that the user never accepted or declined, choose WAIT and list those recommendations under Open Recommendations.

Do not include a preamble.`;

const AUTOMATIC_HANDOFF_SYSTEM_PROMPT = `Create a faithful context handoff for a replacement coding-agent session.

Never create work that the user did not request.

First decide whether the replacement agent must CONTINUE, OFFER, or WAIT. Apply this priority:
1. Choose CONTINUE only when an explicit user request remains unfinished and the agent can make progress without more user input.
2. Otherwise choose OFFER when at least one assistant recommendation or offer still needs the user's response.
3. Otherwise choose WAIT.

Choose WAIT when the latest requested work is complete, work needs user input for a reason other than an open recommendation, work is blocked, no explicit unfinished request exists, or the state is unclear.

The input identifies the handoff mode:
- A MANUAL goal is an explicit user request for the new session.
- An AUTOMATIC rollover is extension policy, not a user request.

For AUTOMATIC rollover, use only User Conversation to infer unfinished work, identify open recommendations, and decide recommendation recency. Automatic Handoff Preparation is internal extension work, not user intent. Use it only to preserve reported continuity todo IDs, continuity notes, and preparation failures. Never let preparation open, close, or age a recommendation.

Use the latest relevant user-conversation messages as the current state. A completion report is terminal unless a later user message requests more work.

Passing tests, a clean worktree, unpushed commits, residual risks, possible follow-ups, and constraints are state information. They are not pending tasks. Do not turn them into instructions to verify, review, push, merge, clean up, or perform branch-completion work.

An explicit recommendation or offer from the assistant is open while the user has neither accepted nor declined it. Later unrelated questions and answers do not close it. Acceptance, rejection, selection of an incompatible alternative, or explicit withdrawal closes it. List every still-open recommendation under Open Recommendations, complete and close to the original wording; write None. when there are none. Open recommendations are not pending work, and the replacement agent must not act on them before the user accepts them.

For OFFER, choose one presentation instruction:
- Direct re-ask: when the open offer was the final assistant message and no user message followed it, immediately repeat the offer close to its original wording and ask for the user's choice.
- Contextual reminder: when later unrelated user messages followed without resolving the offer, start with exactly one short sentence about only the latest relevant user topic, then remind the user of every open recommendation and ask for a response.

Preserve every todo ID reported by Automatic Handoff Preparation under Continuity Todos. Explain that the replacement agent should read a listed todo when it needs the detailed requirements. Write None. when no todo was warranted. Never invent a todo ID.

Do not add tools, skills, workflows, checks, constraints, or next steps that do not appear in the user conversation or manual goal.

Start the response with exactly one of these lines:
HANDOFF_ACTION: CONTINUE
HANDOFF_ACTION: OFFER
HANDOFF_ACTION: WAIT

Then write a concise, self-contained prompt with the relevant decisions, progress, files, verification results, blockers, constraints, and continuity todos.

For CONTINUE, use these sections:
## Context
## Unfinished User Request
## Current State
## Continuity Todos
## Next Action
## Open Recommendations

For OFFER, use these sections:
## Context
## Current State
## Continuity Todos
## Open Recommendations
## Instruction

For WAIT, use these sections:
## Context
## Current State
## Continuity Todos
## Open Recommendations
## Pending User-Requested Work
None.
## Instruction
Wait for the user. Do not run tools or change repository state until the user asks.

Example: If the conversation ends with "Completed", passing tests, a clean worktree, and nothing pushed, choose WAIT. Preserve those facts, but do not ask the replacement agent to verify them or perform a branch-completion action.

Example: If the assistant's final message offered two next steps and the user did not reply, choose OFFER and tell the replacement agent to re-ask that choice immediately.

Example: If the user discussed another topic after an unanswered offer without accepting or declining it, choose OFFER and tell the replacement agent to use a one-sentence latest-topic introduction before reminding the user of every open recommendation.

Do not include a preamble.`;

function resolveHandoffIntent(input: HandoffGenerationInput): HandoffIntent {
	if ("intent" in input) return input.intent;
	return input.goal === LEGACY_AUTOMATIC_HANDOFF_GOAL
		? { kind: "automatic" }
		: { kind: "manual", goal: input.goal };
}

function buildHandoffRequest(
	conversationText: string,
	preparationText: string,
	intent: HandoffIntent,
): string {
	if (intent.kind === "manual") {
		return [
			"## Conversation History",
			"",
			conversationText,
			"",
			"## Handoff Mode",
			"",
			"MANUAL",
			"",
			"## User's Goal for New Thread",
			"",
			intent.goal,
		].join("\n");
	}
	return [
		"## User Conversation",
		"",
		conversationText,
		"",
		"## Automatic Handoff Preparation",
		"",
		preparationText,
		"",
		"## Handoff Mode",
		"",
		"AUTOMATIC",
		"",
		"No new user goal was provided. Determine continuation only from explicit unfinished user-requested work in the User Conversation.",
	].join("\n");
}

export async function completeHandoffPrompt(
	ctx: ExtensionCommandContext,
	userMessage: Message,
	signal: AbortSignal,
	sessionId: string,
	systemPrompt: string = AUTOMATIC_HANDOFF_SYSTEM_PROMPT,
): Promise<GeneratedHandoff | null> {
	const response = await ctx.modelRegistry.complete(
		ctx.model!,
		{ systemPrompt, messages: [userMessage] },
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
		: actionLine === "HANDOFF_ACTION: OFFER" ? "offer"
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

export function generateHandoffPrompt(
	input: HandoffGenerationContext & { intent: HandoffIntent },
	loadRuntime?: LoadHandoffGenerationRuntime,
): Promise<GeneratedHandoff | null>;
export function generateHandoffPrompt(
	input: HandoffGenerationContext & { goal: string },
	loadRuntime?: LoadHandoffGenerationRuntime,
): Promise<string | null>;
export async function generateHandoffPrompt(
	input: HandoffGenerationInput,
	loadRuntime: LoadHandoffGenerationRuntime = loadDefaultRuntime,
): Promise<GeneratedHandoff | string | null> {
	const { ctx, messages } = input;
	const legacyCall = !("intent" in input);
	const intent = resolveHandoffIntent(input);
	if (legacyCall && intent.kind === "automatic") return null;
	const { uuidv7, BorderedLoader, convertToLlm, serializeConversation } = await loadRuntime();
	const conversationText = serializeConversation(convertToLlm(messages));
	const preparationText = intent.kind === "automatic" && input.preparationMessages?.length
		? serializeConversation(convertToLlm(input.preparationMessages))
		: "None.";
	const outcome = await ctx.ui.custom<HandoffGenerationOutcome>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, "Generating handoff prompt...");
		loader.onAbort = () => done({ kind: "completed", value: null });
		const generate = async () => {
			const userMessage: Message = {
				role: "user",
				content: [{
					type: "text",
					text: buildHandoffRequest(conversationText, preparationText, intent),
				}],
				timestamp: Date.now(),
			};
			return completeHandoffPrompt(
				ctx,
				userMessage,
				loader.signal,
				uuidv7(),
				intent.kind === "manual"
					? MANUAL_HANDOFF_SYSTEM_PROMPT
					: AUTOMATIC_HANDOFF_SYSTEM_PROMPT,
			);
		};
		generate()
			.then((value) => done({ kind: "completed", value }))
			.catch((error) => done({ kind: "failed", error }));
		return loader;
	});
	if (outcome.kind === "failed") {
		throw outcome.error;
	}
	return legacyCall && outcome.value !== null ? outcome.value.prompt : outcome.value;
}

export default function handoffGenerationExtension(): void {}
