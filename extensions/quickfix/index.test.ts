import test from "node:test";
import assert from "node:assert/strict";
import registerQuickfix from "./index.ts";

type CommandHandler = (args: string, ctx: any) => Promise<void>;
type EventHandler = (event: any, ctx: any) => Promise<any> | any;

type Harness = ReturnType<typeof createPiHarness>;

type ContextOptions = {
	mode?: string;
	hasUI?: boolean;
	input?: string | undefined;
	select?: string | undefined;
	branch?: any[];
	contextEntries?: any[];
	leafId?: string | null | (() => string | null);
	sessionId?: string;
	skills?: Array<{ name: string }>;
	classification?: () => Promise<any>;
	navigate?: (id: string, options: unknown) => Promise<{ cancelled?: boolean }>;
};

function createPiHarness() {
	const commands = new Map<string, CommandHandler>();
	const events = new Map<string, EventHandler[]>();
	const sent: string[] = [];
	const appended: Array<{ type: string; data: unknown }> = [];
	const calls: string[] = [];
	const pi = {
		registerCommand(name: string, definition: { handler: CommandHandler }) {
			commands.set(name, definition.handler);
		},
		on(name: string, handler: EventHandler) {
			events.set(name, [...(events.get(name) ?? []), handler]);
		},
		sendUserMessage(message: string) {
			calls.push("dispatch");
			sent.push(message);
		},
		appendEntry(type: string, data: unknown) {
			appended.push({ type, data });
		},
	};
	return { pi, commands, events, sent, appended, calls };
}

const allSkills = [
	"systematic-debugging",
	"test-driven-development",
	"verification-before-completion",
	"module-size",
	"nix-config",
	"simple-english",
].map((name) => ({ name }));

function userEntry(id: string, text: string) {
	return {
		type: "message",
		id,
		message: { role: "user", content: text },
	};
}

function createContext(harness: Harness, options: ContextOptions = {}) {
	const notifications: Array<{ message: string; level: string }> = [];
	const widgets: Array<{ key: string; value: unknown }> = [];
	const editor: string[] = [];
	const inputs: string[] = [];
	const selectors: Array<{ title: string; items: string[] }> = [];
	const navigations: Array<{ id: string; options: any }> = [];
	const branch = options.branch ?? [userEntry("origin-user", "raw branch request")];
	const contextEntries = options.contextEntries ?? [userEntry("context-user", "resolved classifier context")];
	let completeCalls = 0;
	const completionContexts: any[] = [];
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		ui: {
			input: async (title: string) => {
				inputs.push(title);
				return options.input;
			},
			select: async (title: string, items: string[]) => {
				selectors.push({ title, items });
				return options.select;
			},
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			setWidget(key: string, value: unknown) {
				widgets.push({ key, value });
			},
			setEditorText(value: string) {
				editor.push(value);
			},
		},
		waitForIdle: async () => {},
		navigateTree: async (id: string, navigationOptions: unknown) => {
			harness.calls.push("navigate");
			navigations.push({ id, options: navigationOptions });
			return options.navigate?.(id, navigationOptions) ?? { cancelled: true };
		},
		sessionManager: {
			getSessionId: () => options.sessionId ?? "session-1",
			getLeafId: () => options.leafId === undefined
				? "origin-leaf"
				: typeof options.leafId === "function" ? options.leafId() : options.leafId,
			getEntries: () => branch,
			getBranch: () => branch,
			buildContextEntries: () => contextEntries,
		},
		getSystemPromptOptions: () => ({ skills: options.skills ?? allSkills }),
		model: { provider: "test", id: "classifier" },
		modelRegistry: {
			complete: async (_model: unknown, context: any) => {
				completeCalls++;
				completionContexts.push(context);
				return options.classification?.() ?? {
					stopReason: "stop",
					content: [{ type: "text", text: "Summary from classifier.\nQUICKFIX_PROFILE: bug\nQUICKFIX_CONFIDENCE: high" }],
				};
			},
		},
	};
	return {
		ctx,
		notifications,
		widgets,
		editor,
		inputs,
		selectors,
		navigations,
		completionContexts,
		get completeCalls() { return completeCalls; },
	};
}

