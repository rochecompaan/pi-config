import assert from "node:assert/strict";
import test from "node:test";
import {
	registerHandoffExtension,
	resolveGenerationAuth,
	type HandoffDependencies,
} from "../../extensions/handoff.ts";

type CommandHandler = (args: string, ctx: any) => Promise<void>;
type EventHandler = (event: any, ctx: any) => Promise<void> | void;

function createHarness(
	overrides: Partial<HandoffDependencies> = {},
	harnessOptions: { sendError?: Error } = {},
) {
	let commandHandler: CommandHandler | undefined;
	const events = new Map<string, EventHandler>();
	const sentMessages: Array<{ content: string; options: unknown }> = [];
	const dependencies: HandoffDependencies = {
		generatePrompt: async () => "generated prompt",
		loadSettings: async () => ({ globalSettings: {}, projectTrusted: false }),
		showAutoCountdown: async () => true,
		...overrides,
	};
	const pi = {
		registerCommand(name: string, command: { handler: CommandHandler }) {
			assert.equal(name, "handoff");
			commandHandler = command.handler;
		},
		on(name: string, handler: EventHandler) {
			events.set(name, handler);
		},
		sendUserMessage(content: string, options: unknown) {
			if (harnessOptions.sendError) throw harnessOptions.sendError;
			sentMessages.push({ content, options });
		},
	};
	registerHandoffExtension(pi as any, dependencies);
	assert.ok(commandHandler);
	return { commandHandler, events, sentMessages };
}

function createCommandContext(options: {
	usageTokens?: number | null;
	editedPrompt?: string;
	newSessionCancelled?: boolean;
} = {}) {
	const notices: Array<{ message: string; level: string }> = [];
	const replacementEditor: string[] = [];
	const replacementUserMessages: string[] = [];
	const sessionOptions: any[] = [];
	let manualEditorCalls = 0;
	const replacementCtx = {
		ui: {
			setEditorText(text: string) { replacementEditor.push(text); },
			notify(message: string, level: string) { notices.push({ message, level }); },
		},
		async sendUserMessage(content: string) { replacementUserMessages.push(content); },
	};
	const ctx: any = {
		mode: "tui",
		hasUI: true,
		model: { provider: "test", id: "model" },
		modelRegistry: {},
		cwd: "/project",
		isIdle: () => true,
		isProjectTrusted: () => false,
		getContextUsage: () => options.usageTokens === undefined ? undefined : { tokens: options.usageTokens },
		sessionManager: {
			getBranch: () => [{ type: "message", message: { role: "user", content: "current task" } }],
			getSessionFile: () => "/sessions/old.jsonl",
		},
		ui: {
			notify(message: string, level: string) { notices.push({ message, level }); },
			async editor() {
				manualEditorCalls += 1;
				return options.editedPrompt ?? "edited prompt";
			},
		},
		async newSession(newSessionOptions: any) {
			sessionOptions.push(newSessionOptions);
			if (options.newSessionCancelled) return { cancelled: true };
			await newSessionOptions.withSession(replacementCtx);
			return { cancelled: false };
		},
	};
	return {
		ctx,
		notices,
		replacementEditor,
		replacementUserMessages,
		sessionOptions,
		getManualEditorCalls: () => manualEditorCalls,
	};
}

test("manual handoff still requires a goal", async () => {
	const harness = createHarness();
	const command = createCommandContext();
	await harness.commandHandler("", command.ctx);
	assert.match(command.notices.at(-1)?.message ?? "", /Usage: \/handoff <goal/);
	assert.equal(command.sessionOptions.length, 0);
});

test("manual handoff reviews the generated prompt before staging the edit", async () => {
	let receivedGoal = "";
	const harness = createHarness({
		generatePrompt: async ({ goal }) => {
			receivedGoal = goal;
			return "generated prompt";
		},
	});
	const command = createCommandContext({ editedPrompt: "reviewed prompt" });
	await harness.commandHandler("continue phase one", command.ctx);

	assert.equal(receivedGoal, "continue phase one");
	assert.equal(command.getManualEditorCalls(), 1);
	assert.equal(command.sessionOptions[0].parentSession, "/sessions/old.jsonl");
	assert.deepEqual(command.replacementEditor, ["reviewed prompt"]);
	assert.deepEqual(command.replacementUserMessages, []);
	assert.deepEqual(harness.sentMessages, []);
});

test("manual editor cancellation keeps the current session", async () => {
	const harness = createHarness();
	const command = createCommandContext();
	command.ctx.ui.editor = async () => undefined;
	await harness.commandHandler("continue phase one", command.ctx);
	assert.equal(command.sessionOptions.length, 0);
	assert.equal(command.notices.at(-1)?.message, "Cancelled");
});

