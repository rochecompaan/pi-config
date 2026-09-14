import assert from "node:assert/strict";
import test from "node:test";
import retainNewSessionModel, {
	HANDOFF_ENTRY_TYPE,
	selectNewestHandoff,
} from "./index.ts";

type EventHandler = (event: any, ctx: any) => unknown;

class FakePi {
	readonly appendedEntries: Array<{ customType: string; data: unknown }> = [];
	readonly calls: Array<
		| { kind: "model"; value: unknown }
		| { kind: "thinking"; value: string }
	> = [];
	readonly handlers = new Map<string, EventHandler[]>();
	setModelOutcome: boolean | Error = true;

	on(event: string, handler: EventHandler): void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
	}

	appendEntry(customType: string, data: unknown): void {
		this.appendedEntries.push({ customType, data });
	}

	async setModel(model: unknown): Promise<boolean> {
		this.calls.push({ kind: "model", value: model });
		if (this.setModelOutcome instanceof Error) throw this.setModelOutcome;
		return this.setModelOutcome;
	}

	setThinkingLevel(level: string): void {
		this.calls.push({ kind: "thinking", value: level });
	}

	async emit(event: string, payload: unknown, ctx: unknown): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) {
			await handler(payload, ctx);
		}
	}
}

const handoffEntry = (data: unknown, customType = HANDOFF_ENTRY_TYPE) => ({
	type: "custom",
	customType,
	data,
});

type TestModel = { provider: string; id: string };

function createContext(models: readonly TestModel[] = []) {
	const notifications: Array<{ message: string; level: string }> = [];
	return {
		notifications,
		context: {
			hasUI: true,
			ui: {
				notify(message: string, level: string): void {
					notifications.push({ message, level });
				},
			},
			model: { provider: "openai-codex", id: "gpt-5.4" },
			thinkingLevel: "medium",
			modelRegistry: {
				find(provider: string, id: string): TestModel | undefined {
					return models.find((model) => model.provider === provider && model.id === id);
				},
			},
		},
	};
}

const validHandoff = (overrides: Partial<{
	provider: string;
	modelId: string;
	thinkingLevel: string;
}> = {}) => handoffEntry({
	version: 1,
	provider: overrides.provider ?? "anthropic",
	modelId: overrides.modelId ?? "claude-opus-4-6",
	thinkingLevel: overrides.thinkingLevel ?? "high",
});

test("captures the exact runtime choice only before a new-session switch", async () => {
	const pi = new FakePi();
	retainNewSessionModel(pi as any);
	const ctx = {
		model: { provider: "openai-codex", id: "gpt-5.4" },
		thinkingLevel: "xhigh",
	};

	await pi.emit("session_before_switch", { reason: "resume" }, ctx);
	await pi.emit("session_before_switch", { reason: "new" }, ctx);

	assert.deepEqual(pi.appendedEntries, [
		{
			customType: HANDOFF_ENTRY_TYPE,
			data: {
				version: 1,
				provider: "openai-codex",
				modelId: "gpt-5.4",
				thinkingLevel: "xhigh",
			},
		},
	]);
});

test("does not write an incomplete handoff", async () => {
	const pi = new FakePi();
	retainNewSessionModel(pi as any);

	await pi.emit("session_before_switch", { reason: "new" }, {
		model: undefined,
		thinkingLevel: "high",
	});
	await pi.emit("session_before_switch", { reason: "new" }, {
		model: { provider: "anthropic", id: "claude-opus-4-6" },
		thinkingLevel: undefined,
	});

	assert.deepEqual(pi.appendedEntries, []);
});

test("selects the newest matching handoff entry", () => {
	const selection = selectNewestHandoff([
		handoffEntry({
			version: 1,
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
			thinkingLevel: "low",
		}),
		handoffEntry({ version: 1 }, "another-extension"),
		handoffEntry({
			version: 1,
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "max",
		}),
	]);

	assert.deepEqual(selection, {
		kind: "found",
		choice: {
			version: 1,
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "max",
		},
	});
});

test("rejects the newest malformed or unsupported matching entry", () => {
	const validOlderEntry = handoffEntry({
		version: 1,
		provider: "anthropic",
		modelId: "claude-sonnet-4-5",
		thinkingLevel: "high",
	});

	assert.deepEqual(
		selectNewestHandoff([
			validOlderEntry,
			handoffEntry({
				version: 1,
				provider: "anthropic",
				modelId: "claude-opus-4-6",
				thinkingLevel: "highest",
			}),
		]),
		{ kind: "invalid", reason: "malformed" },
	);
	assert.deepEqual(
		selectNewestHandoff([
			validOlderEntry,
			handoffEntry({
				version: 2,
				provider: "anthropic",
				modelId: "claude-opus-4-6",
				thinkingLevel: "high",
			}),
		]),
		{ kind: "invalid", reason: "unsupported-version" },
	);
	assert.deepEqual(selectNewestHandoff([]), { kind: "missing" });
});

test("restores the newest model before its thinking level and stays silent", async () => {
	const pi = new FakePi();
	const restoredModel = { provider: "anthropic", id: "claude-opus-4-6" };
	const readFiles: string[] = [];

	retainNewSessionModel(
		pi as any,
		{
			readSessionEntries: async (sessionFile) => {
				readFiles.push(sessionFile);
				return [
					validHandoff({ modelId: "claude-sonnet-4-5", thinkingLevel: "low" }),
					validHandoff({ thinkingLevel: "xhigh" }),
				];
			},
		},
	);

	const { context, notifications } = createContext([restoredModel]);
	await pi.emit("session_start", {
		reason: "new",
		previousSessionFile: "/tmp/previous-session.jsonl",
	}, context);
	assert.deepEqual(readFiles, ["/tmp/previous-session.jsonl"]);
	assert.deepEqual(pi.calls, [
		{ kind: "model", value: restoredModel },
		{ kind: "thinking", value: "xhigh" },
	]);
	assert.deepEqual(notifications, []);
});

