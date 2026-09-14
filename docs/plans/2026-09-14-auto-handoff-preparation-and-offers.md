# Prepared Automatic Handoff and Open Recommendation Re-Offer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every accepted automatic handoff run a conditional todo-preparation turn before generation, then proactively re-offer unanswered recommendations in the replacement session.

**Architecture:** Extend the pure automatic policy with explicit countdown, preparation, and finalization phases. Keep `handoff.ts` as the runtime orchestrator: it snapshots the source conversation, starts an internal preparation turn, collects later preparation messages, and only then invokes generation from a command context. Extend `handoff-generation.ts` with a separate preparation input and an `OFFER` action so runtime delivery never has to parse generated Markdown.

**Tech Stack:** TypeScript, Pi extension APIs, `node:test`, `node:assert/strict`, Nix flake checks.

## Global Constraints

- Every accepted automatic handoff must run preparation before prompt generation.
- The preparation turn must instruct the agent to use the todo tool when detailed requirements or context warrant durable storage.
- The preparation turn must not create placeholder, duplicate, speculative, or unnecessary todos.
- Automatic action selection and recommendation recency must use the pre-preparation user conversation, not the internal preparation transcript.
- `CONTINUE` takes priority only when explicit unfinished work can proceed without user input.
- `OFFER` takes priority over `WAIT` when no executable request takes priority and recommendations remain open.
- A final unanswered offer must be re-asked directly.
- An unanswered offer followed by unrelated user messages must use a one-sentence summary of only the latest relevant user topic before the reminder.
- The replacement agent must not act on a recommendation before the user accepts it.
- Manual `/handoff <goal>`, the 150,000-token default, the five-second countdown, and Pi compaction behavior must remain unchanged.
- Exact prompt-policy prose is verified by source review, not by new tests that merely assert static strings.
- The known baseline failure in `checks.x86_64-linux.jailed-github-broker` is being fixed separately; report it accurately if it remains during final verification.

---

### Task 1: Model the automatic preparation phases

**Files:**
- Modify: `extensions/handoff-auto.ts:4-31,59-90`
- Test: `tests/extensions/handoff-auto.test.ts:63-117`

**Interfaces:**
- Consumes: Existing `parseHandoffCommand()`, `shouldTriggerAutoHandoff()`, and `transitionAutoHandoffState()` callers in `extensions/handoff.ts`.
- Produces:
  - `AutoHandoffState = "armed" | "countdown" | "preparing" | "finalizing" | "disabled"`
  - `ParsedHandoffCommand` variant `{ kind: "internal-auto-finalize" }`
  - `AutoHandoffEvent` variants `{ type: "preparation-started" }` and `{ type: "preparation-settled" }`
  - `threshold-reached` and threshold-level `auto-on` transitions to `countdown`
  - `preparation-started` transition to `preparing`
  - `preparation-settled` transition to `finalizing`

- [ ] **Step 1: Write failing parser and state-policy tests**

Update the command test to include finalization and replace the old `running` expectations:

