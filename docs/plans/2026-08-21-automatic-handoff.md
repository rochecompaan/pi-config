# Threshold-Driven Automatic Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a threshold-driven automatic handoff that submits a generated continuation prompt in a replacement Pi session so the agent continues without Enter.

**Architecture:** `extensions/handoff.ts` remains the Pi-facing shell for events, commands, UI, model calls, and session replacement. `extensions/handoff-auto.ts` contains deterministic settings, parser, trigger, and state-transition rules. Inject the slow or external boundaries so Node tests can exercise the real command flow without a TUI, timer, model call, or session switch.

**Tech Stack:** TypeScript, Pi 0.84.2 extension APIs, `node:test`, Node 24 type stripping, JSON settings, and Nix flake checks.

## Global Constraints

- Implement `docs/specs/2026-08-21-automatic-handoff-design.md` without changing its approved behavior.
- Trigger only from `agent_settled` in interactive TUI mode.
- Use raw `ctx.getContextUsage().tokens` without tool-token estimates.
- Use 150,000 tokens when the effective setting is missing, invalid, or not positive.
- Enable automatic handoff by default for each session.
- Use a fixed five-second countdown. Escape cancels it, and zero continues it.
- Disable later automatic attempts after cancellation or any automatic error before replacement.
- If replacement submission fails, preserve the prompt and report the error through `replacementCtx` only.
- Require `/handoff auto on` before another automatic attempt.
- Start immediately when `/handoff auto on` runs at or above the threshold.
- Dispatch `/handoff --auto` with `expandPromptTemplates: true` before session replacement.
- Keep `ctx.newSession()` inside the `/handoff` command context.
- Capture only plain prompt and session-path data before replacement.
- Use only `replacementCtx` after a successful replacement.
- Submit the automatic prompt with `await replacementCtx.sendUserMessage()`.
- Keep manual prompt staging on `replacementCtx.ui.setEditorText()`.
- Preserve the manual `/handoff <goal>` review-and-edit flow.
- Do not subscribe to compaction events or change `compaction.enabled`.
- Use Node 24 with `node --test --experimental-strip-types` for focused tests.
- Apply the Testing Value Gate. Do not add tests that assert static JSON or Nix source text.
- Run the focused tests, extension-load check, full flake check, and interactive smoke tests before completion.

## File Structure

- Create `extensions/handoff-auto.ts` for constants and pure automatic-handoff policy.
- Modify `extensions/handoff.ts` as the sole Pi-facing entry point and side-effect shell.
- Create `tests/extensions/handoff-auto.test.ts` for settings, parsing, trigger, and transition behavior.
- Create `tests/extensions/handoff.test.ts` for command, event, countdown-result, and replacement behavior.
- Modify `settings.json` to set the global threshold explicitly.
- Modify `modules/checks/pi-config-extension-load.nix` to reject invalid top-level extension factories.
- Create `.pi/settings.json` only as an ignored interactive-test fixture. Remove it after each smoke-test phase.

Pi auto-discovers every top-level `extensions/*.ts` file. Therefore, `extensions/handoff-auto.ts` must export a no-op default extension factory. Its named exports remain pure and hold all policy logic.

No packaging change is necessary. `modules/packages/pi-config.nix` already copies the complete `extensions/` directory.

---

### Task 1: Add Pure Automatic-Handoff Policy

**Files:**
- Create: `extensions/handoff-auto.ts`
- Create: `tests/extensions/handoff-auto.test.ts`

**Interfaces:**
- Consumes: Plain settings objects, command text, usage data, and state events.
- Produces: `DEFAULT_AUTO_THRESHOLD_TOKENS`, `AUTO_HANDOFF_COUNTDOWN_SECONDS`, `AUTO_HANDOFF_GOAL`, `AutoHandoffState`, `ParsedHandoffCommand`, `resolveAutoThresholdTokens()`, `parseHandoffCommand()`, `shouldTriggerAutoHandoff()`, and `transitionAutoHandoffState()`.

- [ ] **Step 1: Write the failing pure-policy tests**

Create `tests/extensions/handoff-auto.test.ts` with these imports and cases:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
	AUTO_HANDOFF_GOAL,
	DEFAULT_AUTO_THRESHOLD_TOKENS,
	parseHandoffCommand,
	resolveAutoThresholdTokens,
	shouldTriggerAutoHandoff,
	transitionAutoHandoffState,
} from "../../extensions/handoff-auto.ts";

test("uses the default when no threshold exists", () => {
	assert.equal(
		resolveAutoThresholdTokens({ globalSettings: {}, projectTrusted: false }),
		150_000,
	);
});

test("uses a valid global threshold", () => {
	assert.equal(
		resolveAutoThresholdTokens({
			globalSettings: { handoff: { autoThresholdTokens: 90_000 } },
			projectTrusted: false,
		}),
		90_000,
	);
});

test("uses a valid trusted project threshold", () => {
	assert.equal(
		resolveAutoThresholdTokens({
			globalSettings: { handoff: { autoThresholdTokens: 90_000 } },
			projectSettings: { handoff: { autoThresholdTokens: 120_000 } },
			projectTrusted: true,
		}),
		120_000,
	);
});

