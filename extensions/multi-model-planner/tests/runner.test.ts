import test from "node:test";
import assert from "node:assert/strict";
import {
	createManagedSession,
	disposeManagedSessions,
	extractLastAssistantText,
	runDraft,
	runDiscussion,
	runSynthesis,
	type RunnerMessage,
	type RunnerPromptMode,
	type RunnerSession,
	type RunnerSessionEvent,
} from "../runner.ts";

class FakeSession implements RunnerSession {
	messages: RunnerMessage[] = [];
	promptCalls: Array<{ text: string; mode?: RunnerPromptMode }> = [];
	disposeCalls = 0;
	abortCalls = 0;
	listeners: Array<(event: RunnerSessionEvent) => void> = [];
	onPrompt?: () => Promise<void>;

	subscribe(listener: (event: RunnerSessionEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((entry) => entry !== listener);
		};
	}

	async prompt(text: string, mode?: RunnerPromptMode): Promise<void> {
		this.promptCalls.push({ text, mode });
		await this.onPrompt?.();
	}

	dispose(): void {
		this.disposeCalls += 1;
	}

	async abort(): Promise<void> {
		this.abortCalls += 1;
	}

	emit(event: RunnerSessionEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

test("extractLastAssistantText returns the latest assistant text content", () => {
	const messages: RunnerMessage[] = [
		{ role: "user", content: [{ type: "text", text: "hello" }] },
		{ role: "assistant", content: [{ type: "text", text: "first" }] },
		{ role: "assistant", content: [{ type: "text", text: "second" }] },
	];

	assert.equal(extractLastAssistantText(messages), "second");
});

test("runDraft captures streamed text final output usage and duration", async () => {
	const session = new FakeSession();
	session.onPrompt = async () => {
		session.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "Hello " },
		});
		session.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "world" },
		});
		const finalMessage: RunnerMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Hello world" }],
			usage: { input: 12, output: 34 },
			stopReason: "stop",
		};
		session.messages.push(finalMessage);
		session.emit({ type: "message_end", message: finalMessage });
		session.emit({ type: "agent_end" });
	};

	const result = await runDraft({ session, prompt: "Draft prompt" });
	assert.deepEqual(session.promptCalls[0], { text: "Draft prompt", mode: "draft" });
	assert.equal(result.text, "Hello world");
	assert.equal(result.streamedText, "Hello world");
	assert.deepEqual(result.tokens, { input: 12, output: 34 });
	assert.equal(result.stopReason, "stop");
	assert.ok(result.durationMs >= 0);
});

test("runDraft forwards text deltas to the caller with accumulated streamed text", async () => {
	const session = new FakeSession();
	const deltas: Array<{ delta: string; streamedText: string }> = [];
	session.onPrompt = async () => {
		session.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "Alpha" },
		});
		session.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: " Beta" },
		});
		const finalMessage: RunnerMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Alpha Beta" }],
			usage: { input: 1, output: 2 },
			stopReason: "stop",
		};
		session.messages.push(finalMessage);
		session.emit({ type: "message_end", message: finalMessage });
	};

	await runDraft({
		session,
		prompt: "Draft prompt",
		onTextDelta: (update) => deltas.push(update),
	});

	assert.deepEqual(deltas, [
		{ delta: "Alpha", streamedText: "Alpha" },
		{ delta: " Beta", streamedText: "Alpha Beta" },
	]);
});

test("runDiscussion uses session.prompt in discussion mode and falls back to session messages when streaming deltas are incomplete", async () => {
	const session = new FakeSession();
	session.onPrompt = async () => {
		const finalMessage: RunnerMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Recovered from messages" }],
			usage: { input: 2, output: 3 },
			stopReason: "stop",
		};
		session.messages.push(finalMessage);
		session.emit({ type: "message_end", message: finalMessage });
	};

	const result = await runDiscussion({ session, prompt: "Discussion prompt" });
	assert.deepEqual(session.promptCalls[0], { text: "Discussion prompt", mode: "discussion" });
	assert.equal(result.text, "Recovered from messages");
	assert.equal(result.streamedText, "");
	assert.deepEqual(result.tokens, { input: 2, output: 3 });
});

test("runDiscussion does not reuse stale assistant output from the previous phase when the session is idle", async () => {
	const session = new FakeSession();
	session.messages.push({
		role: "assistant",
		content: [{ type: "text", text: "Draft response that must not be reused" }],
		usage: { input: 5, output: 7 },
		stopReason: "stop",
	});
	session.onPrompt = async () => {
		const finalMessage: RunnerMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Fresh discussion response" }],
			usage: { input: 11, output: 13 },
			stopReason: "stop",
		};
		session.messages.push(finalMessage);
		session.emit({ type: "message_end", message: finalMessage });
	};

	const result = await runDiscussion({ session, prompt: "Round 1 prompt" });
	assert.deepEqual(session.promptCalls[0], { text: "Round 1 prompt", mode: "discussion" });
	assert.equal(result.text, "Fresh discussion response");
	assert.notEqual(result.text, "Draft response that must not be reused");
	assert.deepEqual(result.tokens, { input: 11, output: 13 });
});

test("runSynthesis propagates stopReason failures as errors", async () => {
	const session = new FakeSession();
	session.onPrompt = async () => {
		const finalMessage: RunnerMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			usage: { input: 1, output: 0 },
			stopReason: "error",
		};
		session.messages.push(finalMessage);
		session.emit({ type: "message_end", message: finalMessage });
	};

	await assert.rejects(() => runSynthesis({ session, prompt: "Synthesis prompt" }), /stop reason error/i);
	assert.deepEqual(session.promptCalls[0], { text: "Synthesis prompt", mode: "synthesis" });
});

test("runDraft triggers session abort when AbortSignal fires", async () => {
	const session = new FakeSession();
	const controller = new AbortController();
	session.onPrompt = async () => {
		controller.abort();
		await Promise.resolve();
		const finalMessage: RunnerMessage = {
			role: "assistant",
			content: [{ type: "text", text: "aborted output" }],
			usage: { input: 1, output: 1 },
			stopReason: "aborted",
		};
		session.messages.push(finalMessage);
		session.emit({ type: "message_end", message: finalMessage });
	};

	await assert.rejects(
		() => runDraft({ session, prompt: "Draft prompt", signal: controller.signal }),
		/aborted/i,
	);
	assert.equal(session.abortCalls, 1);
});

test("createManagedSession and disposeManagedSessions centralize lifecycle cleanup", async () => {
	const sessionA = new FakeSession();
	const sessionB = new FakeSession();
	const managedA = await createManagedSession({
		memberName: "claude",
		model: "anthropic/claude-opus-4.6",
		createSession: async () => sessionA,
	});
	const managedB = await createManagedSession({
		memberName: "codex",
		model: "openai/gpt-5.4",
		createSession: async () => sessionB,
	});

	assert.equal(managedA.memberName, "claude");
	assert.equal(managedB.model, "openai/gpt-5.4");

	await disposeManagedSessions([managedA, managedB]);
	assert.equal(sessionA.disposeCalls, 1);
	assert.equal(sessionB.disposeCalls, 1);
});