```typescript
test("parses internal, control, missing, and manual command forms", () => {
	assert.deepEqual(parseHandoffCommand("--auto"), { kind: "internal-auto" });
	assert.deepEqual(parseHandoffCommand("--auto-finalize"), { kind: "internal-auto-finalize" });
	assert.deepEqual(parseHandoffCommand("auto on"), { kind: "auto-control", action: "on" });
	assert.deepEqual(parseHandoffCommand("auto off"), { kind: "auto-control", action: "off" });
	assert.deepEqual(parseHandoffCommand("auto status"), { kind: "auto-control", action: "status" });
	assert.deepEqual(parseHandoffCommand(""), { kind: "missing-goal" });
	assert.deepEqual(parseHandoffCommand("continue phase one"), {
		kind: "manual",
		goal: "continue phase one",
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
	assert.equal(shouldTriggerAutoHandoff({ ...ready, state: "countdown" }), false);
	assert.equal(shouldTriggerAutoHandoff({ ...ready, state: "preparing" }), false);
	assert.equal(shouldTriggerAutoHandoff({ ...ready, state: "finalizing" }), false);
	assert.equal(shouldTriggerAutoHandoff({ ...ready, state: "disabled" }), false);
});

test("applies every approved automatic phase transition", () => {
	assert.equal(transitionAutoHandoffState("disabled", { type: "session-start" }), "armed");
	assert.equal(transitionAutoHandoffState("armed", { type: "threshold-reached" }), "countdown");
	assert.equal(transitionAutoHandoffState("countdown", { type: "preparation-started" }), "preparing");
	assert.equal(transitionAutoHandoffState("preparing", { type: "preparation-settled" }), "finalizing");
	assert.equal(transitionAutoHandoffState("preparing", { type: "auto-off" }), "disabled");
	assert.equal(transitionAutoHandoffState("finalizing", { type: "attempt-failed" }), "disabled");
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
		"countdown",
	);
});
```

Keep the existing threshold-setting assertions and the manual string `auto investigate the parser` assertion.

- [ ] **Step 2: Run the focused policy test and confirm the expected failure**

Run:

```sh
node --test --experimental-strip-types tests/extensions/handoff-auto.test.ts
```

Expected: FAIL because `--auto-finalize` is still parsed as a manual goal and the new state names/events do not exist.

- [ ] **Step 3: Implement the minimal state and parser changes**

Change the public unions and switch cases in `extensions/handoff-auto.ts`:

```typescript
export type AutoHandoffState =
	| "armed"
	| "countdown"
	| "preparing"
	| "finalizing"
	| "disabled";

export type ParsedHandoffCommand =
	| { kind: "missing-goal" }
	| { kind: "manual"; goal: string }
	| { kind: "internal-auto" }
	| { kind: "internal-auto-finalize" }
	| { kind: "auto-control"; action: "on" | "off" | "status" };

export type AutoHandoffEvent =
	| { type: "session-start" }
	| { type: "threshold-reached" }
	| { type: "preparation-started" }
	| { type: "preparation-settled" }
	| { type: "auto-off" }
	| { type: "attempt-failed" }
	| { type: "auto-on"; usageTokens: number | undefined; thresholdTokens: number };
```

Parse `--auto-finalize` before falling back to a manual goal. Return `countdown`, `preparing`, and `finalizing` from the corresponding transition cases. Keep `shouldTriggerAutoHandoff()` restricted to `armed`.

- [ ] **Step 4: Run the focused policy test and confirm it passes**

Run:

```sh
node --test --experimental-strip-types tests/extensions/handoff-auto.test.ts
```

Expected: PASS with no failing tests.

- [ ] **Step 5: Commit the state-policy change**

```sh
git add extensions/handoff-auto.ts tests/extensions/handoff-auto.test.ts
git commit -m "feat(handoff): model automatic preparation phases"
```

---

### Task 2: Add separate preparation context and the `OFFER` generation action

**Files:**
- Modify: `extensions/handoff-generation.ts:5-24,42-124,150-170,194-226`
- Test: `tests/extensions/handoff-generation.test.ts:150-286`

**Interfaces:**
- Consumes: `AgentMessage[]` source messages and the existing direct-completion runtime.
- Produces:
  - `HandoffGenerationContext.preparationMessages?: AgentMessage[]`
  - `HandoffAction = "continue" | "offer" | "wait"`
  - Automatic request blocks `## User Conversation` and `## Automatic Handoff Preparation`
  - Parsed `HANDOFF_ACTION: OFFER` result `{ action: "offer", prompt: string }`
- Preserves: Legacy manual overload behavior and manual request text.

- [ ] **Step 1: Extend the action parser test with `OFFER`**

Change the existing action table:

```typescript
for (const [label, marker, action] of [
	["continuing", "CONTINUE", "continue"],
	["offering", "OFFER", "offer"],
	["waiting", "WAIT", "wait"],
] as const) {
	test(`parses a ${label} handoff action separately from its prompt`, async () => {
		const result = await completeHandoffPrompt(
			completionContext({
				stopReason: "stop",
				content: [{ type: "text", text: `HANDOFF_ACTION: ${marker}\n\n## Context\nCheckpoint` }],
			}),
			completionUserMessage,
			new AbortController().signal,
			"handoff-session",
		);

		assert.deepEqual(result, { action, prompt: "## Context\nCheckpoint" });
	});
}
```

- [ ] **Step 2: Add a failing automatic-input separation assertion**

In `distinguishes current and legacy manual goals from automatic rollover policy`, make the fake serializer expose which message set it received:

```typescript
const runtime = {
	uuidv7: () => "handoff-session",
	BorderedLoader: FakeLoader,
	convertToLlm: (messages: unknown[]) => messages,
	serializeConversation: (messages: Array<{ content?: string }>) =>
		messages.map((message) => message.content).join(" | "),
} as any;
```

Pass a preparation message in the automatic call:

```typescript
const automaticResult = await (generation as any).generateHandoffPrompt(
	{
		ctx,
		messages: [{ role: "user", content: "current task", timestamp: 1 }],
		preparationMessages: [{
			role: "assistant",
			content: "Updated TODO-a1b2c3d4",
			timestamp: 2,
		}],
		intent: { kind: "automatic" },
	},
	async () => runtime,
);
```

Assert that the automatic model request contains distinct labeled blocks and that the manual request does not:

```typescript
const automaticText = receivedRequests[1].messages[0].content[0].text;
assert.match(automaticText, /## User Conversation\n\ncurrent task/);
assert.match(
	automaticText,
	/## Automatic Handoff Preparation\n\nUpdated TODO-a1b2c3d4/,
);
assert.doesNotMatch(receivedRequests[0].messages[0].content[0].text, /Automatic Handoff Preparation/);
```

Retain the existing assertions that current manual, automatic, and legacy manual calls return the provider result.

- [ ] **Step 3: Run the generation tests and confirm both new behaviors fail**

Run:

```sh
node --test --experimental-strip-types tests/extensions/handoff-generation.test.ts
```

Expected: FAIL because `OFFER` is invalid and the automatic request has no separate preparation block.

- [ ] **Step 4: Extend the generation types and request builder**

Add the optional preparation transcript and action:

```typescript
type HandoffGenerationContext = {
	ctx: ExtensionCommandContext;
	messages: AgentMessage[];
	preparationMessages?: AgentMessage[];
};

export type HandoffAction = "continue" | "offer" | "wait";
```

For automatic input, serialize source and preparation messages separately:

```typescript
const conversationText = serializeConversation(convertToLlm(messages));
const preparationText = input.preparationMessages?.length
	? serializeConversation(convertToLlm(input.preparationMessages))
	: "None.";
```

Change `buildHandoffRequest()` so manual mode retains `## Conversation History`, while automatic mode emits this shape:

```text
## User Conversation

<serialized source messages>

## Automatic Handoff Preparation

<serialized preparation messages or None.>

## Handoff Mode

AUTOMATIC

No new user goal was provided. Determine continuation only from explicit unfinished user-requested work in the User Conversation.
```

The preparation block is continuity evidence only. It must not become a user request.

- [ ] **Step 5: Update the generation policy**

Revise `HANDOFF_SYSTEM_PROMPT` to:

- define `OFFER` between `CONTINUE` and `WAIT`;
- make action priority explicit;
- use only `User Conversation` for unfinished work, recommendation lifecycle, and recency;
- use `Automatic Handoff Preparation` only for continuity todo IDs, notes, and failures;
- require `Continuity Todos` in all automatic output shapes;
- require `OFFER` when recommendations remain open and no executable request takes priority;
- require a direct re-ask when the offer was the last assistant message and no later user message exists;
- require a one-sentence summary of only the latest relevant user topic when later unrelated user messages exist;
- list every still-open recommendation;
- forbid acting on recommendations before user acceptance;
- preserve `WAIT` for the absence of both executable work and open recommendations.

Use these action headers:

```text
HANDOFF_ACTION: CONTINUE
HANDOFF_ACTION: OFFER
HANDOFF_ACTION: WAIT
```

Use the section layouts from `docs/specs/2026-09-14-auto-handoff-preparation-and-offers-design.md`.

- [ ] **Step 6: Parse the new action without weakening validation**

Extend the action expression in `completeHandoffPrompt()`:

```typescript
const action =
	actionLine === "HANDOFF_ACTION: CONTINUE" ? "continue"
	: actionLine === "HANDOFF_ACTION: OFFER" ? "offer"
	: actionLine === "HANDOFF_ACTION: WAIT" ? "wait"
	: undefined;
```

Keep unknown, missing, truncated, and empty output failures unchanged.

- [ ] **Step 7: Run the generation tests and confirm they pass**

Run:

```sh
node --test --experimental-strip-types tests/extensions/handoff-generation.test.ts
```

Expected: PASS with `CONTINUE`, `OFFER`, and `WAIT` covered.

- [ ] **Step 8: Commit the generation contract**

```sh
git add extensions/handoff-generation.ts tests/extensions/handoff-generation.test.ts
git commit -m "feat(handoff): generate open recommendation offers"
```

---

### Task 3: Orchestrate todo preparation before automatic finalization

**Files:**
- Modify: `extensions/handoff.ts:40-92,156-380`
- Test: `tests/extensions/handoff.test.ts:8-99,174-555`

**Interfaces:**
- Consumes:
  - Task 1 states and `{ kind: "internal-auto-finalize" }`
  - Task 2 `preparationMessages?: AgentMessage[]` and `action: "offer"`
  - Pi `sendMessage(message, { triggerTurn: true })`
  - Pi `sendUserMessage("/handoff --auto-finalize", { expandPromptTemplates: true })`
- Produces:
  - One visible custom `handoff-preparation` message per accepted automatic countdown
  - A captured automatic context containing source messages, branch boundary, and parent session file
  - Finalization only after the preparation turn settles
  - Separate source and preparation message arrays passed to `generatePrompt()`
  - `offer` delivery through replacement `sendUserMessage()`

- [ ] **Step 1: Extend the test harness for preparation messages and mutable branches**

Add a `SentCustomMessage` capture beside `sentMessages`:

```typescript
const customMessages: Array<{ message: unknown; options: unknown }> = [];
```

Extend the harness options so internal command failures and preparation-message failures can be tested independently:

```typescript
harnessOptions: { sendError?: Error; customSendError?: Error } = {},
```

Add this method to the fake `pi` object:

```typescript
sendMessage(message: unknown, options: unknown) {
	if (harnessOptions.customSendError) throw harnessOptions.customSendError;
	customMessages.push({ message, options });
},
```

Return `customMessages` from `createHarness()`.

Extend `createCommandContext()` options and branch setup:

```typescript
function createCommandContext(options: {
	usageTokens?: number | null;
	editedPrompt?: string;
	newSessionCancelled?: boolean;
	branch?: any[];
} = {}) {
	const branch = options.branch ?? [
		{ type: "message", message: { role: "user", content: "current task" } },
	];
	// ...
	sessionManager: {
		getBranch: () => branch,
		getSessionFile: () => "/sessions/old.jsonl",
	},
	// ...
	return { ctx, branch, /* existing returned fields */ };
}
```

Update `HandoffDependencies.generatePrompt` test fakes to accept `preparationMessages` through the existing destructured input type.

- [ ] **Step 2: Replace the old immediate-handoff test with a failing ordering test**

Add a test that proves generation cannot start before preparation settles:

```typescript
test("automatic handoff prepares todos before generating the prompt", async () => {
	let generated = false;
	let generationInput: any;
	const harness = createHarness({
		showAutoCountdown: async () => true,
		generatePrompt: async (input) => {
			generated = true;
			generationInput = input;
			return { action: "continue", prompt: "generated prompt" };
		},
	});
	const command = createCommandContext({ usageTokens: 150_000 });

	await harness.events.get("session_start")?.({}, command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.commandHandler("--auto", command.ctx);

	assert.equal(generated, false);
	assert.equal(command.sessionOptions.length, 0);
	assert.deepEqual(harness.customMessages.map((entry) => entry.options), [
		{ triggerTurn: true },
	]);
	assert.deepEqual(harness.customMessages.map((entry: any) => entry.message.customType), [
		"handoff-preparation",
	]);

	command.branch.push({
		type: "message",
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
```

- [ ] **Step 3: Add failing single-finalization and no-todo tests**

Add the idempotence test:

```typescript
test("preparation settlement queues automatic finalization once", async () => {
	const harness = createHarness({ showAutoCountdown: async () => true });
	const command = createCommandContext({ usageTokens: 150_000 });
	await harness.events.get("session_start")?.({}, command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.commandHandler("--auto", command.ctx);

	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);

	assert.equal(
		harness.sentMessages.filter((message) => message.content === "/handoff --auto-finalize").length,
		1,
	);
});
```

Add the conditional no-todo test:

```typescript
test("automatic finalization proceeds when preparation needs no todo", async () => {
	let receivedPreparation: unknown;
	const harness = createHarness({
		showAutoCountdown: async () => true,
		generatePrompt: async ({ preparationMessages }) => {
			receivedPreparation = preparationMessages;
			return { action: "wait", prompt: "completed checkpoint" };
		},
	});
	const command = createCommandContext({ usageTokens: 150_000 });
	await harness.events.get("session_start")?.({}, command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.commandHandler("--auto", command.ctx);
	command.branch.push({
		type: "message",
		message: { role: "assistant", content: "No continuity todo was warranted." },
	});

	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.commandHandler("--auto-finalize", command.ctx);

	assert.deepEqual(receivedPreparation, [
		{ role: "assistant", content: "No continuity todo was warranted." },
	]);
});
```

These tests prove state-driven idempotence and the approved conditional todo behavior without asserting exact preparation prose.

- [ ] **Step 4: Add failing preparation-dispatch error coverage**

Add:

```typescript
test("preparation dispatch failure disables automatic handoff", async () => {
	const harness = createHarness(
		{ showAutoCountdown: async () => true },
		{ customSendError: new Error("preparation send failed") },
	);
	const command = createCommandContext({ usageTokens: 150_000 });
	await harness.events.get("session_start")?.({}, command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.commandHandler("--auto", command.ctx);

	assert.match(command.notices.at(-1)?.message ?? "", /preparation send failed/);
	await harness.commandHandler("auto status", command.ctx);
	assert.match(command.notices.at(-1)?.message ?? "", /disabled/);
	assert.equal(command.sessionOptions.length, 0);
});
```

Keep the existing internal-command dispatch failure test for `/handoff --auto`.

- [ ] **Step 5: Add failing `OFFER` delivery and fallback tests**

Create an automatic generation fake that returns:

```typescript
{ action: "offer", prompt: "Please choose one of the open recommendations." }
```

Run the complete preparation and finalization sequence. Assert that replacement `sendUserMessage()` receives the prompt and replacement `sendMessage()` receives nothing.

Adapt the existing automatic submission-failure test to run through preparation and parameterize it for both `continue` and `offer`. Both actions must stage the prompt in the replacement editor when submission rejects.

Retain the existing `wait` assertions for `{ triggerTurn: false }`.

- [ ] **Step 6: Run the runtime tests and confirm the expected failures**

Run:

```sh
node --test --experimental-strip-types tests/extensions/handoff.test.ts
```

Expected: FAIL because the countdown still generates immediately, `sendMessage()` is unused for preparation, finalization is not parsed, and `offer` is rejected by the runtime guard.

- [ ] **Step 7: Add the preparation instruction and captured context**

In `extensions/handoff.ts`, add a private constant whose content instructs the active agent to:

```text
Prepare this session for automatic handoff. Do not continue implementation work and do not craft the final handoff prompt.

1. Review the objective, detailed requirements, acceptance criteria, decisions, constraints, progress, relevant files, blockers, and next steps.
2. Decide whether a concise handoff could safely preserve that information.
3. Use the todo tool now to inspect relevant existing todos when needed and create, update, or append detailed continuity todos when durable storage is warranted.
4. Do not create placeholder, duplicate, speculative, or unnecessary todos.
5. Finish with a short report listing every created or updated todo ID, or state that no continuity todo was warranted.
```

Add an in-memory capture type:

```typescript
type AutomaticHandoffPreparation = {
	sourceMessages: AgentMessage[];
	preparationStartIndex: number;
	parentSession: string | undefined;
};
```

Store one optional capture inside `registerHandoffExtension()`.

- [ ] **Step 8: Separate preparation start from handoff generation**

After an accepted countdown:

1. Read the current branch once.
2. Save `getHandoffMessages(branch)` as `sourceMessages`.
3. Save `branch.length` as `preparationStartIndex`.
4. Save `ctx.sessionManager.getSessionFile()` as `parentSession`.
5. Transition with `preparation-started` before sending any message.
6. Call:

```typescript
pi.sendMessage({
	customType: "handoff-preparation",
	content: AUTOMATIC_HANDOFF_PREPARATION_MESSAGE,
	display: true,
}, { triggerTurn: true });
```

If the send throws, clear the capture and call the existing automatic-disable helper with a preparation-specific error.

Do not call `performHandoff()` from the accepted-countdown branch.

- [ ] **Step 9: Finalize exactly once after preparation settles**

At the start of the `agent_settled` handler, before threshold checks:

```typescript
if (autoState === "preparing") {
	autoState = transitionAutoHandoffState(autoState, { type: "preparation-settled" });
	dispatchAutomaticFinalization(ctx);
	return;
}
```

`dispatchAutomaticFinalization()` sends:

```typescript
pi.sendUserMessage("/handoff --auto-finalize", { expandPromptTemplates: true });
```

It uses the existing failure-to-disabled policy. Because state changes to `finalizing` first, another settled event cannot queue a second finalizer.

- [ ] **Step 10: Generate from separate source and preparation messages**

Handle `{ kind: "internal-auto-finalize" }` only when state is `finalizing` and a capture exists. Copy and clear the capture before awaiting generation.

Collect preparation messages with:

```typescript
const preparationMessages = getHandoffMessages(
	ctx.sessionManager.getBranch().slice(capture.preparationStartIndex),
);
```

Extend `performHandoff()` with an optional automatic input:

```typescript
type PreparedAutomaticHandoff = {
	sourceMessages: AgentMessage[];
	preparationMessages: AgentMessage[];
	parentSession: string | undefined;
};
```

For automatic finalization, pass captured `sourceMessages`, `preparationMessages`, and `parentSession`. For manual handoff, continue reading the current branch and session file at command time.

Pass `preparationMessages` to `dependencies.generatePrompt()`. Update `HandoffDependencies.generatePrompt` accordingly.

- [ ] **Step 11: Route `offer` through submitted replacement delivery**

Update `isGeneratedHandoff()` to accept `offer`:

```typescript
return (
	candidate.action === "continue" ||
	candidate.action === "offer" ||
	candidate.action === "wait"
) && typeof candidate.prompt === "string";
```

Keep the context-only branch exclusive to `handoffAction === "wait"`. Both `continue` and `offer` then use the existing replacement `sendUserMessage()` path and editor fallback.

Clear pending preparation state on `session_start`, explicit `auto off`, cancellation, and automatic failure. Do not run preparation for manual commands.

- [ ] **Step 12: Run all focused handoff tests**

Run:

```sh
node --test --experimental-strip-types \
  tests/extensions/handoff-auto.test.ts \
  tests/extensions/handoff-generation.test.ts \
  tests/extensions/handoff.test.ts
```

Expected: PASS with no failures. Confirm the old manual, `WAIT`, cancellation, replacement-context, and retry-disable tests still pass.

- [ ] **Step 13: Directly verify the preparation and recommendation policy text**

Inspect `extensions/handoff.ts` and `extensions/handoff-generation.ts` and confirm:

- preparation explicitly tells the agent to use the todo tool before generation when warranted;
- preparation forbids unnecessary todos and implementation work;
- automatic generation labels source and preparation separately;
- `OFFER` has both direct and contextual presentation rules;
- contextual introduction is exactly one sentence about only the latest relevant user topic;
- every open recommendation is requested from the user;
- recommendations cannot be acted on without acceptance.

Do not add tests that only duplicate these static strings.

- [ ] **Step 14: Commit the runtime orchestration**

```sh
git add extensions/handoff.ts tests/extensions/handoff.test.ts
git commit -m "feat(handoff): prepare automatic rollover with todos"
```

---

### Task 4: Verify the complete extension change

**Files:**
- Verify: `extensions/handoff-auto.ts`
- Verify: `extensions/handoff-generation.ts`
- Verify: `extensions/handoff.ts`
- Verify: `tests/extensions/handoff-auto.test.ts`
- Verify: `tests/extensions/handoff-generation.test.ts`
- Verify: `tests/extensions/handoff.test.ts`
- Verify: `docs/specs/2026-09-14-auto-handoff-preparation-and-offers-design.md`

**Interfaces:**
- Consumes: The completed state, generation, and runtime tasks.
- Produces: Fresh test, extension-load, full-flake, diff, and repository-status evidence suitable for review.

- [ ] **Step 1: Run the focused behavioral tests from a clean command invocation**

```sh
node --test --experimental-strip-types \
  tests/extensions/handoff-auto.test.ts \
  tests/extensions/handoff-generation.test.ts \
  tests/extensions/handoff.test.ts
```

Expected: PASS with zero failures.

- [ ] **Step 2: Run the Pi runtime extension-load check**

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: exit status 0 and no extension-loading, missing-module, or missing-package error.

- [ ] **Step 3: Run the full flake check**

```sh
nix flake check --accept-flake-config --print-build-logs
```

Expected: exit status 0. If `checks.x86_64-linux.jailed-github-broker` still times out, record it as the approved baseline failure and confirm no handoff or extension-load check failed.

- [ ] **Step 4: Review the branch diff against the spec**

```sh
git diff --check main...HEAD
git diff --stat main...HEAD
git status --short
git log --oneline main..HEAD
```

Expected:

- no whitespace errors;
- only the approved spec, plan, handoff source, and handoff tests changed;
- no uncommitted files;
- separate focused commits for policy, generation, and orchestration.

- [ ] **Step 5: Request adversarial code review**

Give the reviewer:

- spec: `docs/specs/2026-09-14-auto-handoff-preparation-and-offers-design.md`;
- plan: `docs/plans/2026-09-14-auto-handoff-preparation-and-offers.md`;
- base SHA from `main`;
- current head SHA;
- focused and Nix verification results;
- the known unrelated broker baseline status.

Require findings with file and line references. Fix verified issues with regression tests when they cross the Testing Value Gate, rerun all affected checks, and commit each coherent correction.