function command(harness: Harness, name: string): CommandHandler {
	const handler = harness.commands.get(name);
	assert.ok(handler, `/${name} should register`);
	return handler;
}

test("registers quick-fix commands", () => {
	const harness = createPiHarness();
	registerQuickfix(harness.pi as any);
	assert.ok(harness.commands.has("quickfix"));
	assert.ok(harness.commands.has("end-quickfix"));
});

test("rejects non-TUI quick-fix commands before classification", async () => {
	const harness = createPiHarness();
	registerQuickfix(harness.pi as any);
	const fixture = createContext(harness, { mode: "rpc", hasUI: true });

	await command(harness, "quickfix")("Fix it", fixture.ctx);

	assert.equal(fixture.completeCalls, 0);
	assert.equal(fixture.navigations.length, 0);
	assert.match(fixture.notifications[0].message, /interactive mode/i);
});

test("rejects unknown profiles before classification", async () => {
	const harness = createPiHarness();
	registerQuickfix(harness.pi as any);
	const fixture = createContext(harness);

	await command(harness, "quickfix")("--profile unknown Fix it", fixture.ctx);

	assert.equal(fixture.completeCalls, 0);
	assert.equal(fixture.navigations.length, 0);
	assert.match(fixture.notifications[0].message, /Unknown quick-fix profile/);
});

test("opens input for an empty request and leaves cancellation unchanged", async () => {
	const harness = createPiHarness();
	registerQuickfix(harness.pi as any);
	const fixture = createContext(harness, { input: undefined });

	await command(harness, "quickfix")("", fixture.ctx);

	assert.equal(fixture.inputs.length, 1);
	assert.equal(fixture.completeCalls, 0);
	assert.equal(fixture.navigations.length, 0);
	assert.equal(harness.sent.length, 0);
});

test("reports that an empty session cannot enter a quick-fix branch", async () => {
	const harness = createPiHarness();
	registerQuickfix(harness.pi as any);
	const fixture = createContext(harness, { leafId: null });

	await command(harness, "quickfix")("Fix it", fixture.ctx);

	assert.equal(fixture.completeCalls, 0);
	assert.equal(fixture.navigations.length, 0);
	assert.match(fixture.notifications[0].message, /empty session/i);
});

test("starts, activates, and dispatches a high-confidence quick-fix from the raw branch point", async () => {
	const { default: registerSuccessfulStart } = await import("./index.ts?successful-command-start");
	const harness = createPiHarness();
	registerSuccessfulStart(harness.pi as any);
	const fixture = createContext(harness, {
		branch: [userEntry("raw-user", "raw branch only")],
		contextEntries: [userEntry("context-user", "resolved context only")],
		navigate: async () => ({ cancelled: false }),
	});

	await command(harness, "quickfix")("Fix it", fixture.ctx);

	assert.equal(fixture.completeCalls, 1);
	const classifierPrompt = fixture.completionContexts[0].messages[0].content[0].text;
	assert.match(classifierPrompt, /resolved context only/);
	assert.doesNotMatch(classifierPrompt, /raw branch only/);
	assert.equal(fixture.navigations[0].id, "raw-user");
	assert.deepEqual(fixture.navigations[0].options, { summarize: false, label: "quickfix:bug" });
	assert.deepEqual(harness.calls, ["navigate", "dispatch"]);
	assert.equal(harness.sent.length, 1);
	assert.match(harness.sent[0], /Summary from classifier/);
	assert.deepEqual(fixture.widgets, [{
		key: "quickfix",
		value: ["Quick-fix active (Bug fixes). Return with \/end-quickfix."],
	}]);
	assert.equal(fixture.notifications.length, 0);
});

test("uses an explicit profile over the classifier result", async () => {
	const harness = createPiHarness();
	registerQuickfix(harness.pi as any);
	const fixture = createContext(harness);

	await command(harness, "quickfix")("--profile docs Improve the guide", fixture.ctx);

	assert.equal(fixture.completeCalls, 1);
	assert.deepEqual(fixture.navigations[0].options, { summarize: false, label: "quickfix:docs" });
});