test("manual session cancellation keeps the current session", async () => {
	const harness = createHarness();
	const command = createCommandContext({ newSessionCancelled: true });
	await harness.commandHandler("continue phase one", command.ctx);
	assert.equal(command.notices.at(-1)?.message, "New session cancelled");
});

test("settled usage at the threshold dispatches one internal command", async () => {
	const harness = createHarness({
		loadSettings: async () => ({
			globalSettings: { handoff: { autoThresholdTokens: 100 } },
			projectTrusted: false,
		}),
	});
	const command = createCommandContext({ usageTokens: 100 });
	await harness.events.get("session_start")?.({}, command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);
	assert.deepEqual(harness.sentMessages, [{
		content: "/handoff --auto",
		options: { expandPromptTemplates: true },
	}]);
});

test("settled trigger ignores unavailable, low, busy, and non-TUI usage", async () => {
	for (const change of [
		{ usageTokens: undefined },
		{ usageTokens: 99 },
		{ usageTokens: 100, idle: false },
		{ usageTokens: 100, mode: "print" },
	]) {
		const harness = createHarness({
			loadSettings: async () => ({
				globalSettings: { handoff: { autoThresholdTokens: 100 } },
				projectTrusted: false,
			}),
		});
		const command = createCommandContext({ usageTokens: change.usageTokens });
		if (change.idle === false) command.ctx.isIdle = () => false;
		if (change.mode) command.ctx.mode = change.mode;
		await harness.events.get("session_start")?.({}, command.ctx);
		await harness.events.get("agent_settled")?.({}, command.ctx);
		assert.deepEqual(harness.sentMessages, []);
	}
});

