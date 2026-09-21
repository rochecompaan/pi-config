import assert from "node:assert/strict";
import test from "node:test";
import {
	registerHandoffExtension,
	type HandoffDependencies,
} from "../../extensions/handoff.ts";

type CommandHandler = (args: string, ctx: any) => Promise<void>;
type EventHandler = (event: any, ctx: any) => Promise<void> | void;

function createHarness(
	overrides: Partial<HandoffDependencies> = {},
	harnessOptions: { sendError?: Error; sendErrorFor?: string; customSendError?: Error } = {},
) {
	let commandHandler: CommandHandler | undefined;
	const events = new Map<string, EventHandler>();
	const sentMessages: Array<{ content: string; options: unknown }> = [];
	const customMessages: Array<{ message: unknown; options: unknown }> = [];
	const dependencies: HandoffDependencies = {
		generatePrompt: async () => ({ action: "continue", prompt: "generated prompt" }),
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
			if (
				harnessOptions.sendError &&
				(!harnessOptions.sendErrorFor || harnessOptions.sendErrorFor === content)
			) throw harnessOptions.sendError;
			sentMessages.push({ content, options });
		},
		sendMessage(message: unknown, options: unknown) {
			if (harnessOptions.customSendError) throw harnessOptions.customSendError;
			customMessages.push({ message, options });
		},
	};
	registerHandoffExtension(pi as any, dependencies);
	assert.ok(commandHandler);
	return { commandHandler, events, sentMessages, customMessages };
}