test("uses the profile selector for low confidence and classifier failure", async () => {
	const lowConfidenceHarness = createPiHarness();
	registerQuickfix(lowConfidenceHarness.pi as any);
	const lowConfidence = createContext(lowConfidenceHarness, {
		select: "Mechanical cleanup",
		classification: async () => ({
			stopReason: "stop",
			content: [{ type: "text", text: "Maybe cleanup.\nQUICKFIX_PROFILE: mechanical\nQUICKFIX_CONFIDENCE: low" }],
		}),
	});

	await command(lowConfidenceHarness, "quickfix")("Clean it", lowConfidence.ctx);
	assert.equal(lowConfidence.selectors.length, 1);
	assert.deepEqual(lowConfidence.navigations[0].options, { summarize: false, label: "quickfix:mechanical" });

	const failureHarness = createPiHarness();
	registerQuickfix(failureHarness.pi as any);
	const failure = createContext(failureHarness, {
		select: "Docs improvements",
		classification: async () => {
			throw new Error("network unavailable");
		},
	});

	await command(failureHarness, "quickfix")("Document it", failure.ctx);
	assert.equal(failure.selectors.length, 1);
	assert.equal(failure.notifications[0].message, "Quick-fix classification failed. Select a profile to continue.");
	assert.deepEqual(failure.navigations[0].options, { summarize: false, label: "quickfix:docs" });
});

test("does not navigate when profile selection is cancelled or skills are unavailable", async () => {
	const cancellationHarness = createPiHarness();
	registerQuickfix(cancellationHarness.pi as any);
	const cancellation = createContext(cancellationHarness, {
		select: undefined,
		classification: async () => ({
			stopReason: "stop",
			content: [{ type: "text", text: "Uncertain.\nQUICKFIX_PROFILE: ambiguous\nQUICKFIX_CONFIDENCE: low" }],
		}),
	});

	await command(cancellationHarness, "quickfix")("Fix it", cancellation.ctx);
	assert.equal(cancellation.navigations.length, 0);

	const missingSkillsHarness = createPiHarness();
	registerQuickfix(missingSkillsHarness.pi as any);
	const missingSkills = createContext(missingSkillsHarness, { skills: [] });
	await command(missingSkillsHarness, "quickfix")("Fix it", missingSkills.ctx);
	assert.equal(missingSkills.navigations.length, 0);
	assert.match(missingSkills.notifications[0].message, /Missing quick-fix skills/);
});

test("refuses a second command while the first quick-fix navigation is pending", async () => {
	const harness = createPiHarness();
	registerQuickfix(harness.pi as any);
	let resolveNavigation!: (result: { cancelled: boolean }) => void;
	let signalNavigationStarted!: () => void;
	const navigationStarted = new Promise<void>((resolve) => { signalNavigationStarted = resolve; });
	const first = createContext(harness, {
		navigate: async () => {
			signalNavigationStarted();
			return new Promise((done) => { resolveNavigation = done; });
		},
	});
	const firstStart = command(harness, "quickfix")("First fix", first.ctx);

	await navigationStarted;
	const second = createContext(harness);
	await command(harness, "quickfix")("Second fix", second.ctx);
	resolveNavigation({ cancelled: true });
	await firstStart;

	assert.equal(second.completeCalls, 0);
	assert.equal(second.navigations.length, 0);
	assert.match(second.notifications[0].message, /already active/i);
});

test("uses generic selector fallback notices for arbitrary provider failures", async () => {
	for (const providerError of [
		"plain provider payload: confidential response",
		"access_token=unrecognized-opaque-token",
	]) {
		const harness = createPiHarness();
		registerQuickfix(harness.pi as any);
		const fixture = createContext(harness, {
			select: "Docs improvements",
			classification: async () => { throw new Error(providerError); },
		});

		await command(harness, "quickfix")("Document it", fixture.ctx);

		assert.equal(fixture.selectors.length, 1);
		assert.equal(fixture.notifications[0].message, "Quick-fix classification failed. Select a profile to continue.");
		assert.doesNotMatch(fixture.notifications[0].message, /confidential|access_token|opaque-token/);
	}
});

