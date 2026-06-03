export interface RunnerTextPart {
	type: "text";
	text: string;
}

export interface RunnerMessage {
	role: string;
	content: RunnerTextPart[];
	usage?: {
		input?: number;
		output?: number;
	};
	stopReason?: string;
}

export type RunnerSessionEvent =
	| {
			type: "message_update";
			assistantMessageEvent: {
				type: "text_delta";
				delta: string;
			};
	  }
	| {
			type: "message_end";
			message?: RunnerMessage;
	  }
	| {
			type: "agent_end";
	  };

export type RunnerPromptMode = "draft" | "discussion" | "synthesis";

export interface RunnerSession {
	messages: RunnerMessage[];
	subscribe(listener: (event: RunnerSessionEvent) => void): () => void;
	prompt(text: string, mode?: RunnerPromptMode): Promise<void>;
	dispose(): void;
	abort(): Promise<void>;
}

export interface ManagedSession {
	memberKey: string;
	memberName: string;
	model: string;
	session: RunnerSession;
}

export interface CreateManagedSessionInput {
	memberKey: string;
	memberName: string;
	model: string;
	createSession: () => Promise<RunnerSession>;
}

export interface RunSessionInput {
	session: RunnerSession;
	prompt: string;
	signal?: AbortSignal;
	onTextDelta?: (update: { delta: string; streamedText: string }) => void;
}

export interface RunSessionResult {
	text: string;
	streamedText: string;
	tokens: {
		input: number;
		output: number;
	};
	stopReason: string;
	durationMs: number;
}

export async function createManagedSession(input: CreateManagedSessionInput): Promise<ManagedSession> {
	return {
		memberKey: input.memberKey,
		memberName: input.memberName,
		model: input.model,
		session: await input.createSession(),
	};
}

export async function disposeManagedSessions(sessions: ReadonlyArray<ManagedSession>): Promise<void> {
	for (const managed of sessions) {
		managed.session.dispose();
	}
}

export function extractLastAssistantText(messages: ReadonlyArray<RunnerMessage>): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) {
			return text;
		}
	}
	return "";
}

export async function runDraft(input: RunSessionInput): Promise<RunSessionResult> {
	return runSessionOperation({ ...input, mode: "draft" });
}

export async function runDiscussion(input: RunSessionInput): Promise<RunSessionResult> {
	return runSessionOperation({ ...input, mode: "discussion" });
}

export async function runSynthesis(input: RunSessionInput): Promise<RunSessionResult> {
	return runSessionOperation({ ...input, mode: "synthesis" });
}

async function runSessionOperation(
	input: RunSessionInput & { mode: RunnerPromptMode },
): Promise<RunSessionResult> {
	const startedAt = Date.now();
	let streamedText = "";
	let finalMessage: RunnerMessage | undefined;
	let unsubscribe = () => {};
	let abortListener: (() => void) | undefined;

	try {
		unsubscribe = input.session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				streamedText += event.assistantMessageEvent.delta;
				input.onTextDelta?.({
					delta: event.assistantMessageEvent.delta,
					streamedText,
				});
			}
			if (event.type === "message_end" && event.message?.role === "assistant") {
				finalMessage = event.message;
			}
		});

		if (input.signal) {
			if (input.signal.aborted) {
				await input.session.abort();
				throw new Error("Session run aborted before start.");
			}
			abortListener = () => {
				void input.session.abort();
			};
			input.signal.addEventListener("abort", abortListener, { once: true });
		}

		await input.session.prompt(input.prompt, input.mode);

		const resolvedMessage = finalMessage ?? findLastAssistantMessage(input.session.messages);
		const text = streamedText.trim() || extractLastAssistantText(input.session.messages);
		const stopReason = resolvedMessage?.stopReason ?? "stop";
		if (stopReason !== "stop") {
			throw new Error(`Session run failed with stop reason ${stopReason}.`);
		}

		return {
			text,
			streamedText: streamedText.trim(),
			tokens: {
				input: resolvedMessage?.usage?.input ?? 0,
				output: resolvedMessage?.usage?.output ?? 0,
			},
			stopReason,
			durationMs: Date.now() - startedAt,
		};
	} finally {
		unsubscribe();
		if (input.signal && abortListener) {
			input.signal.removeEventListener("abort", abortListener);
		}
	}
}

function findLastAssistantMessage(messages: ReadonlyArray<RunnerMessage>): RunnerMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "assistant") {
			return message;
		}
	}
	return undefined;
}