function createCommandContext(options: {
	usageTokens?: number | null;
	editedPrompt?: string;
	newSessionCancelled?: boolean;
	branch?: any[];
} = {}) {
	const branch = options.branch ?? [
		{ type: "message", id: "source-user", message: { role: "user", content: "current task" } },
	];
	const notices: Array<{ message: string; level: string }> = [];
	const replacementEditor: string[] = [];
	const replacementMessages: Array<{ message: unknown; options: unknown }> = [];
	const replacementUserMessages: string[] = [];
	const replacementDelivery: string[] = [];
	const sessionOptions: any[] = [];
	let manualEditorCalls = 0;
	const replacementCtx = {
		ui: {
			setEditorText(text: string) { replacementEditor.push(text); },
			notify(message: string, level: string) { notices.push({ message, level }); },
		},
		async sendMessage(message: unknown, sendOptions: unknown) {
			replacementDelivery.push((message as any).customType);
			replacementMessages.push({ message, options: sendOptions });
		},
		async sendUserMessage(content: string) {
			replacementDelivery.push("user");
			replacementUserMessages.push(content);
		},
	};
	const ctx: any = {
		mode: "tui",
		hasUI: true,
		model: { provider: "test", id: "model" },
		modelRegistry: {},
		cwd: "/project",
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => false,
		getContextUsage: () => options.usageTokens === undefined ? undefined : { tokens: options.usageTokens },
		sessionManager: {
			getBranch: () => branch,
			getLeafId: () => branch.at(-1)?.id,
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
		branch,
		notices,
		replacementEditor,
		replacementMessages,
		replacementUserMessages,
		replacementDelivery,
		replacementCtx,
		sessionOptions,
		getManualEditorCalls: () => manualEditorCalls,
	};
}

async function beginAutomaticHandoff(
	harness: ReturnType<typeof createHarness>,
	command: ReturnType<typeof createCommandContext>,
): Promise<void> {
	await harness.events.get("session_start")?.({}, command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.commandHandler("--auto", command.ctx);
}

async function finalizeAutomaticHandoff(
	harness: ReturnType<typeof createHarness>,
	command: ReturnType<typeof createCommandContext>,
	preparationContent = "No continuity todo was warranted.",
): Promise<void> {
	command.branch.push({
		type: "message",
		id: `preparation-assistant-${command.branch.length}`,
		message: { role: "assistant", content: preparationContent },
	});
	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.commandHandler("--auto-finalize", command.ctx);
}

test("manual handoff still requires a goal", async () => {
	const harness = createHarness();
	const command = createCommandContext();
	await harness.commandHandler("", command.ctx);
	assert.match(command.notices.at(-1)?.message ?? "", /Usage: \/handoff <goal/);
	assert.equal(command.sessionOptions.length, 0);
});

test("manual handoff reviews the generated prompt before staging the edit", async () => {
	let receivedIntent: unknown;
	const harness = createHarness({
		generatePrompt: async ({ intent }) => {
			receivedIntent = intent;
			return { action: "continue", prompt: "generated prompt" };
		},
	});
	const command = createCommandContext({ editedPrompt: "reviewed prompt" });
	await harness.commandHandler("continue phase one", command.ctx);

	assert.deepEqual(receivedIntent, { kind: "manual", goal: "continue phase one" });
	assert.equal(command.getManualEditorCalls(), 1);
	assert.equal(command.sessionOptions[0].parentSession, "/sessions/old.jsonl");
	assert.deepEqual(command.replacementEditor, ["reviewed prompt"]);
	assert.deepEqual(command.replacementUserMessages, []);
	assert.deepEqual(harness.sentMessages, []);
	assert.deepEqual(harness.customMessages, []);
});

test("manual handoff rejects empty generation before opening the editor", async () => {
	const harness = createHarness({
		generatePrompt: async () => ({ action: "continue", prompt: "  \n" }),
	});
	const command = createCommandContext();

	await harness.commandHandler("continue phase one", command.ctx);

	assert.equal(command.getManualEditorCalls(), 0);
	assert.equal(command.sessionOptions.length, 0);
	assert.equal(command.notices.at(-1)?.level, "error");
	assert.match(command.notices.at(-1)?.message ?? "", /empty prompt/i);
});

test("manual handoff propagates generation errors without opening the editor", async () => {
	const harness = createHarness({
		generatePrompt: async () => {
			throw new Error("Claude session reconstruction failed");
		},
	});
	const command = createCommandContext();

	await assert.rejects(
		harness.commandHandler("continue phase one", command.ctx),
		/Claude session reconstruction failed/,
	);
	assert.equal(command.getManualEditorCalls(), 0);
	assert.equal(command.sessionOptions.length, 0);
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

test("automatic handoff prepares todos before generating the prompt", async () => {
	let generated = false;
	let generationInput: any;
	const harness = createHarness({
		showAutoCountdown: async () => true,
		generatePrompt: async (input: any) => {
			generated = true;
			generationInput = input;
			return { action: "continue", prompt: "generated prompt" };
		},
	});
	const command = createCommandContext({ usageTokens: 150_000 });

	await beginAutomaticHandoff(harness, command);

	assert.equal(generated, false);
	assert.equal(command.sessionOptions.length, 0);
	assert.deepEqual(harness.customMessages.map((entry) => entry.options), [
		{ triggerTurn: true },
	]);
	assert.deepEqual(harness.customMessages.map((entry: any) => entry.message.customType), [
		"handoff-preparation",
	]);

	command.branch.push({
		type: "custom_message",
		id: "preparation-instruction",
		customType: "handoff-preparation",
		content: "internal instruction",
		display: true,
	});
	command.branch.push({
		type: "message",
		id: "preparation-assistant",
		message: { role: "assistant", content: "Updated TODO-a1b2c3d4" },
	});
	await harness.events.get("agent_settled")?.({}, command.ctx);

	assert.equal(generated, false);
	assert.equal(harness.sentMessages.at(-1)?.content, "/handoff --auto-finalize");
	await harness.commandHandler("--auto-finalize", command.ctx);

	assert.equal(generated, true);
	assert.deepEqual(generationInput.messages, [
		{ role: "user", content: "current task" },
	]);
	assert.deepEqual(generationInput.preparationMessages, [
		{ role: "assistant", content: "Updated TODO-a1b2c3d4" },
	]);
	assert.deepEqual(command.replacementUserMessages, ["generated prompt"]);
});

test("preparation settlement waits for a correlated assistant result and finalizes once", async () => {
	const harness = createHarness({ showAutoCountdown: async () => true });
	const command = createCommandContext({ usageTokens: 150_000 });
	await beginAutomaticHandoff(harness, command);

	await harness.events.get("agent_settled")?.({}, command.ctx);
	assert.equal(
		harness.sentMessages.filter((message) => message.content === "/handoff --auto-finalize").length,
		0,
	);

	command.branch.push({
		type: "message",
		id: "preparation-assistant",
		message: { role: "assistant", content: "No continuity todo was warranted." },
	});
	let hasPendingMessages = true;
	command.ctx.hasPendingMessages = () => hasPendingMessages;
	await harness.events.get("agent_settled")?.({}, command.ctx);
	assert.equal(
		harness.sentMessages.filter((message) => message.content === "/handoff --auto-finalize").length,
		0,
	);

	hasPendingMessages = false;
	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);

	assert.equal(
		harness.sentMessages.filter((message) => message.content === "/handoff --auto-finalize").length,
		1,
	);
});

test("a user message during preparation disables stale automatic finalization", async () => {
	const harness = createHarness({ showAutoCountdown: async () => true });
	const command = createCommandContext({ usageTokens: 150_000 });
	await beginAutomaticHandoff(harness, command);
	command.branch.push({
		type: "message",
		id: "intervening-user",
		message: { role: "user", content: "Stop and inspect the parser first." },
	});
	command.branch.push({
		type: "message",
		id: "intervening-assistant",
		message: { role: "assistant", content: "I inspected it." },
	});

	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.commandHandler("auto status", command.ctx);

	assert.match(command.notices.at(-1)?.message ?? "", /disabled/);
	assert.equal(
		harness.sentMessages.filter((message) => message.content === "/handoff --auto-finalize").length,
		0,
	);
});

test("a user message queued after preparation settlement cancels finalization", async () => {
	let generated = false;
	const harness = createHarness({
		showAutoCountdown: async () => true,
		generatePrompt: async () => {
			generated = true;
			return { action: "continue", prompt: "generated prompt" };
		},
	});
	const command = createCommandContext({ usageTokens: 150_000 });
	await beginAutomaticHandoff(harness, command);
	command.branch.push({
		type: "message",
		id: "preparation-assistant",
		message: { role: "assistant", content: "No continuity todo was warranted." },
	});
	await harness.events.get("agent_settled")?.({}, command.ctx);
	command.branch.push({
		type: "message",
		id: "late-user",
		message: { role: "user", content: "Wait, use a different approach." },
	});

	await harness.commandHandler("--auto-finalize", command.ctx);
	await harness.commandHandler("auto status", command.ctx);

	assert.equal(generated, false);
	assert.match(command.notices.at(-1)?.message ?? "", /disabled/);
	assert.equal(command.sessionOptions.length, 0);
});

test("a missing preparation boundary disables automatic finalization", async () => {
	const harness = createHarness({ showAutoCountdown: async () => true });
	const command = createCommandContext({ usageTokens: 150_000 });
	await beginAutomaticHandoff(harness, command);
	command.branch.splice(0, command.branch.length,
		{ type: "message", id: "other-user", message: { role: "user", content: "other branch" } },
		{ type: "message", id: "other-assistant", message: { role: "assistant", content: "other response" } },
	);

	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.commandHandler("auto status", command.ctx);

	assert.match(command.notices.at(-1)?.message ?? "", /disabled/);
	assert.equal(
		harness.sentMessages.filter((message) => message.content === "/handoff --auto-finalize").length,
		0,
	);
});

test("auto off during preparation clears the pending finalization", async () => {
	const harness = createHarness({ showAutoCountdown: async () => true });
	const command = createCommandContext({ usageTokens: 150_000 });
	await beginAutomaticHandoff(harness, command);
	await harness.commandHandler("auto off", command.ctx);
	command.branch.push({
		type: "message",
		id: "late-preparation-assistant",
		message: { role: "assistant", content: "Updated TODO-a1b2c3d4" },
	});

	await harness.events.get("agent_settled")?.({}, command.ctx);

	assert.equal(
		harness.sentMessages.filter((message) => message.content === "/handoff --auto-finalize").length,
		0,
	);
});

test("an aborted preparation turn disables automatic handoff", async () => {
	const harness = createHarness({ showAutoCountdown: async () => true });
	const command = createCommandContext({ usageTokens: 150_000 });
	await beginAutomaticHandoff(harness, command);
	command.branch.push({
		type: "message",
		id: "aborted-preparation-assistant",
		message: {
			role: "assistant",
			content: "Partial preparation",
			stopReason: "aborted",
		},
	});

	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.commandHandler("auto status", command.ctx);

	assert.match(command.notices.at(-1)?.message ?? "", /disabled/);
	assert.equal(
		harness.sentMessages.filter((message) => message.content === "/handoff --auto-finalize").length,
		0,
	);
});

test("automatic finalization proceeds when preparation needs no todo", async () => {
	let receivedPreparation: unknown;
	const harness = createHarness({
		showAutoCountdown: async () => true,
		generatePrompt: async (input: any) => {
			receivedPreparation = input.preparationMessages;
			return { action: "wait", prompt: "completed checkpoint" };
		},
	});
	const command = createCommandContext({ usageTokens: 150_000 });
	await beginAutomaticHandoff(harness, command);

	await finalizeAutomaticHandoff(harness, command);

	assert.deepEqual(receivedPreparation, [
		{ role: "assistant", content: "No continuity todo was warranted." },
	]);
});

test("preparation dispatch failure disables automatic handoff", async () => {
	const harness = createHarness(
		{ showAutoCountdown: async () => true },
		{ customSendError: new Error("preparation send failed") },
	);
	const command = createCommandContext({ usageTokens: 150_000 });
	await beginAutomaticHandoff(harness, command);

	assert.match(command.notices.at(-1)?.message ?? "", /preparation send failed/);
	await harness.commandHandler("auto status", command.ctx);
	assert.match(command.notices.at(-1)?.message ?? "", /disabled/);
	assert.equal(command.sessionOptions.length, 0);
});

test("auto on cannot start a second handoff during preparation or finalization", async () => {
	for (const phase of ["preparing", "finalizing"] as const) {
		const harness = createHarness({ showAutoCountdown: async () => true });
		const command = createCommandContext({ usageTokens: 150_000 });
		await beginAutomaticHandoff(harness, command);
		if (phase === "finalizing") {
			command.branch.push({
				type: "message",
				id: "preparation-assistant",
				message: { role: "assistant", content: "No continuity todo was warranted." },
			});
			await harness.events.get("agent_settled")?.({}, command.ctx);
		}

		await harness.commandHandler("auto on", command.ctx);

		assert.equal(
			harness.sentMessages.filter((message) => message.content === "/handoff --auto").length,
			1,
		);
		assert.equal(harness.customMessages.length, 1);
	}
});

test("automatic finalization dispatch failure disables automatic handoff", async () => {
	const harness = createHarness(
		{ showAutoCountdown: async () => true },
		{
			sendError: new Error("finalization send failed"),
			sendErrorFor: "/handoff --auto-finalize",
		},
	);
	const command = createCommandContext({ usageTokens: 150_000 });
	await beginAutomaticHandoff(harness, command);
	command.branch.push({
		type: "message",
		id: "preparation-assistant",
		message: { role: "assistant", content: "No continuity todo was warranted." },
	});
	await harness.events.get("agent_settled")?.({}, command.ctx);

	assert.match(command.notices.at(-1)?.message ?? "", /finalization send failed/);
	await harness.commandHandler("auto status", command.ctx);
	assert.match(command.notices.at(-1)?.message ?? "", /disabled/);
	assert.equal(command.sessionOptions.length, 0);
});

test("automatic offer asks in the replacement session", async () => {
	const harness = createHarness({
		showAutoCountdown: async () => true,
		generatePrompt: async () => ({
			action: "offer",
			prompt: "Please choose one of the open recommendations.",
		}),
	});
	const command = createCommandContext({ usageTokens: 150_000 });
	await beginAutomaticHandoff(harness, command);
	await finalizeAutomaticHandoff(harness, command);

	assert.deepEqual(command.replacementUserMessages, [
		"Please choose one of the open recommendations.",
	]);
	assert.deepEqual(command.replacementMessages, []);
});

test("automatic countdown completion skips the manual editor and submits the generated prompt", async () => {
	const harness = createHarness({ showAutoCountdown: async () => true });
	const command = createCommandContext({ usageTokens: 150_000 });
	await beginAutomaticHandoff(harness, command);
	await finalizeAutomaticHandoff(harness, command);
	assert.equal(command.getManualEditorCalls(), 0);
	assert.deepEqual(command.replacementEditor, []);
	assert.deepEqual(command.replacementUserMessages, ["generated prompt"]);
});

test("automatic waiting handoff preserves context without starting an agent turn", async () => {
	let receivedIntent: unknown;
	const harness = createHarness({
		generatePrompt: async ({ intent }) => {
			receivedIntent = intent;
			return { action: "wait", prompt: "completed checkpoint" };
		},
	});
	const command = createCommandContext({ usageTokens: 150_000 });
	await beginAutomaticHandoff(harness, command);
	await finalizeAutomaticHandoff(harness, command);

	assert.deepEqual(receivedIntent, { kind: "automatic" });
	assert.deepEqual(command.replacementUserMessages, []);
	assert.deepEqual(command.replacementMessages, [{
		message: {
			customType: "handoff-context",
			content: "completed checkpoint",
			display: true,
		},
		options: { triggerTurn: false },
	}]);
});

test("automatic waiting handoff stages the checkpoint when context injection fails", async () => {
	const harness = createHarness({
		generatePrompt: async () => ({ action: "wait", prompt: "completed checkpoint" }),
	});
	const command = createCommandContext({ usageTokens: 150_000 });
	let oldContextStale = false;
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
			async sendMessage() { throw new Error("injection failed"); },
			async sendUserMessage(content: string) {
				command.replacementUserMessages.push(content);
			},
		});
		return { cancelled: false };
	};

	await beginAutomaticHandoff(harness, command);
	await assert.doesNotReject(() => finalizeAutomaticHandoff(harness, command));

	assert.deepEqual(command.replacementEditor, ["completed checkpoint"]);
	assert.deepEqual(command.replacementUserMessages, []);
	assert.match(command.notices.at(-1)?.message ?? "", /injection failed/);
	assert.equal(command.notices.at(-1)?.level, "error");
});