test("keeps quick-fix active after dispatch failure, restores the editor, and refuses another command", async () => {
	const harness = createPiHarness();
	registerQuickfix(harness.pi as any);
	const originalDispatch = harness.pi.sendUserMessage;
	harness.pi.sendUserMessage = (message: string) => {
		originalDispatch(message);
		throw new Error("dispatch failed");
	};
	const fixture = createContext(harness, {
		select: "Docs improvements",
		classification: async () => {
			throw new Error("network unavailable");
		},
		navigate: async () => ({ cancelled: false }),
	});

	await command(harness, "quickfix")("Document it", fixture.ctx);

	assert.deepEqual(harness.calls, ["navigate", "dispatch"]);
	assert.match(harness.sent[0], /No origin summary is available/);
	assert.deepEqual(fixture.widgets[0], {
		key: "quickfix",
		value: ["Quick-fix active (Docs improvements). Return with \/end-quickfix."],
	});
	assert.equal(fixture.editor[0], harness.sent[0]);

	await command(harness, "quickfix")("Another fix", fixture.ctx);
	assert.equal(fixture.completeCalls, 1);
	assert.match(fixture.notifications.at(-1)!.message, /already active/i);
});

test("returns from entering state after dispatch failure", async () => {
	const { default: register } = await import("./index.ts?return-entering-after-dispatch-failure");
	const harness = createPiHarness();
	register(harness.pi as any);
	const originalDispatch = harness.pi.sendUserMessage;
	harness.pi.sendUserMessage = (message: string) => {
		originalDispatch(message);
		throw new Error("dispatch failed");
	};
	const fixture = createContext(harness, {
		navigate: async () => ({ cancelled: false }),
	});

	await command(harness, "quickfix")("Fix it", fixture.ctx);
	await command(harness, "end-quickfix")("", fixture.ctx);

	assert.deepEqual(fixture.navigations, [
		{ id: "origin-user", options: { summarize: false, label: "quickfix:bug" } },
		{ id: "origin-leaf", options: { summarize: false } },
	]);
	assert.deepEqual(fixture.widgets.at(-1), { key: "quickfix", value: undefined });
	assert.match(fixture.notifications.at(-1)?.message ?? "", /Returned to original position/);
});

test("clears entering state after dispatch failure when manual tree navigation occurs", async () => {
	const { default: register } = await import("./index.ts?clear-entering-after-manual-navigation");
	const harness = createPiHarness();
	register(harness.pi as any);
	const originalDispatch = harness.pi.sendUserMessage;
	harness.pi.sendUserMessage = (message: string) => {
		originalDispatch(message);
		throw new Error("dispatch failed");
	};
	const fixture = createContext(harness, {
		navigate: async () => ({ cancelled: false }),
	});

	await command(harness, "quickfix")("Fix it", fixture.ctx);
	const sessionTree = harness.events.get("session_tree")?.[0];
	assert.ok(sessionTree, "session_tree should register");
	const elsewhere = createContext(harness, {
		branch: [userEntry("other-user", "other branch")],
		leafId: "other-user",
	});
	await sessionTree({}, elsewhere.ctx);

	assert.deepEqual(elsewhere.widgets.at(-1), { key: "quickfix", value: undefined });
	await command(harness, "quickfix")("Another fix", elsewhere.ctx);
	assert.equal(elsewhere.completeCalls, 1);
	assert.equal(elsewhere.navigations.length, 1);
});

test("keeps entering state through controlled initial submission tree events", async () => {
	const { default: register } = await import("./index.ts?controlled-entering-session-tree");
	const harness = createPiHarness();
	register(harness.pi as any, {
		loadPiPromptModule: async () => ({ formatSkillsForPrompt }),
	});
	const fixture = createContext(harness, {
		skills: promptSkills,
		navigate: async () => ({ cancelled: false }),
	});
	const sessionTree = harness.events.get("session_tree")?.[0];
	assert.ok(sessionTree, "session_tree should register");
	const originalDispatch = harness.pi.sendUserMessage;
	harness.pi.sendUserMessage = (message: string) => {
		originalDispatch(message);
		sessionTree({}, fixture.ctx);
	};

	await command(harness, "quickfix")("Fix it", fixture.ctx);
	const before = harness.events.get("before_agent_start")?.[0];
	assert.ok(before, "before_agent_start should register");
	const result = await before({
		systemPrompt: `Base prompt\n${formatSkillsForPrompt(promptSkills)}\nNormal workflow`,
		systemPromptOptions: { skills: promptSkills, appendSystemPrompt: "Normal workflow" },
	}, fixture.ctx);

	assert.match(result.systemPrompt, /Quick-fix mode is for one bounded change only/);
});