test("ignores an untrusted project threshold", () => {
	assert.equal(
		resolveAutoThresholdTokens({
			globalSettings: { handoff: { autoThresholdTokens: 90_000 } },
			projectSettings: { handoff: { autoThresholdTokens: 1 } },
			projectTrusted: false,
		}),
		90_000,
	);
});

test("uses the default for invalid effective values", () => {
	for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "120000", null]) {
		assert.equal(
			resolveAutoThresholdTokens({
				globalSettings: { handoff: { autoThresholdTokens: 90_000 } },
				projectSettings: { handoff: { autoThresholdTokens: value } },
				projectTrusted: true,
			}),
			DEFAULT_AUTO_THRESHOLD_TOKENS,
		);
	}
});

test("parses internal, control, missing, and manual command forms", () => {
	assert.deepEqual(parseHandoffCommand("--auto"), { kind: "internal-auto" });
	assert.deepEqual(parseHandoffCommand("auto on"), { kind: "auto-control", action: "on" });
	assert.deepEqual(parseHandoffCommand("auto off"), { kind: "auto-control", action: "off" });
	assert.deepEqual(parseHandoffCommand("auto status"), { kind: "auto-control", action: "status" });
	assert.deepEqual(parseHandoffCommand(""), { kind: "missing-goal" });
	assert.deepEqual(parseHandoffCommand("continue phase one"), {
		kind: "manual",
		goal: "continue phase one",
	});
	assert.deepEqual(parseHandoffCommand("auto investigate the parser"), {
		kind: "manual",
		goal: "auto investigate the parser",
	});
});

test("triggers only for an armed idle TUI at or above the threshold", () => {
	const ready = {
		mode: "tui",
		idle: true,
		state: "armed" as const,
		usageTokens: 150_000,
		thresholdTokens: 150_000,
	};
	assert.equal(shouldTriggerAutoHandoff(ready), true);
	assert.equal(shouldTriggerAutoHandoff({ ...ready, usageTokens: 149_999 }), false);
	assert.equal(shouldTriggerAutoHandoff({ ...ready, usageTokens: undefined }), false);
	assert.equal(shouldTriggerAutoHandoff({ ...ready, mode: "print" }), false);
	assert.equal(shouldTriggerAutoHandoff({ ...ready, idle: false }), false);
	assert.equal(shouldTriggerAutoHandoff({ ...ready, state: "running" }), false);
	assert.equal(shouldTriggerAutoHandoff({ ...ready, state: "disabled" }), false);
});

test("applies every approved state transition", () => {
	assert.equal(transitionAutoHandoffState("disabled", { type: "session-start" }), "armed");
	assert.equal(transitionAutoHandoffState("armed", { type: "threshold-reached" }), "running");
	assert.equal(transitionAutoHandoffState("armed", { type: "auto-off" }), "disabled");
	assert.equal(transitionAutoHandoffState("running", { type: "attempt-failed" }), "disabled");
	assert.equal(
		transitionAutoHandoffState("disabled", {
			type: "auto-on",
			usageTokens: 149_999,
			thresholdTokens: 150_000,
		}),
		"armed",
	);
	assert.equal(
		transitionAutoHandoffState("disabled", {
			type: "auto-on",
			usageTokens: 150_000,
			thresholdTokens: 150_000,
		}),
		"running",
	);
});

test("exports the approved default and automatic goal", () => {
	assert.equal(DEFAULT_AUTO_THRESHOLD_TOKENS, 150_000);
	assert.equal(
		AUTO_HANDOFF_GOAL,
		"Continue the current task in a fresh session. Preserve the current objective, decisions, progress, blockers, and concrete next steps.",
	);
});
```

Each test names a production mutation that it catches. The settings tests catch wrong precedence and invalid-value fallback. The trigger test catches a missing guard. The transition test catches repeated attempts.

- [ ] **Step 2: Run the pure-policy test and observe the expected failure**

Run:

```sh
node --test --experimental-strip-types tests/extensions/handoff-auto.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `extensions/handoff-auto.ts`.

- [ ] **Step 3: Implement the minimal pure-policy module**

Create `extensions/handoff-auto.ts` with these public shapes:

```ts
export const DEFAULT_AUTO_THRESHOLD_TOKENS = 150_000;
export const AUTO_HANDOFF_COUNTDOWN_SECONDS = 5;
export const AUTO_HANDOFF_GOAL =
	"Continue the current task in a fresh session. Preserve the current objective, decisions, progress, blockers, and concrete next steps.";

export type AutoHandoffState = "armed" | "running" | "disabled";

export type ParsedHandoffCommand =
	| { kind: "missing-goal" }
	| { kind: "manual"; goal: string }
	| { kind: "internal-auto" }
	| { kind: "auto-control"; action: "on" | "off" | "status" };

export type HandoffSettingsSources = {
	globalSettings: unknown;
	projectSettings?: unknown;
	projectTrusted: boolean;
};

export type AutoHandoffTriggerInput = {
	mode: string;
	idle: boolean;
	state: AutoHandoffState;
	usageTokens: number | undefined;
	thresholdTokens: number;
};

export type AutoHandoffEvent =
	| { type: "session-start" }
	| { type: "threshold-reached" }
	| { type: "auto-off" }
	| { type: "attempt-failed" }
	| { type: "auto-on"; usageTokens: number | undefined; thresholdTokens: number };
```