test("does not read a handoff for other session-start reasons or an unsaved prior session", async () => {
	const pi = new FakePi();
	const readFiles: string[] = [];

	retainNewSessionModel(
		pi as any,
		{
			readSessionEntries: async (sessionFile) => {
				readFiles.push(sessionFile);
				return [validHandoff()];
			},
		},
	);
	const { context } = createContext([{ provider: "anthropic", id: "claude-opus-4-6" }]);

	for (const reason of ["startup", "reload", "resume", "fork"] as const) {
		await pi.emit(
			"session_start",
			{
				reason,
				previousSessionFile: "/tmp/previous-session.jsonl",
			},
			context,
		);
	}
	await pi.emit("session_start", { reason: "new" }, context);
	assert.deepEqual(readFiles, []);
	assert.deepEqual(pi.calls, []);
});

test("keeps replacement defaults when the previous session has no handoff", async () => {
	const pi = new FakePi();

	retainNewSessionModel(pi as any, {
		readSessionEntries: async () => [handoffEntry({ version: 1 }, "another-extension")],
	});
	const { context, notifications } = createContext();
	await pi.emit("session_start", {
		reason: "new",
		previousSessionFile: "/tmp/previous-session.jsonl",
	}, context);
	assert.deepEqual(pi.calls, []);
	assert.deepEqual(notifications, []);
});

test("warns for malformed and unsupported handoffs without changing defaults", async () => {
	const cases = [
		{
			entry: handoffEntry({
				version: 1,
				provider: "anthropic",
				modelId: "claude-opus-4-6",
				thinkingLevel: "highest",
			}),
			message: "[retain-new-session-model] Ignored malformed /new runtime handoff; using replacement-session defaults.",
		},
		{
			entry: handoffEntry({
				version: 2,
				provider: "anthropic",
				modelId: "claude-opus-4-6",
				thinkingLevel: "high",
			}),
			message: "[retain-new-session-model] Ignored unsupported /new runtime handoff version; using replacement-session defaults.",
		},
	] as const;

	for (const item of cases) {
		const pi = new FakePi();
		retainNewSessionModel(pi as any, {
			readSessionEntries: async () => [item.entry],
		});
		const { context, notifications } = createContext();

		await pi.emit("session_start", {
			reason: "new",
			previousSessionFile: "/tmp/previous-session.jsonl",
		}, context);

		assert.deepEqual(pi.calls, []);
		assert.deepEqual(notifications, [
			{ message: item.message, level: "warning" },
		]);
	}
});

test("warns and keeps defaults when the retained model is unavailable", async () => {
	const pi = new FakePi();
	retainNewSessionModel(pi as any, {
		readSessionEntries: async () => [validHandoff()],
	});
	const { context, notifications } = createContext();

	await pi.emit("session_start", {
		reason: "new",
		previousSessionFile: "/tmp/previous-session.jsonl",
	}, context);

	assert.deepEqual(pi.calls, []);
	assert.deepEqual(notifications, [
		{
			message: "[retain-new-session-model] The retained model is unavailable; using replacement-session defaults.",
			level: "warning",
		},
	]);
});

test("warns and skips thinking restoration when authentication is unavailable", async () => {
	const pi = new FakePi();
	pi.setModelOutcome = false;
	const restoredModel = { provider: "anthropic", id: "claude-opus-4-6" };
	retainNewSessionModel(pi as any, {
		readSessionEntries: async () => [validHandoff({ thinkingLevel: "max" })],
	});
	const { context, notifications } = createContext([restoredModel]);

	await pi.emit("session_start", {
		reason: "new",
		previousSessionFile: "/tmp/previous-session.jsonl",
	}, context);

	assert.deepEqual(pi.calls, [{ kind: "model", value: restoredModel }]);
	assert.deepEqual(notifications, [
		{
			message: "[retain-new-session-model] Pi could not authenticate the retained model; using replacement-session defaults.",
			level: "warning",
		},
	]);
});

test("does not expose a session read error in its warning", async () => {
	const pi = new FakePi();
	retainNewSessionModel(pi as any, {
		readSessionEntries: async () => {
			throw new Error("session contained credential sk-secret");
		},
	});
	const { context, notifications } = createContext();

	await pi.emit("session_start", {
		reason: "new",
		previousSessionFile: "/tmp/previous-session.jsonl",
	}, context);

	assert.deepEqual(pi.calls, []);
	assert.deepEqual(notifications, [
		{
			message: "[retain-new-session-model] Could not read the previous session; using replacement-session defaults.",
			level: "warning",
		},
	]);
	assert.doesNotMatch(notifications[0].message, /sk-secret/);
});

test("does not expose a model activation error or apply thinking to the fallback model", async () => {
	const pi = new FakePi();
	pi.setModelOutcome = new Error("provider returned credential sk-secret");
	const restoredModel = { provider: "anthropic", id: "claude-opus-4-6" };
	retainNewSessionModel(pi as any, {
		readSessionEntries: async () => [validHandoff({ thinkingLevel: "max" })],
	});
	const { context, notifications } = createContext([restoredModel]);

	await pi.emit("session_start", {
		reason: "new",
		previousSessionFile: "/tmp/previous-session.jsonl",
	}, context);

	assert.deepEqual(pi.calls, [{ kind: "model", value: restoredModel }]);
	assert.deepEqual(notifications, [
		{
			message: "[retain-new-session-model] Pi could not restore the retained model; using replacement-session defaults.",
			level: "warning",
		},
	]);
	assert.doesNotMatch(notifications[0].message, /sk-secret/);
});