const promptSkills = [
	...allSkills,
	{ name: "brainstorming" },
	{ name: "writing-plans" },
];

function formatSkillsForPrompt(skills: Array<{ name: string }>): string {
	return `SKILLS: ${skills.map((skill) => skill.name).join(", ")}`;
}

async function activateQuickfix(testId: string) {
	const { default: register } = await import(`./index.ts?task-6-${testId}`);
	const harness = createPiHarness();
	register(harness.pi as any, {
		loadPiPromptModule: async () => ({ formatSkillsForPrompt }),
	});
	let leafId = "origin-leaf";
	const branch = [userEntry("origin-user", "origin"), userEntry("quickfix-marker", "quick fix")];
	const fixture = createContext(harness, {
		branch,
		leafId: () => leafId,
		skills: promptSkills,
		navigate: async () => {
			leafId = "quickfix-marker";
			return { cancelled: false };
		},
	});

	await command(harness, "quickfix")("Fix it", fixture.ctx);
	const before = harness.events.get("before_agent_start")?.[0];
	assert.ok(before, "before_agent_start should register");
	const initialResult = await before({
		systemPrompt: `Base prompt\n${formatSkillsForPrompt(promptSkills)}\nNormal workflow`,
		systemPromptOptions: { skills: promptSkills, appendSystemPrompt: "Normal workflow" },
	}, fixture.ctx);
	return { harness, fixture, branch, before, initialResult };
}

test("captures the entering marker and filters every turn only on its quick-fix branch", async () => {
	const active = await activateQuickfix("prompt-membership");

	assert.match(active.initialResult.systemPrompt, /Quick-fix mode is for one bounded change only/);
	assert.doesNotMatch(active.initialResult.systemPrompt, /brainstorming|writing-plans|Normal workflow/);

	const followUp = await active.before({
		systemPrompt: `Base prompt\n${formatSkillsForPrompt(promptSkills)}\nNormal workflow`,
		systemPromptOptions: { skills: promptSkills, appendSystemPrompt: "Normal workflow" },
	}, active.fixture.ctx);
	assert.match(followUp.systemPrompt, /Quick-fix mode is for one bounded change only/);

	const unmarked = createContext(active.harness, {
		branch: [userEntry("origin-user", "origin")],
		sessionId: "session-1",
		skills: promptSkills,
	});
	assert.equal(await active.before({ systemPrompt: "unfiltered", systemPromptOptions: { skills: promptSkills } }, unmarked.ctx), undefined);
	assert.deepEqual(unmarked.widgets, [{ key: "quickfix", value: undefined }]);
});

test("clears quick-fix state on a different session and fails closed when filtering fails", async () => {
	const active = await activateQuickfix("stale-and-failure");
	const differentSession = createContext(active.harness, {
		branch: active.branch,
		sessionId: "session-2",
		skills: promptSkills,
	});
	assert.equal(await active.before({ systemPrompt: "unfiltered", systemPromptOptions: { skills: promptSkills } }, differentSession.ctx), undefined);
	assert.deepEqual(differentSession.widgets, [{ key: "quickfix", value: undefined }]);

	const failedFilter = await activateQuickfix("filter-failure");
	const result = await failedFilter.before({
		systemPrompt: "normal skills: brainstorming, writing-plans",
		systemPromptOptions: { skills: promptSkills },
	}, failedFilter.fixture.ctx);
	assert.match(result.systemPrompt, /Quick-fix prompt filtering failed\. Do not edit files/);
	assert.doesNotMatch(result.systemPrompt, /brainstorming|writing-plans/);
	assert.equal(failedFilter.fixture.notifications.at(-1)?.level, "error");
	assert.match(failedFilter.fixture.notifications.at(-1)?.message ?? "", /Missing original quick-fix skill section/);
	assert.doesNotMatch(failedFilter.fixture.widgets.at(-1)?.value?.[0] ?? "", /undefined/);
});