Use a property-presence helper so an invalid trusted project value does not fall back to the global value:

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readThresholdSetting(settings: unknown): { present: boolean; value?: unknown } {
	if (!isRecord(settings) || !isRecord(settings.handoff)) return { present: false };
	if (!Object.prototype.hasOwnProperty.call(settings.handoff, "autoThresholdTokens")) {
		return { present: false };
	}
	return { present: true, value: settings.handoff.autoThresholdTokens };
}

export function resolveAutoThresholdTokens(sources: HandoffSettingsSources): number {
	const globalValue = readThresholdSetting(sources.globalSettings);
	const projectValue = sources.projectTrusted
		? readThresholdSetting(sources.projectSettings)
		: { present: false };
	const effective = projectValue.present ? projectValue : globalValue;
	return effective.present &&
		typeof effective.value === "number" &&
		Number.isFinite(effective.value) &&
		effective.value > 0
		? effective.value
		: DEFAULT_AUTO_THRESHOLD_TOKENS;
}
```

Implement the parser and state rules directly:

```ts
export function parseHandoffCommand(args: string): ParsedHandoffCommand {
	const value = args.trim();
	if (!value) return { kind: "missing-goal" };
	if (value === "--auto") return { kind: "internal-auto" };
	if (value === "auto on") return { kind: "auto-control", action: "on" };
	if (value === "auto off") return { kind: "auto-control", action: "off" };
	if (value === "auto status") return { kind: "auto-control", action: "status" };
	return { kind: "manual", goal: value };
}

export function shouldTriggerAutoHandoff(input: AutoHandoffTriggerInput): boolean {
	return input.mode === "tui" &&
		input.idle &&
		input.state === "armed" &&
		input.usageTokens !== undefined &&
		input.usageTokens >= input.thresholdTokens;
}

export function transitionAutoHandoffState(
	_state: AutoHandoffState,
	event: AutoHandoffEvent,
): AutoHandoffState {
	switch (event.type) {
		case "session-start":
			return "armed";
		case "threshold-reached":
			return "running";
		case "auto-off":
		case "attempt-failed":
			return "disabled";
		case "auto-on":
			return event.usageTokens !== undefined && event.usageTokens >= event.thresholdTokens
				? "running"
				: "armed";
	}
}
```

Add this final default export because Pi loads every top-level TypeScript file as an extension:

```ts
export default function handoffAutoPolicyExtension(): void {}
```

The default export must register no event, command, tool, timer, or UI component.

- [ ] **Step 4: Run the pure-policy test and make sure that it passes**

Run:

```sh
node --test --experimental-strip-types tests/extensions/handoff-auto.test.ts
```

Expected: PASS with `# fail 0`.

- [ ] **Step 5: Run the extension-load check for the new top-level module**

Run:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: PASS. Pi loads `handoff-auto.ts` as a valid no-op extension factory.

- [ ] **Step 6: Commit the pure policy**

```sh
git add extensions/handoff-auto.ts tests/extensions/handoff-auto.test.ts
git commit -m "feat(handoff): add automatic handoff policy"
```

---

### Task 2: Add Testable Boundaries Without Changing Manual Handoff

**Files:**
- Modify: `extensions/handoff.ts:15-199`
- Create: `tests/extensions/handoff.test.ts`

**Interfaces:**
- Consumes: Existing manual command behavior and Pi command contexts.
- Produces: `HandoffDependencies`, `registerHandoffExtension()`, an injected prompt generator, and unchanged default export behavior.

- [ ] **Step 1: Write manual regression tests first**

Create `tests/extensions/handoff.test.ts`. Import the named factory and build a fake Pi harness:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
	registerHandoffExtension,
	type HandoffDependencies,
} from "../../extensions/handoff.ts";

type CommandHandler = (args: string, ctx: any) => Promise<void>;
type EventHandler = (event: any, ctx: any) => Promise<void> | void;

function createHarness(overrides: Partial<HandoffDependencies> = {}) {
	let commandHandler: CommandHandler | undefined;
	const events = new Map<string, EventHandler>();
	const sentMessages: Array<{ content: string; options: unknown }> = [];
	const dependencies: HandoffDependencies = {
		generatePrompt: async () => "generated prompt",
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
			sentMessages.push({ content, options });
		},
	};
	registerHandoffExtension(pi as any, dependencies);
	assert.ok(commandHandler);
	return { commandHandler, events, sentMessages };
}