test("dispatch errors disable automatic handoff", async () => {
	const harness = createHarness({
		loadSettings: async () => ({
			globalSettings: { handoff: { autoThresholdTokens: 100 } },
			projectTrusted: false,
		}),
	}, { sendError: new Error("dispatch failed") });
	const command = createCommandContext({ usageTokens: 100 });
	await harness.events.get("session_start")?.({}, command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.commandHandler("auto status", command.ctx);
	assert.deepEqual(harness.sentMessages, []);
	assert.match(command.notices.at(-1)?.message ?? "", /disabled/);
});

const thresholdSettings: HandoffDependencies["loadSettings"] = async () => ({
	globalSettings: { handoff: { autoThresholdTokens: 100 } },
	projectTrusted: false,
});

test("auto off disables settled dispatch and status reports the threshold", async () => {
	const harness = createHarness({ loadSettings: thresholdSettings });
	const command = createCommandContext({ usageTokens: 100 });
	await harness.events.get("session_start")?.({}, command.ctx);
	await harness.commandHandler("auto off", command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.commandHandler("auto status", command.ctx);
	assert.deepEqual(harness.sentMessages, []);
	assert.match(command.notices.at(-1)?.message ?? "", /disabled/);
	assert.match(command.notices.at(-1)?.message ?? "", /100/);
});

test("auto on rearms below the threshold without dispatch", async () => {
	const harness = createHarness({ loadSettings: thresholdSettings });
	const command = createCommandContext({ usageTokens: 99 });
	await harness.events.get("session_start")?.({}, command.ctx);
	await harness.commandHandler("auto off", command.ctx);
	await harness.commandHandler("auto on", command.ctx);
	await harness.commandHandler("auto status", command.ctx);
	assert.deepEqual(harness.sentMessages, []);
	assert.match(command.notices.at(-1)?.message ?? "", /armed/);
});

test("null usage does not dispatch when settled and rearms auto on", async () => {
	const harness = createHarness({ loadSettings: thresholdSettings });
	const command = createCommandContext({ usageTokens: null });
	await harness.events.get("session_start")?.({}, command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.commandHandler("auto off", command.ctx);
	await harness.commandHandler("auto on", command.ctx);
	await harness.commandHandler("auto status", command.ctx);
	assert.deepEqual(harness.sentMessages, []);
	assert.match(command.notices.at(-1)?.message ?? "", /armed/);
});

test("auto on dispatches immediately at the threshold", async () => {
	const harness = createHarness({ loadSettings: thresholdSettings });
	const command = createCommandContext({ usageTokens: 100 });
	await harness.events.get("session_start")?.({}, command.ctx);
	await harness.commandHandler("auto off", command.ctx);
	await harness.commandHandler("auto on", command.ctx);
	assert.deepEqual(harness.sentMessages, [{
		content: "/handoff --auto",
		options: { expandPromptTemplates: true },
	}]);
});

test("session start resets disabled automatic state", async () => {
	const harness = createHarness({ loadSettings: thresholdSettings });
	const command = createCommandContext({ usageTokens: 99 });
	await harness.events.get("session_start")?.({}, command.ctx);
	await harness.commandHandler("auto off", command.ctx);
	await harness.events.get("session_start")?.({}, command.ctx);
	await harness.commandHandler("auto status", command.ctx);
	assert.match(command.notices.at(-1)?.message ?? "", /armed/);
});

test("automatic countdown cancellation disables later attempts", async () => {
	const harness = createHarness({ showAutoCountdown: async () => false });
	const command = createCommandContext({ usageTokens: 150_000 });
	await harness.events.get("session_start")?.({}, command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.commandHandler("--auto", command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);
	assert.equal(command.sessionOptions.length, 0);
	assert.equal(harness.sentMessages.length, 1);
	await harness.commandHandler("auto status", command.ctx);
	assert.match(command.notices.at(-1)?.message ?? "", /disabled/);
});

test("automatic countdown errors disable later attempts", async () => {
	const harness = createHarness({
		showAutoCountdown: async () => { throw new Error("countdown failed"); },
	});
	const command = createCommandContext({ usageTokens: 150_000 });
	await harness.events.get("session_start")?.({}, command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);
	await assert.doesNotReject(() => harness.commandHandler("--auto", command.ctx));
	assert.equal(command.notices.at(-1)?.level, "error");
	assert.match(command.notices.at(-1)?.message ?? "", /countdown failed/);
	await harness.commandHandler("auto status", command.ctx);
	assert.match(command.notices.at(-1)?.message ?? "", /disabled/);
	await harness.events.get("agent_settled")?.({}, command.ctx);
	assert.equal(harness.sentMessages.length, 1);
});

test("automatic countdown completion skips the manual editor and submits the generated prompt", async () => {
	const harness = createHarness({ showAutoCountdown: async () => true });
	const command = createCommandContext({ usageTokens: 150_000 });
	await harness.events.get("session_start")?.({}, command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.commandHandler("--auto", command.ctx);
	assert.equal(command.getManualEditorCalls(), 0);
	assert.deepEqual(command.replacementEditor, []);
	assert.deepEqual(command.replacementUserMessages, ["generated prompt"]);
});

test("automatic replacement records the parent and continues without Enter", async () => {
	const harness = createHarness({ showAutoCountdown: async () => true });
	const command = createCommandContext({ usageTokens: 150_000 });
	await harness.events.get("session_start")?.({}, command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.commandHandler("--auto", command.ctx);
	assert.equal(command.sessionOptions[0].parentSession, "/sessions/old.jsonl");
	assert.deepEqual(command.replacementEditor, []);
	assert.deepEqual(command.replacementUserMessages, ["generated prompt"]);
	assert.deepEqual(harness.sentMessages, [{
		content: "/handoff --auto",
		options: { expandPromptTemplates: true },
	}]);
	assert.equal(command.getManualEditorCalls(), 0);
});

test("successful replacement uses only replacementCtx", async () => {
	const harness = createHarness({ showAutoCountdown: async () => true });
	const command = createCommandContext({ usageTokens: 150_000 });
	let oldContextStale = false;
	command.ctx.ui.notify = (message: string, level: string) => {
		if (oldContextStale) throw new Error("old context used after replacement");
		command.notices.push({ message, level });
	};
	command.ctx.newSession = async (newSessionOptions: any) => {
		command.sessionOptions.push(newSessionOptions);
		oldContextStale = true;
		await newSessionOptions.withSession({
			ui: {
				setEditorText(text: string) { command.replacementEditor.push(text); },
				notify(message: string, level: string) {
					command.notices.push({ message, level });
				},
			},
			async sendUserMessage(content: string) {
				command.replacementUserMessages.push(content);
			},
		});
		return { cancelled: false };
	};
	await harness.events.get("session_start")?.({}, command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);
	await assert.doesNotReject(() => harness.commandHandler("--auto", command.ctx));
	assert.deepEqual(command.replacementEditor, []);
	assert.deepEqual(command.replacementUserMessages, ["generated prompt"]);
});

test("automatic submission failure stays on the replacement context and preserves the prompt", async () => {
	const harness = createHarness({ showAutoCountdown: async () => true });
	const command = createCommandContext({ usageTokens: 150_000 });
	let oldContextStale = false;
	let signalSendStarted: () => void = () => {};
	let rejectSubmission: (reason?: unknown) => void = () => {};
	const sendStarted = new Promise<void>((resolve) => { signalSendStarted = resolve; });
	const submission = new Promise<void>((_resolve, reject) => { rejectSubmission = reject; });
	command.ctx.ui.notify = () => {
		if (oldContextStale) throw new Error("stale old context accessed");
	};
	command.ctx.newSession = async (newSessionOptions: any) => {
		command.sessionOptions.push(newSessionOptions);
		oldContextStale = true;
		await newSessionOptions.withSession({
			ui: {
				setEditorText(text: string) { command.replacementEditor.push(text); },
				notify(message: string, level: string) {
					command.notices.push({ message, level });
				},
			},
			sendUserMessage() {
				signalSendStarted();
				return submission;
			},
		});
		return { cancelled: false };
	};
	await harness.events.get("session_start")?.({}, command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);
	let handlerSettled = false;
	const handoff = harness.commandHandler("--auto", command.ctx);
	void handoff.then(
		() => { handlerSettled = true; },
		() => { handlerSettled = true; },
	);
	const noRejection = assert.doesNotReject(handoff);
	await sendStarted;
	assert.equal(handlerSettled, false);
	rejectSubmission(new Error("submission failed"));
	await noRejection;
	assert.deepEqual(command.replacementEditor, ["generated prompt"]);
	assert.match(command.notices.at(-1)?.message ?? "", /submission failed/);
	assert.equal(command.notices.at(-1)?.level, "error");
});

const automaticErrorCases: Array<{
	name: string;
	dependencies?: Partial<HandoffDependencies>;
	contextOptions?: Parameters<typeof createCommandContext>[0];
	prepare?: (ctx: any) => void;
}> = [
	{
		name: "no selected model",
		prepare: (ctx) => { ctx.model = undefined; },
	},
	{
		name: "no handoff messages",
		prepare: (ctx) => { ctx.sessionManager.getBranch = () => []; },
	},
	{
		name: "prompt generation throws",
		dependencies: { generatePrompt: async () => { throw new Error("generation failed"); } },
	},
	{
		name: "prompt generation is cancelled",
		dependencies: { generatePrompt: async () => null },
	},
	{
		name: "prompt generation is empty",
		dependencies: { generatePrompt: async () => "  \n" },
	},
	{
		name: "session switch is cancelled",
		contextOptions: { newSessionCancelled: true },
	},
	{
		name: "session switch throws",
		prepare: (ctx) => {
			ctx.newSession = async () => { throw new Error("switch failed"); };
		},
	},
];

for (const scenario of automaticErrorCases) {
	test(`automatic failure disables retries: ${scenario.name}`, async () => {
		const harness = createHarness({
			showAutoCountdown: async () => true,
			...scenario.dependencies,
		});
		const command = createCommandContext({
			usageTokens: 150_000,
			...scenario.contextOptions,
		});
		scenario.prepare?.(command.ctx);
		await harness.events.get("session_start")?.({}, command.ctx);
		await harness.events.get("agent_settled")?.({}, command.ctx);
		await harness.commandHandler("--auto", command.ctx);
		await harness.commandHandler("auto status", command.ctx);
		assert.match(command.notices.at(-1)?.message ?? "", /disabled/);
		await harness.events.get("agent_settled")?.({}, command.ctx);
		assert.equal(harness.sentMessages.length, 1);
	});
}

function createAuthContext(resolution: unknown) {
	return {
		model: { provider: "kimi-coding", id: "kimi-for-coding" },
		modelRegistry: {
			async getApiKeyAndHeaders() {
				return resolution;
			},
		},
	} as any;
}

test("generation auth accepts headers-only OAuth credentials", async () => {
	const ctx = createAuthContext({
		ok: true,
		headers: { Authorization: "Bearer oauth-token" },
		env: { KIMI_ENV: "value" },
	});
	const auth = await resolveGenerationAuth(ctx);
	assert.equal(auth.apiKey, undefined);
	assert.deepEqual(auth.headers, { Authorization: "Bearer oauth-token" });
	assert.deepEqual(auth.env, { KIMI_ENV: "value" });
});

test("generation auth passes through API key credentials", async () => {
	const ctx = createAuthContext({ ok: true, apiKey: "sk-test", headers: undefined });
	const auth = await resolveGenerationAuth(ctx);
	assert.equal(auth.apiKey, "sk-test");
});

test("generation auth surfaces registry errors", async () => {
	const ctx = createAuthContext({ ok: false, error: "token refresh failed" });
	await assert.rejects(() => resolveGenerationAuth(ctx), /token refresh failed/);
});

test("generation auth rejects when no credentials resolve", async () => {
	const ctx = createAuthContext({ ok: true });
	await assert.rejects(() => resolveGenerationAuth(ctx), /No API key for kimi-coding/);
});