test("blocks only nested orchestration tools on an active quick-fix branch", async () => {
	const active = await activateQuickfix("tool-gate");
	const toolCall = active.harness.events.get("tool_call")?.[0];
	assert.ok(toolCall, "tool_call should register");
	const blocked = {
		block: true,
		reason: "Quick-fix mode does not permit nested orchestration. Complete the bounded fix directly or report NEEDS_NORMAL_WORKFLOW.",
	};
	assert.deepEqual(await toolCall({ toolName: "subagent" }, active.fixture.ctx), blocked);
	assert.deepEqual(await toolCall({ toolName: "run_team" }, active.fixture.ctx), blocked);
	for (const toolName of ["read", "bash", "edit", "write", "unrelated_tool"]) {
		assert.equal(await toolCall({ toolName }, active.fixture.ctx), undefined);
	}

	const outside = createContext(active.harness, { branch: [userEntry("origin-user", "origin")], skills: promptSkills });
	assert.equal(await toolCall({ toolName: "subagent" }, outside.ctx), undefined);
});

test("cleans stale state on session events and returns to the origin without pruning the branch", async () => {
	const active = await activateQuickfix("return");
	const sessionTree = active.harness.events.get("session_tree")?.[0];
	const sessionShutdown = active.harness.events.get("session_shutdown")?.[0];
	const sessionStart = active.harness.events.get("session_start")?.[0];
	assert.ok(sessionTree, "session_tree should register");
	assert.ok(sessionShutdown, "session_shutdown should register");
	assert.ok(sessionStart, "session_start should register");

	await sessionTree({}, active.fixture.ctx);
	assert.match((await active.before({
		systemPrompt: `Base prompt\n${formatSkillsForPrompt(promptSkills)}`,
		systemPromptOptions: { skills: promptSkills },
	}, active.fixture.ctx)).systemPrompt, /Quick-fix mode/);

	let waitComplete = false;
	active.fixture.ctx.waitForIdle = async () => { waitComplete = true; };
	active.fixture.ctx.navigateTree = async (id: string, options: unknown) => {
		assert.equal(waitComplete, true);
		active.fixture.navigations.push({ id, options });
		return { cancelled: false };
	};
	await command(active.harness, "end-quickfix")("", active.fixture.ctx);
	assert.deepEqual(active.fixture.navigations.at(-1), { id: "origin-leaf", options: { summarize: false } });
	assert.equal(active.branch.some((entry) => entry.id === "quickfix-marker"), true);
	assert.deepEqual(active.fixture.widgets.at(-1), { key: "quickfix", value: undefined });
	assert.match(active.fixture.notifications.at(-1)?.message ?? "", /Returned to original position/);

	await command(active.harness, "end-quickfix")("", active.fixture.ctx);
	assert.match(active.fixture.notifications.at(-1)?.message ?? "", /No active quick-fix/i);

	const stale = await activateQuickfix("session-events");
	const staleTreeContext = createContext(stale.harness, { branch: [userEntry("origin-user", "origin")] });
	await stale.harness.events.get("session_tree")?.[0]({}, staleTreeContext.ctx);
	assert.deepEqual(staleTreeContext.widgets.at(-1), { key: "quickfix", value: undefined });
	assert.equal(await stale.harness.events.get("tool_call")?.[0]({ toolName: "subagent" }, staleTreeContext.ctx), undefined);

	const restarted = await activateQuickfix("session-start");
	const staleStartContext = createContext(restarted.harness, { branch: [userEntry("origin-user", "origin")] });
	await restarted.harness.events.get("session_start")?.[0]({}, staleStartContext.ctx);
	assert.deepEqual(staleStartContext.widgets.at(-1), { key: "quickfix", value: undefined });

	const shutdown = await activateQuickfix("session-shutdown");
	await shutdown.harness.events.get("session_shutdown")?.[0]({}, shutdown.fixture.ctx);
	assert.deepEqual(shutdown.fixture.widgets.at(-1), { key: "quickfix", value: undefined });
	assert.ok(sessionShutdown);
	assert.ok(sessionStart);
});