function createCommandContext(options: {
	usageTokens?: number;
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
```

Add these manual behavior tests:

```ts
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
```

- [ ] **Step 2: Run the manual regression tests and observe the expected failure**

Run:

```sh
node --test --experimental-strip-types tests/extensions/handoff.test.ts
```

Expected: FAIL because `registerHandoffExtension` and `HandoffDependencies` do not exist.

- [ ] **Step 3: Replace static runtime imports with injected boundaries**

Keep the external imports type-only at module load:

```ts
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai/compat";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
```

Define these boundaries:

```ts
export type HandoffDependencies = {
	generatePrompt: (input: {
		ctx: ExtensionCommandContext;
		messages: AgentMessage[];
		goal: string;
	}) => Promise<string | null>;
};
```

Move the current loader and model code into `defaultDependencies.generatePrompt`. Use dynamic imports inside the function:

```ts
const defaultDependencies: HandoffDependencies = {
	generatePrompt: async ({ ctx, messages, goal }) => {
		const [{ uuidv7 }, { complete }, { BorderedLoader, convertToLlm, serializeConversation }] =
			await Promise.all([
				import("@earendil-works/pi-ai"),
				import("@earendil-works/pi-ai/compat"),
				import("@earendil-works/pi-coding-agent"),
			]);
		const conversationText = serializeConversation(convertToLlm(messages));
		return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, "Generating handoff prompt...");
			loader.onAbort = () => done(null);
			const generate = async () => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
				if (!auth.ok || !auth.apiKey) {
					throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error);
				}
				const userMessage: Message = {
					role: "user",
					content: [{
						type: "text",
						text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
					}],
					timestamp: Date.now(),
				};
				const response = await complete(
					ctx.model!,
					{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						env: auth.env,
						signal: loader.signal,
						cacheRetention: "none",
						sessionId: uuidv7(),
					},
				);
				if (response.stopReason === "aborted") return null;
				return response.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join("\n");
			};
			generate().then(done).catch((error) => {
				console.error("Handoff generation failed:", error);
				done(null);
			});
			return loader;
		});
	},
};
```

Keep `SYSTEM_PROMPT`, `entryToMessage()`, and `getHandoffMessages()` behavior unchanged.

- [ ] **Step 4: Export the named registration function**

Use this factory shape:

```ts
export function registerHandoffExtension(
	pi: ExtensionAPI,
	dependencies: HandoffDependencies = defaultDependencies,
): void {
	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
				return;
			}
			const messages = getHandoffMessages(ctx.sessionManager.getBranch());
			if (messages.length === 0) {
				ctx.ui.notify("No conversation to hand off", "error");
				return;
			}
			const currentSessionFile = ctx.sessionManager.getSessionFile();
			const generatedPrompt = await dependencies.generatePrompt({ ctx, messages, goal });
			if (generatedPrompt === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			const editedPrompt = await ctx.ui.editor("Edit handoff prompt", generatedPrompt);
			if (editedPrompt === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			const newSessionResult = await ctx.newSession({
				parentSession: currentSessionFile,
				withSession: async (replacementCtx) => {
					replacementCtx.ui.setEditorText(editedPrompt);
					replacementCtx.ui.notify("Handoff ready. Submit when ready.", "info");
				},
			});
			if (newSessionResult.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
			}
		},
	});
}

export default registerHandoffExtension;
```

The manual handler must call `dependencies.generatePrompt()`. It must still call `ctx.ui.editor()` before `ctx.newSession()`.

Capture `editedPrompt` and `currentSessionFile` as strings before replacement. Use only `replacementCtx` inside `withSession`:

```ts
const newSessionResult = await ctx.newSession({
	parentSession: currentSessionFile,
	withSession: async (replacementCtx) => {
		replacementCtx.ui.setEditorText(editedPrompt);
		replacementCtx.ui.notify("Handoff ready. Submit when ready.", "info");
	},
});
if (newSessionResult.cancelled) {
	ctx.ui.notify("New session cancelled", "info");
}
```

Do not add automatic behavior in this task.

- [ ] **Step 5: Run the manual tests and make sure that they pass**

Run:

```sh
node --test --experimental-strip-types tests/extensions/handoff.test.ts
```

Expected: PASS with `# fail 0`.

- [ ] **Step 6: Run both focused files**

Run:

```sh
node --test --experimental-strip-types \
  tests/extensions/handoff-auto.test.ts \
  tests/extensions/handoff.test.ts
```

Expected: PASS with `# fail 0`.

- [ ] **Step 7: Commit the testable manual flow**

```sh
git add extensions/handoff.ts tests/extensions/handoff.test.ts
git commit -m "refactor(handoff): isolate extension side effects"
```

---

### Task 3: Add Settings Loading, Controls, and Settled-Event Dispatch

**Files:**
- Modify: `extensions/handoff.ts`
- Modify: `tests/extensions/handoff.test.ts`

**Interfaces:**
- Consumes: Pure policy exports from Task 1 and injected shell boundaries from Task 2.
- Produces: Per-session threshold state, `/handoff auto on|off|status`, and guarded `/handoff --auto` dispatch.

- [ ] **Step 1: Add failing settled-event tests**

Extend `HandoffDependencies` and the harness with this settings boundary before writing the tests:

```ts
loadSettings: (ctx: ExtensionContext) => Promise<HandoffSettingsSources>;
```