test("automatic replacement records the parent and continues without Enter", async () => {
	const harness = createHarness({ showAutoCountdown: async () => true });
	const command = createCommandContext({ usageTokens: 150_000 });
	await beginAutomaticHandoff(harness, command);
	await finalizeAutomaticHandoff(harness, command);
	assert.equal(command.sessionOptions[0].parentSession, "/sessions/old.jsonl");
	assert.deepEqual(command.replacementEditor, []);
	assert.deepEqual(command.replacementUserMessages, ["generated prompt"]);
	assert.deepEqual(harness.sentMessages, [
		{
			content: "/handoff --auto",
			options: { expandPromptTemplates: true },
		},
		{
			content: "/handoff --auto-finalize",
			options: { expandPromptTemplates: true },
		},
	]);
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
	await beginAutomaticHandoff(harness, command);
	await assert.doesNotReject(() => finalizeAutomaticHandoff(harness, command));
	assert.deepEqual(command.replacementEditor, []);
	assert.deepEqual(command.replacementUserMessages, ["generated prompt"]);
});

for (const action of ["continue", "offer"] as const) {
	test(`automatic ${action} submission failure stays on the replacement context and preserves the prompt`, async () => {
		const harness = createHarness({
			showAutoCountdown: async () => true,
			generatePrompt: async () => ({ action, prompt: "generated prompt" }),
		});
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
		await beginAutomaticHandoff(harness, command);
		command.branch.push({
			type: "message",
			message: { role: "assistant", content: "No continuity todo was warranted." },
		});
		await harness.events.get("agent_settled")?.({}, command.ctx);
		let handlerSettled = false;
		const handoff = harness.commandHandler("--auto-finalize", command.ctx);
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
}

const originalAnswer = "  The proxy sets the timeout.\n\n```ts\n  timeout: 30\n```\n\nSee [the guide](https://example.test).\n";
const answerBranch = () => [
	{ type: "message", id: "question", message: { role: "user", content: "Explain where the timeout comes from", timestamp: 1 } },
	{
		type: "message", id: "answer",
		message: {
			role: "assistant", stopReason: "stop", timestamp: 2,
			content: [
				{ type: "thinking", thinking: "Do not display this reasoning." },
				{ type: "text", text: "  The proxy sets the timeout.\n\n```ts\n  timeout: 30\n```\n" },
				{ type: "text", text: "See [the guide](https://example.test).\n" },
			],
		},
	},
];

for (const action of ["wait", "continue", "offer"] as const) {
	test(`automatic ${action} replays the original answer once, not the preparation report`, async () => {
		const harness = createHarness({ generatePrompt: async () => ({ action, prompt: "checkpoint", replayLastAnswer: true }) });
		const command = createCommandContext({ usageTokens: 150_000, branch: answerBranch() });
		await beginAutomaticHandoff(harness, command);
		await finalizeAutomaticHandoff(harness, command, "Updated TODO-a1b2c3d4. This is not the answer.");
		await harness.events.get("agent_settled")?.({}, command.ctx);
		await harness.commandHandler("--auto-finalize", command.ctx);

		const replays = command.replacementMessages.filter((entry: any) => entry.message.customType === "handoff-answer");
		assert.equal(replays.length, 1);
		assert.deepEqual(replays[0], {
			message: { customType: "handoff-answer", content: `Answer from previous session:\n\n${originalAnswer}`, display: true },
			options: { triggerTurn: false },
		});
		assert.deepEqual(command.replacementDelivery, action === "wait"
			? ["handoff-context", "handoff-answer"] : ["handoff-answer", "user"]);
		assert.deepEqual(command.replacementUserMessages, action === "wait" ? [] : ["checkpoint"]);
		assert.equal(command.sessionOptions.length, 1);
	});
}

for (const replayLastAnswer of [false, undefined]) {
	test(`automatic handoff skips replay for decision ${replayLastAnswer}`, async () => {
		const harness = createHarness({ generatePrompt: async () => ({ action: "wait", prompt: "checkpoint", replayLastAnswer }) });
		const command = createCommandContext({ usageTokens: 150_000, branch: answerBranch() });
		await beginAutomaticHandoff(harness, command);
		await finalizeAutomaticHandoff(harness, command);
		assert.deepEqual(command.replacementDelivery, ["handoff-context"]);
	});
}

for (const [name, change] of [
	["aborted", (branch: any[]) => { branch[1].message.stopReason = "aborted"; }],
	["error", (branch: any[]) => { branch[1].message.stopReason = "error"; }],
	["truncated", (branch: any[]) => { branch[1].message.stopReason = "length"; }],
	["tool call", (branch: any[]) => { branch[1].message.content.push({ type: "toolCall", id: "tool", name: "read", arguments: {} }); }],
	["thinking only", (branch: any[]) => { branch[1].message.content = [{ type: "thinking", thinking: "not an answer" }]; }],
	["blank text", (branch: any[]) => { branch[1].message.content = [{ type: "text", text: " \n " }]; }],
	["new user message", (branch: any[]) => { branch.push({ type: "message", id: "later-user", message: { role: "user", content: "Now do something else" } }); }],
	["later failed assistant", (branch: any[]) => { branch.push({ type: "message", id: "later-assistant", message: { role: "assistant", stopReason: "error", content: [] } }); }],
	["no user question", (branch: any[]) => { branch.shift(); }],
	["previous replay", (branch: any[]) => { branch.push({ type: "custom_message", id: "old-replay", customType: "handoff-answer", content: "old replay", display: true }); }],
] as const) {
	test(`positive classification cannot replay an ineligible source: ${name}`, async () => {
		const branch: any[] = answerBranch();
		change(branch);
		const harness = createHarness({ generatePrompt: async () => ({ action: "wait", prompt: "checkpoint", replayLastAnswer: true }) });
		const command = createCommandContext({ usageTokens: 150_000, branch });
		await beginAutomaticHandoff(harness, command);
		await finalizeAutomaticHandoff(harness, command);
		assert.deepEqual(command.replacementDelivery, ["handoff-context"]);
	});
}

test("a trailing background notice does not hide the last assistant answer from replay", async () => {
	const branch: any[] = answerBranch();
	branch.push({
		type: "custom_message", id: "background-notification", timestamp: "2026-09-18T00:00:00Z",
		customType: "background-result", content: "Background check completed", display: true,
	});
	const harness = createHarness({ generatePrompt: async () => ({ action: "wait", prompt: "checkpoint", replayLastAnswer: true }) });
	const command = createCommandContext({ usageTokens: 150_000, branch });
	await beginAutomaticHandoff(harness, command);
	await finalizeAutomaticHandoff(harness, command);
	const replay = command.replacementMessages.find((entry: any) => entry.message.customType === "handoff-answer") as any;
	assert.equal(replay?.message.content, `Answer from previous session:\n\n${originalAnswer}`);
	assert.deepEqual(command.replacementUserMessages, []);
});

test("automatic classification preserves internal message provenance in the source snapshot", async () => {
	let source: any[] = [];
	const branch: any[] = answerBranch();
	branch.splice(1, 0, {
		type: "custom_message", id: "background-notification", timestamp: "2026-09-18T00:00:00Z",
		customType: "background-result", content: "Worker finished", display: true,
	});
	const harness = createHarness({ generatePrompt: async ({ messages }) => {
		source = messages;
		return { action: "wait", prompt: "checkpoint", replayLastAnswer: false };
	} });
	const command = createCommandContext({ usageTokens: 150_000, branch });
	await beginAutomaticHandoff(harness, command);
	await finalizeAutomaticHandoff(harness, command);
	assert.equal(source[1].role, "custom");
	assert.equal(source[1].customType, "background-result");
	assert.equal(source[1].content, "Worker finished");
	assert.equal(source.at(-1).role, "assistant");
	assert.deepEqual(command.replacementDelivery, ["handoff-context"]);
});

test("manual handoff ignores a positive replay decision", async () => {
	const harness = createHarness({ generatePrompt: async () => ({ action: "wait", prompt: "checkpoint", replayLastAnswer: true }) });
	const command = createCommandContext({ branch: answerBranch() });
	await harness.commandHandler("review the work", command.ctx);
	assert.deepEqual(command.replacementDelivery, []);
	assert.deepEqual(command.replacementEditor, ["edited prompt"]);
});

test("cancelled replacement never replays an answer", async () => {
	const harness = createHarness({ generatePrompt: async () => ({ action: "wait", prompt: "checkpoint", replayLastAnswer: true }) });
	const command = createCommandContext({ usageTokens: 150_000, branch: answerBranch(), newSessionCancelled: true });
	await beginAutomaticHandoff(harness, command);
	await finalizeAutomaticHandoff(harness, command);
	assert.deepEqual(command.replacementDelivery, []);
});

for (const action of ["wait", "continue", "offer"] as const) {
	test(`${action} replay failure stages the checkpoint and original answer without starting work`, async () => {
		const harness = createHarness({ generatePrompt: async () => ({ action, prompt: "checkpoint", replayLastAnswer: true }) });
		const command = createCommandContext({ usageTokens: 150_000, branch: answerBranch() });
		const sendMessage = command.replacementCtx.sendMessage;
		command.replacementCtx.sendMessage = async (message: any, options: unknown) => {
			if (message.customType === "handoff-answer") throw new Error("replay unavailable");
			await sendMessage(message, options);
		};
		await beginAutomaticHandoff(harness, command);
		await finalizeAutomaticHandoff(harness, command);
		assert.equal(command.replacementEditor.length, 1);
		assert.ok(command.replacementEditor[0].includes("checkpoint"));
		assert.ok(command.replacementEditor[0].includes(originalAnswer));
		assert.deepEqual(command.replacementUserMessages, []);
		assert.match(command.notices.at(-1)?.message ?? "", /replay unavailable/);
	});
}

test("failed WAIT context injection preserves the selected answer with the checkpoint", async () => {
	const harness = createHarness({ generatePrompt: async () => ({ action: "wait", prompt: "checkpoint", replayLastAnswer: true }) });
	const command = createCommandContext({ usageTokens: 150_000, branch: answerBranch() });
	command.replacementCtx.sendMessage = async () => { throw new Error("injection unavailable"); };
	await beginAutomaticHandoff(harness, command);
	await finalizeAutomaticHandoff(harness, command);
	assert.equal(command.replacementEditor.length, 1);
	assert.ok(command.replacementEditor[0].includes("checkpoint"));
	assert.ok(command.replacementEditor[0].includes(originalAnswer));
	assert.deepEqual(command.replacementUserMessages, []);
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
		dependencies: { generatePrompt: async () => ({ action: "continue", prompt: "  \n" }) },
	},
	{
		name: "prompt generation has no action",
		dependencies: { generatePrompt: async () => "generated prompt" as any },
	},
	{
		name: "replay decision is not a boolean",
		dependencies: { generatePrompt: async () => ({ action: "wait", prompt: "checkpoint", replayLastAnswer: "YES" }) as any },
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
		await beginAutomaticHandoff(harness, command);
		const failsBeforePreparation =
			scenario.name === "no selected model" || scenario.name === "no handoff messages";
		if (!failsBeforePreparation) {
			await finalizeAutomaticHandoff(harness, command);
		}
		if (
			scenario.name === "prompt generation throws" ||
			scenario.name === "prompt generation is empty" ||
			scenario.name === "prompt generation has no action"
		) {
			assert.equal(command.getManualEditorCalls(), 0);
			assert.equal(command.sessionOptions.length, 0);
			assert.deepEqual(command.replacementUserMessages, []);
		}
		await harness.commandHandler("auto status", command.ctx);
		assert.match(command.notices.at(-1)?.message ?? "", /disabled/);
		await harness.events.get("agent_settled")?.({}, command.ctx);
		assert.equal(harness.sentMessages.length, failsBeforePreparation ? 1 : 2);
	});
}