test("reestablishes the widget when a matching quick-fix session starts", async () => {
	const active = await activateQuickfix("matching-session-start");
	const sessionStart = active.harness.events.get("session_start")?.[0];
	assert.ok(sessionStart, "session_start should register");
	active.fixture.widgets.length = 0;

	await sessionStart({}, active.fixture.ctx);

	assert.deepEqual(active.fixture.widgets, [{
		key: "quickfix",
		value: ["Quick-fix active (Bug fixes). Return with /end-quickfix."],
	}]);
});

test("prevents concurrent quick-fix returns while waiting for idle", async () => {
	const active = await activateQuickfix("end-return-race");
	active.fixture.navigations.length = 0;
	let resolveIdle!: () => void;
	let signalWaitStarted!: () => void;
	const waitStarted = new Promise<void>((resolve) => { signalWaitStarted = resolve; });
	const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
	active.fixture.ctx.waitForIdle = async () => {
		signalWaitStarted();
		await idle;
	};
	active.fixture.ctx.navigateTree = async (id: string, options: unknown) => {
		active.fixture.navigations.push({ id, options });
		return { cancelled: false };
	};

	const end = command(active.harness, "end-quickfix");
	const first = end("", active.fixture.ctx);
	await waitStarted;
	let secondFinished = false;
	const second = end("", active.fixture.ctx).then(() => { secondFinished = true; });
	await Promise.resolve();
	const secondReturnedImmediately = secondFinished;
	assert.equal(active.fixture.navigations.length, 0);

	resolveIdle();
	await Promise.all([first, second]);
	assert.equal(secondReturnedImmediately, true);
	assert.deepEqual(active.fixture.navigations, [{ id: "origin-leaf", options: { summarize: false } }]);
	assert.deepEqual(active.fixture.widgets.at(-1), { key: "quickfix", value: undefined });
});

test("does not resurrect quick-fix state cleared while waiting to return", async () => {
	const active = await activateQuickfix("end-return-stale");
	let resolveIdle!: () => void;
	let signalWaitStarted!: () => void;
	const waitStarted = new Promise<void>((resolve) => { signalWaitStarted = resolve; });
	const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
	active.fixture.ctx.waitForIdle = async () => {
		signalWaitStarted();
		await idle;
	};
	active.fixture.ctx.navigateTree = async () => {
		assert.fail("stale quick-fix state must not navigate to the origin");
	};

	const returning = command(active.harness, "end-quickfix")("", active.fixture.ctx);
	await waitStarted;
	active.branch.pop();
	await active.harness.events.get("session_tree")?.[0]({}, active.fixture.ctx);
	resolveIdle();
	await returning;

	assert.deepEqual(active.fixture.widgets.at(-1), { key: "quickfix", value: undefined });
	assert.match(active.fixture.notifications.at(-1)?.message ?? "", /Quick-fix state changed while waiting to return/);
	await command(active.harness, "end-quickfix")("", active.fixture.ctx);
	assert.match(active.fixture.notifications.at(-1)?.message ?? "", /No active quick-fix/i);
});

test("restores active state and its widget after cancelled or failed origin navigation", async () => {
	const cancelled = await activateQuickfix("cancelled-return");
	cancelled.fixture.ctx.navigateTree = async () => ({ cancelled: true });
	await command(cancelled.harness, "end-quickfix")("", cancelled.fixture.ctx);
	assert.match(cancelled.fixture.notifications.at(-1)?.message ?? "", /Navigation cancelled/);
	assert.deepEqual(cancelled.fixture.widgets.at(-1), {
		key: "quickfix",
		value: ["Quick-fix active (Bug fixes). Return with /end-quickfix."],
	});

	const failed = await activateQuickfix("failed-return");
	failed.fixture.ctx.navigateTree = async () => { throw new Error("navigation broken"); };
	await command(failed.harness, "end-quickfix")("", failed.fixture.ctx);
	assert.match(failed.fixture.notifications.at(-1)?.message ?? "", /Failed to return: navigation broken/);
	assert.deepEqual(failed.fixture.widgets.at(-1), {
		key: "quickfix",
		value: ["Quick-fix active (Bug fixes). Return with /end-quickfix."],
	});
});