Use this harness default:

```ts
loadSettings: async () => ({ globalSettings: {}, projectTrusted: false }),
```

Also extend the harness so `sendUserMessage()` can throw. Add a `sendError` option and throw it before recording the message.

Add separate tests for these behaviors:

```ts
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
```

Add one dispatch-error test. Make sure that status reports `disabled` after `sendUserMessage()` throws.

- [ ] **Step 2: Add failing control-command tests**

Use a literal threshold of `100`. Add these control tests:

```ts
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
```

The tests match state and threshold values. They do not lock decorative notice wording.

- [ ] **Step 3: Run the integration test and observe the expected failures**

Run:

```sh
node --test --experimental-strip-types tests/extensions/handoff.test.ts
```

Expected: FAIL because no event handlers or automatic controls are registered.

- [ ] **Step 4: Implement trusted settings loading**

Import the Node file APIs at runtime-safe module scope:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
```

Import `HandoffSettingsSources` from `handoff-auto.ts`. Add `loadSettings` to `HandoffDependencies`:

```ts
loadSettings: (ctx: ExtensionContext) => Promise<HandoffSettingsSources>;
```

Add the concrete boundary to `defaultDependencies`:

```ts
loadSettings: loadHandoffSettings,
```

Implement the default settings boundary. Never read project settings before trust is active:

```ts
async function readJsonSettings(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

async function loadHandoffSettings(ctx: ExtensionContext): Promise<HandoffSettingsSources> {
	const { CONFIG_DIR_NAME, getAgentDir } = await import("@earendil-works/pi-coding-agent");
	const projectTrusted = ctx.isProjectTrusted();
	return {
		globalSettings: await readJsonSettings(join(getAgentDir(), "settings.json")),
		projectSettings: projectTrusted
			? await readJsonSettings(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"))
			: undefined,
		projectTrusted,
	};
}
```

Use the pure resolver after every `session_start`. Reset state before the asynchronous read:

```ts
let autoState: AutoHandoffState = "armed";
let autoThresholdTokens = DEFAULT_AUTO_THRESHOLD_TOKENS;

pi.on("session_start", async (_event, ctx) => {
	autoState = transitionAutoHandoffState(autoState, { type: "session-start" });
	autoThresholdTokens = DEFAULT_AUTO_THRESHOLD_TOKENS;
	try {
		const settings = await dependencies.loadSettings(ctx);
		autoThresholdTokens = resolveAutoThresholdTokens(settings);
	} catch {
		// Keep the documented default and armed state.
	}
});
```

If the injected settings boundary throws, keep the default threshold and armed state. Do not stop Pi startup.

- [ ] **Step 5: Implement one guarded dispatch helper**

Use the helper for `agent_settled` and `auto on`:

```ts
const dispatchAutomaticHandoff = (ctx: ExtensionContext): void => {
	try {
		pi.sendUserMessage("/handoff --auto", { expandPromptTemplates: true });
	} catch (error) {
		autoState = transitionAutoHandoffState(autoState, { type: "attempt-failed" });
		if (ctx.mode === "tui") {
			ctx.ui.notify(
				`Automatic handoff failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	}
};
```

Set `running` before this helper runs.

- [ ] **Step 6: Register the settled handler**

```ts
pi.on("agent_settled", async (_event, ctx) => {
	const usage = ctx.getContextUsage();
	if (!shouldTriggerAutoHandoff({
		mode: ctx.mode,
		idle: ctx.isIdle(),
		state: autoState,
		usageTokens: usage?.tokens,
		thresholdTokens: autoThresholdTokens,
	})) return;

	autoState = transitionAutoHandoffState(autoState, { type: "threshold-reached" });
	dispatchAutomaticHandoff(ctx);
});
```

Do not call `ctx.newSession()` from this event.

- [ ] **Step 7: Route automatic controls before model and goal validation**

Parse the command before the existing model check:

```ts
const command = parseHandoffCommand(args);
```

Implement these control effects:

```ts
if (command.kind === "auto-control") {
	if (command.action === "off") {
		autoState = transitionAutoHandoffState(autoState, { type: "auto-off" });
		ctx.ui.notify("Automatic handoff is disabled.", "info");
		return;
	}
	if (command.action === "status") {
		ctx.ui.notify(
			`Automatic handoff is ${autoState}. Threshold: ${autoThresholdTokens} tokens.`,
			"info",
		);
		return;
	}
	const usage = ctx.getContextUsage();
	autoState = transitionAutoHandoffState(autoState, {
		type: "auto-on",
		usageTokens: usage?.tokens,
		thresholdTokens: autoThresholdTokens,
	});
	ctx.ui.notify(`Automatic handoff is ${autoState}.`, "info");
	if (autoState === "running") dispatchAutomaticHandoff(ctx);
	return;
}
```

Keep the existing TUI mode guard. Controls do not require a selected model or conversation messages.

Until Task 4 adds the automatic flow, return immediately for `internal-auto`. Route `missing-goal` to the current usage notice. Route only `manual` to the current model, generation, editor, and replacement flow:

```ts
if (command.kind === "internal-auto") return;
if (command.kind === "missing-goal") {
	ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
	return;
}
const goal = command.goal;
```

- [ ] **Step 8: Run the focused integration test and make sure that it passes**

Run:

```sh
node --test --experimental-strip-types tests/extensions/handoff.test.ts
```

Expected: PASS with `# fail 0`.

- [ ] **Step 9: Run both focused test files**

Run:

```sh
node --test --experimental-strip-types \
  tests/extensions/handoff-auto.test.ts \
  tests/extensions/handoff.test.ts
```

Expected: PASS with `# fail 0`.

- [ ] **Step 10: Commit controls and dispatch**

```sh
git add extensions/handoff.ts tests/extensions/handoff.test.ts
git commit -m "feat(handoff): trigger automatic handoff by usage"
```

---

### Task 4: Add the Countdown and Automatic Replacement Flow

**Files:**
- Modify: `extensions/handoff.ts`
- Modify: `tests/extensions/handoff.test.ts`

**Interfaces:**
- Consumes: The `running` state and internal dispatch from Task 3.
- Produces: Five-second Escape cancellation, automatic prompt generation, parent tracking, replacement-session submission, and failure suppression.

- [ ] **Step 1: Add failing countdown-result tests**

Extend `HandoffDependencies` and the harness with this countdown boundary before writing the tests:

```ts
showAutoCountdown: (ctx: ExtensionCommandContext) => Promise<boolean>;
```

Use the harness's `replacementUserMessages` observation to distinguish submission from editor staging.

Use `showAutoCountdown: async () => true` as the harness default. Start the internal command by first reaching the threshold through `agent_settled`.

Add these tests:

```ts
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
```

- [ ] **Step 2: Add failing replacement-safety tests**

Add this successful replacement test:

```ts
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
```

Add a stale-context test. Change the fake `newSession()` implementation before it calls `withSession`:

```ts
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
```

The first test catches a wrong parent, modal review, or missing prompt submission. The second catches old-context access after replacement.

Add a rejecting replacement-submission test. Use a deferred `sendUserMessage()` promise to prove the command awaits submission. After rejecting it, assert that the callback uses only `replacementCtx`, stages the generated prompt, and shows an error that includes the submission failure.

- [ ] **Step 3: Add failing automatic-error tests**

Add this table and test loop:

```ts
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
```

Each case reaches the real command path. Only the timer, model, and switch boundaries use doubles.

- [ ] **Step 4: Run the integration test and observe the expected failures**

Run:

```sh
node --test --experimental-strip-types tests/extensions/handoff.test.ts
```

Expected: FAIL because `--auto` still lacks countdown and automatic-flow behavior.

- [ ] **Step 5: Implement the real five-second countdown boundary**

Use a custom TUI component because built-in timed dialogs auto-cancel at zero. The approved flow must continue at zero.

Add `showAutoCountdown` to `HandoffDependencies`:

```ts
showAutoCountdown: (ctx: ExtensionCommandContext) => Promise<boolean>;
```

Add `showAutoCountdown` to `defaultDependencies`. Then implement the default boundary:

```ts
async function showAutoCountdown(ctx: ExtensionCommandContext): Promise<boolean> {
	const { Key, matchesKey, truncateToWidth } = await import("@earendil-works/pi-tui");
	return ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
		let remaining = AUTO_HANDOFF_COUNTDOWN_SECONDS;
		let finished = false;
		let timer: ReturnType<typeof setInterval>;
		const finish = (result: boolean) => {
			if (finished) return;
			finished = true;
			clearInterval(timer);
			done(result);
		};
		timer = setInterval(() => {
			remaining -= 1;
			if (remaining <= 0) {
				finish(true);
				return;
			}
			tui.requestRender();
		}, 1000);
		return {
			render: (width: number) => [
				truncateToWidth(
					theme.fg("warning", `Automatic handoff starts in ${remaining}s. Press Esc to cancel.`),
					width,
				),
			],
			handleInput: (data: string) => {
				if (matchesKey(data, Key.escape)) finish(false);
			},
			invalidate: () => {},
		};
	});
}
```

The timer must stop on both cancellation and completion. Tests continue to inject an immediate boundary, so they never wait five seconds.

- [ ] **Step 6: Implement the internal automatic command**

Reject `--auto` unless state is `running`. Then run the countdown before model, context, or generation work:

```ts
if (command.kind === "internal-auto") {
	if (autoState !== "running") return;
	const continueHandoff = await dependencies.showAutoCountdown(ctx);
	if (!continueHandoff) {
		autoState = transitionAutoHandoffState(autoState, { type: "attempt-failed" });
		ctx.ui.notify("Automatic handoff cancelled. Run /handoff auto on to re-enable it.", "info");
		return;
	}
	await performHandoff(AUTO_HANDOFF_GOAL, true, ctx);
	return;
}
```

The automatic goal must be the exported constant. Do not add a second goal-inference model call.

- [ ] **Step 7: Share prompt generation but keep mode-specific review**

Extract one local `performHandoff(goal, automatic, ctx)` function inside `registerHandoffExtension()`.

Use this order:

1. Make sure that a model exists.
2. Collect `getHandoffMessages(ctx.sessionManager.getBranch())`.
3. Make sure that at least one message exists.
4. Capture `currentSessionFile` before replacement.
5. Call the injected generator.
6. Disable automatic mode on a throw, `null`, or empty text.
7. In manual mode, call `ctx.ui.editor()` and preserve cancellation behavior.
8. In automatic mode, use the generated prompt without opening the editor modal.
9. Call `ctx.newSession()` with `parentSession`.
10. Submit the automatic prompt, or stage the manual prompt, through `replacementCtx` only.
11. Catch automatic submission failures inside `withSession`, stage the prompt, and notify through `replacementCtx`.

Use one automatic-error helper before replacement:

```ts
const disableAutomatic = (
	ctx: ExtensionCommandContext,
	message: string,
	level: "info" | "error" = "error",
): void => {
	autoState = transitionAutoHandoffState(autoState, { type: "attempt-failed" });
	ctx.ui.notify(`${message} Run /handoff auto on to re-enable it.`, level);
};
```

Do not call this helper after a successful replacement. The old command context is stale at that point.

Use this replacement shape for both modes:

```ts
const stagedPrompt = automatic ? generatedPrompt : editedPrompt;
const parentSession = currentSessionFile;
const newSessionResult = await ctx.newSession({
	parentSession,
	withSession: async (replacementCtx) => {
		if (automatic) {
			try {
				await replacementCtx.sendUserMessage(stagedPrompt);
			} catch (error) {
				replacementCtx.ui.setEditorText(stagedPrompt);
				replacementCtx.ui.notify(
					`Automatic handoff submission failed: ${error instanceof Error ? error.message : String(error)}. Prompt staged; submit when ready.`,
					"error",
				);
			}
			return;
		}
		replacementCtx.ui.setEditorText(stagedPrompt);
		replacementCtx.ui.notify("Handoff ready. Submit when ready.", "info");
	},
});
if (newSessionResult.cancelled) {
	if (automatic) {
		disableAutomatic(ctx, "New session cancelled.", "info");
	} else {
		ctx.ui.notify("New session cancelled", "info");
	}
	return;
}
return;
```

Wrap `ctx.newSession()` so a thrown switch error follows the same automatic-disable rule. Manual mode keeps a short error notice and the current session.

- [ ] **Step 8: Run the focused integration test and make sure that it passes**

Run:

```sh
node --test --experimental-strip-types tests/extensions/handoff.test.ts
```

Expected: PASS with `# fail 0`. The test process must finish immediately and must not wait five seconds.

- [ ] **Step 9: Run both focused test files**

Run:

```sh
node --test --experimental-strip-types \
  tests/extensions/handoff-auto.test.ts \
  tests/extensions/handoff.test.ts
```

Expected: PASS with `# fail 0`.

- [ ] **Step 10: Commit the automatic flow**

```sh
git add extensions/handoff.ts tests/extensions/handoff.test.ts
git commit -m "feat(handoff): submit automatic replacement prompts"
```

---

### Task 5: Configure the Threshold and Strengthen Runtime Loading

**Files:**
- Modify: `settings.json:1-68`
- Modify: `modules/checks/pi-config-extension-load.nix:39-45`

**Interfaces:**
- Consumes: The setting parser and top-level no-op extension factory.
- Produces: A shipped 150,000-token setting and a runtime check for invalid extension factories.

This task changes static settings and a Nix check. Do not add a source-text test. Use JSON parsing and the real Nix runtime check.

- [ ] **Step 1: Add the global handoff setting**

Add this top-level object after the default model settings:

```json
"handoff": {
  "autoThresholdTokens": 150000
},
```

Do not add `compaction.enabled: false`. Existing Pi compaction settings remain unchanged.

- [ ] **Step 2: Parse the JSON settings directly**

Run:

```sh
python -m json.tool settings.json >/dev/null
```

Expected: exit status 0 and no output.

Then run:

```sh
python - <<'PY'
import json
from pathlib import Path
settings = json.loads(Path("settings.json").read_text())
assert settings["handoff"]["autoThresholdTokens"] == 150000
assert settings.get("compaction", {}).get("enabled", True) is True
PY
```

Expected: exit status 0 and no output.

- [ ] **Step 3: Reject invalid top-level extension factories in the Nix check**

Add this fixed failure text to `check_load_failures()`:

```nix
"Extension does not export a valid factory function" \
```

Place it beside the existing `Failed to load extension` test. This makes the check catch a missing no-op default export in `handoff-auto.ts`.

- [ ] **Step 4: Run the focused tests after the settings change**

Run:

```sh
node --test --experimental-strip-types \
  tests/extensions/handoff-auto.test.ts \
  tests/extensions/handoff.test.ts
```

Expected: PASS with `# fail 0`.

- [ ] **Step 5: Run the Home Manager-like extension-load check**

Run:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: PASS. The output must not contain any of these messages:

- `Failed to load extension`
- `Extension does not export a valid factory function`
- `No such built-in module`
- `Cannot find package`

- [ ] **Step 6: Commit settings and runtime loading**

```sh
git add settings.json modules/checks/pi-config-extension-load.nix
git commit -m "config(handoff): set automatic handoff threshold"
```

---

### Task 6: Run Final Automated and Interactive Verification

**Files:**
- Verify: `extensions/handoff.ts`
- Verify: `extensions/handoff-auto.ts`
- Verify: `tests/extensions/handoff.test.ts`
- Verify: `tests/extensions/handoff-auto.test.ts`
- Verify: `settings.json`
- Verify: `modules/checks/pi-config-extension-load.nix`
- Temporary: `.pi/settings.json`

**Interfaces:**
- Consumes: All implementation commits.
- Produces: Completion evidence. This task adds no production interface.

- [ ] **Step 1: Run the focused test suite from a clean process**

Run:

```sh
node --test --experimental-strip-types \
  tests/extensions/handoff-auto.test.ts \
  tests/extensions/handoff.test.ts
```

Expected: PASS with `# fail 0` and no timer delay.

- [ ] **Step 2: Run repository and whitespace checks**

Run:

```sh
git diff --check
git status --short
```

Expected: `git diff --check` exits 0. The status is clean after the planned commits.

- [ ] **Step 3: Run the extension-load check again**

Run:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: PASS.

- [ ] **Step 4: Run the full flake check**

Run:

```sh
nix flake check --accept-flake-config --print-build-logs
```

Expected: PASS for every flake check. Save the failing derivation and error lines if any check fails.

- [ ] **Step 5: Smoke-test cancellation and re-enabling above the threshold**

Create an ignored trusted-project override:

```sh
mkdir -p .pi
cat > .pi/settings.json <<'JSON'
{
  "handoff": {
    "autoThresholdTokens": 1
  }
}
JSON
```

Start Pi with only the worktree extension:

```sh
pi --no-extensions --extension ./extensions/handoff.ts --approve
```

Perform these actions in the TUI:

1. Send `Reply with exactly ready.`
2. Make sure that the five-second countdown appears after the agent settles.
3. Press Escape before zero.
4. Run `/handoff auto status`.
5. Make sure that the state is `disabled`.
6. Send another short prompt.
7. Make sure that no second countdown appears.
8. Run `/handoff auto on`.
9. Make sure that the countdown starts immediately.
10. Let the countdown reach zero.
11. Make sure that Pi opens a child session.
12. Do not press Enter or provide other keyboard input.
13. Make sure that the generated prompt is submitted in the child session.
14. Make sure that the child agent starts its response.
15. Exit Pi.

Expected: Escape cancels once. Suppression prevents repeats. Re-enabling above the threshold starts immediately. The completed flow submits the generated prompt and continues without keyboard input.

Remove the temporary settings:

```sh
rm -f .pi/settings.json
rmdir .pi 2>/dev/null || true
```

- [ ] **Step 6: Smoke-test the manual regression path**

Create a high temporary threshold:

```sh
mkdir -p .pi
cat > .pi/settings.json <<'JSON'
{
  "handoff": {
    "autoThresholdTokens": 999999999
  }
}
JSON
```

Start Pi again:

```sh
pi --no-extensions --extension ./extensions/handoff.ts --approve
```

Perform these actions:

1. Send `Reply with exactly ready.`
2. Run `/handoff Continue this smoke test in a fresh session.`
3. Make sure that the modal editor contains the generated prompt.
4. Add `MANUAL-SMOKE` to the prompt.
5. Accept the modal editor.
6. Make sure that the child-session editor contains `MANUAL-SMOKE`.
7. Make sure that Pi does not submit the prompt.
8. Exit Pi without pressing Enter.

Expected: The manual review-and-edit flow remains unchanged.

Remove the temporary settings:

```sh
rm -f .pi/settings.json
rmdir .pi 2>/dev/null || true
```

- [ ] **Step 7: Make sure that compaction remains a fallback**

Run:

```sh
python - <<'PY'
import json
from pathlib import Path
settings = json.loads(Path("settings.json").read_text())
assert settings.get("compaction", {}).get("enabled", True) is True
PY
```

Then inspect the implementation diff:

```sh
git diff 8b29085..HEAD -- extensions/handoff.ts extensions/handoff-auto.ts settings.json
```

Expected: No compaction event registration, compaction cancellation, or `compaction.enabled: false` change exists.

This direct inspection is correct for the non-goal. An automated source-text test does not prove runtime behavior.

- [ ] **Step 8: Record final branch evidence**

Run:

```sh
git status --short
git log --oneline --decorate 8b29085..HEAD
```

Expected: The worktree is clean. The log contains these five implementation boundaries:

1. `feat(handoff): add automatic handoff policy`
2. `refactor(handoff): isolate extension side effects`
3. `feat(handoff): trigger automatic handoff by usage`
4. `feat(handoff): submit automatic replacement prompts`
5. `config(handoff): set automatic handoff threshold`

If any verification exposes a behavior defect, write a failing regression test first. Apply the smallest fix, rerun all checks, and commit that fix separately.
