# Interactive Quick-Fix Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/quickfix` and `/end-quickfix` commands that provide an interactive branch with a model-selected skill subset.

**Architecture:** A small Pi extension uses the current session tree instead of a child session. Pure modules own profiles, classification, prompt filtering, and lifecycle ordering. The extension entry point owns Pi API adapters, UI state, branch state, and event registration.

**Tech Stack:** TypeScript, Pi 0.84.2 public extension APIs, Node 24 built-in test runner, Nix flake checks.

## Global Constraints

- Implement the approved design in `docs/specs/2026-08-17-quickfix-extension-design.md`.
- Keep the user in the current Pi TUI and current session tree.
- Preserve the active checkout and all tracked and untracked changes.
- Do not invoke Git from the extension.
- Use one no-tool model call for summary and profile classification.
- Use the current session model for the classifier.
- Use only the fixed profile allowlists from the specification.
- Remove `using-superpowers`, `brainstorming`, `writing-plans`, and all other unselected skills from quick-fix turns.
- Preserve Pi tool guidance and project context files.
- Replace the normal appended workflow prompt with the quick-fix contract.
- Block `subagent` and `run_team` during active quick-fix turns.
- Do not create a design, specification, implementation plan, worktree, or commit from quick-fix mode.
- Keep exactly one writer in the checkout.
- Use Node 24 with `node --test --experimental-strip-types` for focused TypeScript tests.
- Run the Pi extension-load check and the full flake check before completion.
- Do not modify Nix packaging unless the extension-load check proves that directory discovery is insufficient.

## File Structure

Create these files under `extensions/quickfix/`:

- `profiles.ts` — fixed profiles, blocked tools, profile lookup, and command parsing.
- `profiles.test.ts` — profile allowlist and command parser tests.
- `classifier.ts` — active-branch serialization, classifier prompt, model adapter, and strict output parsing.
- `classifier.test.ts` — summary, parser, confidence, and model-error tests.
- `prompt.ts` — quick-fix contract, initial message, skill filtering, and workflow-append removal.
- `prompt.test.ts` — prompt preservation, exclusion, and missing-skill tests.
- `lifecycle.ts` — start and finish ordering with recoverable error results.
- `lifecycle.test.ts` — navigation, dispatch, editor recovery, return, and failure-order tests.
- `index.ts` — Pi command registration, UI, branch state, event handlers, and API adapters.
- `index.test.ts` — command and event integration tests with a fake Pi harness.

No existing production file needs modification. `modules/packages/pi-config.nix` already copies the complete `extensions/` directory. The directory entry-point pattern prevents Pi from loading `*.test.ts` files as extensions.

---

### Task 1: Define Profiles and Parse `/quickfix` Arguments

**Files:**
- Create: `extensions/quickfix/profiles.ts`
- Test: `extensions/quickfix/profiles.test.ts`

**Interfaces:**
- Consumes: No earlier task output.
- Produces: `QuickfixProfileId`, `QuickfixProfile`, `QUICKFIX_PROFILES`, `QUICKFIX_PROFILE_OPTIONS`, `QUICKFIX_BLOCKED_TOOLS`, `getQuickfixProfile()`, and `parseQuickfixCommand()`.

- [ ] **Step 1: Write profile and parser tests**

Create `extensions/quickfix/profiles.test.ts` with tests equivalent to this focused set:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
	QUICKFIX_BLOCKED_TOOLS,
	QUICKFIX_PROFILE_IDS,
	getQuickfixProfile,
	parseQuickfixCommand,
} from "./profiles.ts";

test("profiles expose the exact fixed skill allowlists", () => {
	assert.deepEqual(QUICKFIX_PROFILE_IDS, ["bug", "static", "docs", "mechanical"]);
	assert.deepEqual(getQuickfixProfile("bug").skills, [
		"systematic-debugging",
		"test-driven-development",
		"verification-before-completion",
		"module-size",
	]);
	assert.deepEqual(getQuickfixProfile("static").skills, [
		"verification-before-completion",
		"nix-config",
	]);
	assert.deepEqual(getQuickfixProfile("docs").skills, [
		"simple-english",
		"verification-before-completion",
	]);
	assert.deepEqual(getQuickfixProfile("mechanical").skills, [
		"verification-before-completion",
		"module-size",
	]);
});

test("orchestration tools are blocked", () => {
	assert.deepEqual([...QUICKFIX_BLOCKED_TOOLS], ["subagent", "run_team"]);
});

test("command parser keeps a request without an override", () => {
	assert.deepEqual(parseQuickfixCommand("Fix the empty-input crash"), {
		request: "Fix the empty-input crash",
		profileSpecified: false,
	});
});

test("command parser accepts separated and equals profile values", () => {
	assert.deepEqual(parseQuickfixCommand("--profile docs Rewrite the runbook"), {
		request: "Rewrite the runbook",
		profile: "docs",
		profileSpecified: true,
	});
	assert.deepEqual(parseQuickfixCommand("--profile=bug Fix the parser"), {
		request: "Fix the parser",
		profile: "bug",
		profileSpecified: true,
	});
});

test("command parser rejects missing and unknown profile values", () => {
	assert.equal(parseQuickfixCommand("--profile").error, "Missing value for --profile");
	assert.equal(
		parseQuickfixCommand("--profile feature Add a page").error,
		"Unknown quick-fix profile: feature. Available profiles: bug, static, docs, mechanical",
	);
});
```

- [ ] **Step 2: Run the focused test and observe the expected failure**

Run:

```sh
node --test --experimental-strip-types extensions/quickfix/profiles.test.ts
```

Expected: FAIL because `extensions/quickfix/profiles.ts` does not exist.

- [ ] **Step 3: Implement the profile types and fixed policy**

Create `extensions/quickfix/profiles.ts` with these public shapes:

```ts
export const QUICKFIX_PROFILE_IDS = ["bug", "static", "docs", "mechanical"] as const;
export type QuickfixProfileId = (typeof QUICKFIX_PROFILE_IDS)[number];

export type QuickfixProfile = {
	id: QuickfixProfileId;
	label: string;
	description: string;
	skills: readonly string[];
};

export type ParsedQuickfixCommand = {
	request: string;
	profile?: QuickfixProfileId;
	profileSpecified: boolean;
	error?: string;
};

export const QUICKFIX_BLOCKED_TOOLS = new Set(["subagent", "run_team"] as const);
```

Define the four profiles with the exact names, labels, descriptions, and skill order from the specification. Export `QUICKFIX_PROFILE_OPTIONS` in the same order as `QUICKFIX_PROFILE_IDS`.

Implement strict lookup and parsing:

```ts
export function isQuickfixProfileId(value: string): value is QuickfixProfileId {
	return (QUICKFIX_PROFILE_IDS as readonly string[]).includes(value);
}

export function getQuickfixProfile(id: QuickfixProfileId): QuickfixProfile {
	const profile = QUICKFIX_PROFILE_OPTIONS.find((item) => item.id === id);
	if (!profile) throw new Error(`Missing quick-fix profile: ${id}`);
	return profile;
}

export function parseQuickfixCommand(raw: string): ParsedQuickfixCommand {
	const value = raw.trim();
	if (!value.startsWith("--profile")) {
		return { request: value, profileSpecified: false };
	}

	const equals = value.match(/^--profile=([^\s]*)(?:\s+([\s\S]*))?$/);
	const separated = value.match(/^--profile(?:\s+([^\s]+))?(?:\s+([\s\S]*))?$/);
	const match = equals ?? separated;
	const profileValue = match?.[1]?.trim();
	const request = match?.[2]?.trim() ?? "";
	if (!profileValue) {
		return { request, profileSpecified: true, error: "Missing value for --profile" };
	}
	if (!isQuickfixProfileId(profileValue)) {
		return {
			request,
			profileSpecified: true,
			error: `Unknown quick-fix profile: ${profileValue}. Available profiles: ${QUICKFIX_PROFILE_IDS.join(", ")}`,
		};
	}
	return { request, profile: profileValue, profileSpecified: true };
}
```

Keep profile flags at the start of the command. Text after the profile value is the complete request.

- [ ] **Step 4: Run the focused profile tests**

Run:

```sh
node --test --experimental-strip-types extensions/quickfix/profiles.test.ts
```

Expected: PASS with no failed tests.

- [ ] **Step 5: Commit the profile policy**

```sh
git add extensions/quickfix/profiles.ts extensions/quickfix/profiles.test.ts
git commit -m "feat(quickfix): add quick-fix profiles"
```

---

### Task 2: Build the Summary and Profile Classifier

**Files:**
- Create: `extensions/quickfix/classifier.ts`
- Test: `extensions/quickfix/classifier.test.ts`

**Interfaces:**
- Consumes: `QuickfixProfileId` and `QUICKFIX_PROFILE_OPTIONS` from `profiles.ts`.
- Produces: `QuickfixClassification`, `QuickfixClassifierResult`, `serializeQuickfixBranch()`, `buildQuickfixClassifierPrompt()`, `parseQuickfixClassifierOutput()`, and `classifyQuickfix()`.

- [ ] **Step 1: Write strict classifier parser tests**

Create `extensions/quickfix/classifier.test.ts`. Start with these cases:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
	buildQuickfixClassifierPrompt,
	parseQuickfixClassifierOutput,
	serializeQuickfixBranch,
} from "./classifier.ts";

test("parses a high-confidence profile and removes markers from the summary", () => {
	assert.deepEqual(
		parseQuickfixClassifierOutput(
			"The parser crashes after tokenization.\n\nQUICKFIX_PROFILE: bug\nQUICKFIX_CONFIDENCE: high",
		),
		{
			ok: true,
			value: {
				summary: "The parser crashes after tokenization.",
				profile: "bug",
				confidence: "high",
			},
		},
	);
});

test("accepts ambiguous and low-confidence results for selector fallback", () => {
	assert.equal(
		parseQuickfixClassifierOutput(
			"Context.\nQUICKFIX_PROFILE: ambiguous\nQUICKFIX_CONFIDENCE: low",
		).ok,
		true,
	);
});

test("rejects missing, duplicate, and trailing classifier markers", () => {
	for (const output of [
		"Summary only",
		"Summary\nQUICKFIX_PROFILE: bug\nQUICKFIX_PROFILE: docs\nQUICKFIX_CONFIDENCE: high",
		"Summary\nQUICKFIX_PROFILE: bug\nQUICKFIX_CONFIDENCE: high\nextra",
	]) {
		assert.equal(parseQuickfixClassifierOutput(output).ok, false, output);
	}
});

test("classifier prompt contains every fixed profile and the explicit request", () => {
	const prompt = buildQuickfixClassifierPrompt("Fix the parser", "origin context");
	assert.match(prompt, /Fix the parser/);
	assert.match(prompt, /bug/);
	assert.match(prompt, /static/);
	assert.match(prompt, /docs/);
	assert.match(prompt, /mechanical/);
});
```

Add branch-serialization fixtures that prove these rules:

- Include user and assistant text from the active path.
- Include compaction and branch-summary text.
- Omit tool-result entries.
- Omit hidden custom orchestration entries.
- Do not accept sibling entries because the caller supplies only `buildContextEntries()`, which is the resolved active path with compaction applied.

- [ ] **Step 2: Run the parser tests and observe the expected failure**

Run:

```sh
node --test --experimental-strip-types extensions/quickfix/classifier.test.ts
```

Expected: FAIL because `classifier.ts` does not exist.

- [ ] **Step 3: Implement strict output parsing and branch serialization**

Use these result types:

```ts
import type { AssistantMessage, Context } from "@mariozechner/pi-ai";
import type { ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { QuickfixProfileId } from "./profiles.ts";

export type QuickfixClassifiedProfile = QuickfixProfileId | "ambiguous";
export type QuickfixClassification = {
	summary: string;
	profile: QuickfixClassifiedProfile;
	confidence: "high" | "low";
};
export type QuickfixClassifierResult =
	| { ok: true; value: QuickfixClassification }
	| { ok: false; error: string };
```

Make the parser fail closed. Require the profile and confidence markers as the final two nonblank lines:

```ts
const RESULT_PATTERN =
	/^(?<summary>[\s\S]*?)\n*QUICKFIX_PROFILE:\s*(?<profile>bug|static|docs|mechanical|ambiguous)\s*\nQUICKFIX_CONFIDENCE:\s*(?<confidence>high|low)\s*$/;
```

Return an error for an empty summary, malformed markers, or an unknown value.

Implement `serializeQuickfixBranch(entries: readonly SessionEntry[]): string`. Serialize visible text from `message`, `compaction`, and `branch_summary` entries. Skip tool results and custom entries. Prefix each section with its role or summary type so the classifier can distinguish user decisions from assistant claims.

- [ ] **Step 4: Implement the no-tool model adapter**

Export this function:

```ts
export async function classifyQuickfix(
	ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
	request: string,
	originContext: string,
): Promise<QuickfixClassifierResult>
```

Use `ctx.modelRegistry.complete()` with the current model. Use a dedicated system prompt and one user message. Give the model no tools:

```ts
const context: Context = {
	systemPrompt: QUICKFIX_CLASSIFIER_SYSTEM_PROMPT,
	messages: [
		{
			role: "user",
			content: [{ type: "text", text: buildQuickfixClassifierPrompt(request, originContext) }],
			timestamp: Date.now(),
		},
	],
	tools: [],
};
const response = await ctx.modelRegistry.complete(model, context);
```

Treat these results as failures:

- no active model;
- thrown completion errors;
- `stopReason === "aborted"`;
- `stopReason === "error"`;
- no text content;
- invalid structured markers.

Extract text from `AssistantMessage.content` by joining only `type === "text"` blocks.

- [ ] **Step 5: Add model-adapter tests**

Add a fake `modelRegistry.complete()` implementation. Prove that `classifyQuickfix()`:

- uses the active model;
- sends no tools;
- includes the request and serialized origin context;
- returns parsed output;
- returns errors for missing model, thrown completion, aborted response, and empty text.

Use plain objects and cast only the narrow fake context to the exported parameter type.

- [ ] **Step 6: Run classifier tests**

Run:

```sh
node --test --experimental-strip-types extensions/quickfix/classifier.test.ts
```

Expected: PASS with no failed tests.

- [ ] **Step 7: Commit the classifier**

```sh
git add extensions/quickfix/classifier.ts extensions/quickfix/classifier.test.ts
git commit -m "feat(quickfix): classify quick-fix requests"
```

---

### Task 3: Filter the Prompt and Build the Quick-Fix Contract

**Files:**
- Create: `extensions/quickfix/prompt.ts`
- Test: `extensions/quickfix/prompt.test.ts`

**Interfaces:**
- Consumes: `QuickfixProfile` from `profiles.ts`.
- Produces: `QUICKFIX_CONTRACT`, `buildQuickfixInitialPrompt()`, and `filterQuickfixSystemPrompt()`.

- [ ] **Step 1: Write prompt-filter behavior tests**

Create `extensions/quickfix/prompt.test.ts`. Build fake `Skill` objects for selected and excluded skills. Provide a deterministic test formatter through the filter dependency.

Cover this core case:

```ts
test("keeps Pi and project context while replacing workflow and skills", () => {
	const originalSkills = [usingSuperpowers, brainstorming, writingPlans, debugging, tdd, verification, moduleSize];
	const normalAppend = "[roche-pi skillset: superpowers]\nNormal workflow routing";
	const originalSkillText = testFormatSkillsForPrompt(originalSkills);
	const systemPrompt = [
		"Pi base prompt and tool guidance",
		"Project context: obey AGENTS.md",
		normalAppend,
		originalSkillText,
	].join("\n\n");

	const result = filterQuickfixSystemPrompt({
		formatSkillsForPrompt: testFormatSkillsForPrompt,
		systemPrompt,
		options: {
			cwd: "/repo",
			contextFiles: [{ path: "/repo/AGENTS.md", content: "Project instructions" }],
			appendSystemPrompt: normalAppend,
			skills: originalSkills,
			selectedTools: ["read", "bash", "edit", "write"],
		},
		profile: getQuickfixProfile("bug"),
	});

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.match(result.systemPrompt, /Pi base prompt and tool guidance/);
	assert.match(result.systemPrompt, /Project context: obey AGENTS\.md/);
	assert.doesNotMatch(result.systemPrompt, /Normal workflow routing/);
	assert.doesNotMatch(result.systemPrompt, /brainstorming/);
	assert.doesNotMatch(result.systemPrompt, /writing-plans/);
	assert.match(result.systemPrompt, /systematic-debugging/);
	assert.match(result.systemPrompt, /test-driven-development/);
	assert.match(result.systemPrompt, /verification-before-completion/);
	assert.match(result.systemPrompt, /module-size/);
	assert.match(result.systemPrompt, /NEEDS_NORMAL_WORKFLOW/);
});
```

Add tests for:

- every profile's exact selected skills;
- a missing required skill;
- a missing original skill block;
- a missing normal appended prompt when the option says one exists;
- an undefined appended prompt;
- initial-message inclusion of request, summary, and profile;
- initial-message behavior when no summary is available.

- [ ] **Step 2: Run the prompt tests and observe the expected failure**

Run:

```sh
node --test --experimental-strip-types extensions/quickfix/prompt.test.ts
```

Expected: FAIL because `prompt.ts` does not exist.

- [ ] **Step 3: Implement the quick-fix contract and initial message**

Export a constant contract that states the approved behavior. Use direct commands and include the exact `NEEDS_NORMAL_WORKFLOW` marker.

Implement:

```ts
export function buildQuickfixInitialPrompt(input: {
	request: string;
	summary?: string;
	profile: QuickfixProfile;
}): string
```

Use explicit sections:

```text
# Quick-fix request
...

# Origin-session summary
...

# Active profile
...

# Quick-fix contract
...
```

If no summary exists, use `No origin summary is available. Inspect the repository and ask focused questions when required.`

- [ ] **Step 4: Implement exact prompt filtering with public Pi helpers**

Import `Skill` and `BuildSystemPromptOptions` as types only. Define the runtime formatter dependency without importing Pi at module load:

```ts
export type FormatSkillsForPrompt = (skills: Skill[]) => string;
```

Export:

```ts
export type QuickfixPromptFilterResult =
	| { ok: true; systemPrompt: string }
	| { ok: false; error: string };

export function filterQuickfixSystemPrompt(input: {
	systemPrompt: string;
	options: BuildSystemPromptOptions;
	profile: QuickfixProfile;
	formatSkillsForPrompt: FormatSkillsForPrompt;
}): QuickfixPromptFilterResult
```

Resolve selected skills in profile order:

```ts
const available = new Map((input.options.skills ?? []).map((skill) => [skill.name, skill]));
const missing = input.profile.skills.filter((name) => !available.has(name));
if (missing.length > 0) {
	return { ok: false, error: `Missing quick-fix skills: ${missing.join(", ")}` };
}
const selected = input.profile.skills.map((name) => available.get(name)!);
```

Use the injected `formatSkillsForPrompt()` for both the original and selected skill sections. Replace exactly one original skill section. Remove the last exact occurrence of `options.appendSystemPrompt` when that value exists. Return an error when an expected exact section is absent or appears more than once.

Append `QUICKFIX_CONTRACT` after the filtered prompt. Do not import `buildSystemPrompt()` from a private Pi path. The entry point loads Pi's public formatter dynamically, while tests inject a formatter without installed Pi modules.

- [ ] **Step 5: Run prompt tests**

Run:

```sh
node --test --experimental-strip-types extensions/quickfix/prompt.test.ts
```

Expected: PASS with no failed tests.

- [ ] **Step 6: Commit the prompt boundary**

```sh
git add extensions/quickfix/prompt.ts extensions/quickfix/prompt.test.ts
git commit -m "feat(quickfix): filter quick-fix prompts"
```

---

### Task 4: Implement Lifecycle Ordering and Recovery

**Files:**
- Create: `extensions/quickfix/lifecycle.ts`
- Test: `extensions/quickfix/lifecycle.test.ts`

**Interfaces:**
- Consumes: No Pi runtime objects. Callers provide action callbacks.
- Produces: `QuickfixLifecycleStepResult`, `startQuickfixLifecycle()`, and `finishQuickfixLifecycle()`.

- [ ] **Step 1: Write start and finish ordering tests**

Create `extensions/quickfix/lifecycle.test.ts` with an event-array harness.

Prove successful start order:

```ts
test("start orders navigation, activation, and dispatch", async () => {
	const events: string[] = [];
	const result = await startQuickfixLifecycle({
		navigateToBranch: async () => { events.push("navigate"); return { ok: true }; },
		activateEntering: () => { events.push("activate"); },
		dispatchInitialPrompt: async () => { events.push("dispatch"); },
		recoverEditor: () => { events.push("recover"); },
	});
	assert.deepEqual(result, { ok: true });
	assert.deepEqual(events, ["navigate", "activate", "dispatch"]);
});
```

Add tests that prove:

- navigation failure prevents activation and dispatch;
- dispatch failure keeps activation and calls editor recovery;
- successful finish waits, marks returning, navigates, then clears;
- wait failure leaves active state unchanged;
- navigation failure calls `restoreActive` and does not clear;
- cancelled navigation returns a cancelled result.

- [ ] **Step 2: Run lifecycle tests and observe the expected failure**

Run:

```sh
node --test --experimental-strip-types extensions/quickfix/lifecycle.test.ts
```

Expected: FAIL because `lifecycle.ts` does not exist.

- [ ] **Step 3: Implement lifecycle result types and start ordering**

Use these public action contracts:

```ts
export type QuickfixLifecycleStepResult =
	| { ok: true }
	| { ok: false; error: string; cancelled?: boolean; recoverable?: boolean };

export type StartQuickfixActions = {
	navigateToBranch: () => Promise<QuickfixLifecycleStepResult>;
	activateEntering: () => void;
	dispatchInitialPrompt: () => Promise<void>;
	recoverEditor: () => void;
};

export type FinishQuickfixActions = {
	waitForIdle: () => Promise<void>;
	markReturning: () => void;
	navigateToOrigin: () => Promise<QuickfixLifecycleStepResult>;
	restoreActive: () => void;
	clearActive: () => void;
};
```

`startQuickfixLifecycle()` returns navigation failures unchanged. It catches dispatch errors, calls `recoverEditor()`, and returns a recoverable error without clearing active state.

```ts
export async function startQuickfixLifecycle(
	actions: StartQuickfixActions,
): Promise<QuickfixLifecycleStepResult> {
	const navigation = await actions.navigateToBranch();
	if (!navigation.ok) return navigation;

	actions.activateEntering();
	try {
		await actions.dispatchInitialPrompt();
		return { ok: true };
	} catch (error) {
		actions.recoverEditor();
		return {
			ok: false,
			error: `Failed to submit the quick-fix request: ${error instanceof Error ? error.message : String(error)}`,
			recoverable: true,
		};
	}
}
```

- [ ] **Step 4: Implement finish ordering**

`finishQuickfixLifecycle()` performs these actions in order:

1. `waitForIdle()`.
2. `markReturning()`.
3. `navigateToOrigin()`.
4. `clearActive()` after successful navigation.

If waiting or navigation fails, call `restoreActive()` when the phase changed. Return the original error and keep quick-fix state recoverable.

```ts
export async function finishQuickfixLifecycle(
	actions: FinishQuickfixActions,
): Promise<QuickfixLifecycleStepResult> {
	try {
		await actions.waitForIdle();
	} catch (error) {
		return { ok: false, error: `Failed to wait for idle state: ${error instanceof Error ? error.message : String(error)}` };
	}

	actions.markReturning();
	const navigation = await actions.navigateToOrigin();
	if (!navigation.ok) {
		actions.restoreActive();
		return navigation;
	}
	actions.clearActive();
	return { ok: true };
}
```

- [ ] **Step 5: Run lifecycle tests**

Run:

```sh
node --test --experimental-strip-types extensions/quickfix/lifecycle.test.ts
```

Expected: PASS with no failed tests.

- [ ] **Step 6: Commit lifecycle ordering**

```sh
git add extensions/quickfix/lifecycle.ts extensions/quickfix/lifecycle.test.ts
git commit -m "feat(quickfix): add branch lifecycle recovery"
```

---

### Task 5: Register `/quickfix` and Enter the Interactive Branch

**Files:**
- Create: `extensions/quickfix/index.ts`
- Test: `extensions/quickfix/index.test.ts`

**Interfaces:**
- Consumes: all exports from Tasks 1 through 4.
- Produces: the default Pi extension registration function and active quick-fix state.

- [ ] **Step 1: Build a fake Pi registration harness**

Create `extensions/quickfix/index.test.ts`. Capture registered commands and event handlers:

```ts
type CommandHandler = (args: string, ctx: any) => Promise<void>;
type EventHandler = (event: any, ctx: any) => Promise<any> | any;

function createPiHarness() {
	const commands = new Map<string, CommandHandler>();
	const events = new Map<string, EventHandler[]>();
	const sent: string[] = [];
	const appended: Array<{ type: string; data: unknown }> = [];
	const pi = {
		registerCommand(name: string, definition: { handler: CommandHandler }) {
			commands.set(name, definition.handler);
		},
		on(name: string, handler: EventHandler) {
			events.set(name, [...(events.get(name) ?? []), handler]);
		},
		sendUserMessage(message: string) { sent.push(message); },
		appendEntry(type: string, data: unknown) { appended.push({ type, data }); },
	};
	return { pi, commands, events, sent, appended };
}
```

Create a context factory with spies for:

- `mode` and `hasUI`;
- `ui.input`, `ui.select`, `ui.notify`, `ui.setWidget`, and `ui.setEditorText`;
- `waitForIdle()` and `navigateTree()`;
- `sessionManager.getSessionId()`, `getLeafId()`, `getEntries()`, and `getBranch()`;
- `getSystemPromptOptions()`;
- `model` and `modelRegistry.complete()`.

- [ ] **Step 2: Write command validation tests**

Prove these behaviors before implementation:

- both commands register;
- non-TUI `/quickfix` fails before classification;
- an unknown profile fails before classification;
- an empty request opens `ui.input()`;
- cancelled input changes no session state;
- a null origin leaf reports the unsupported empty-session case;
- a second `/quickfix` call is refused while state is active.

- [ ] **Step 3: Run the index tests and observe the expected failure**

Run:

```sh
node --test --experimental-strip-types extensions/quickfix/index.test.ts
```

Expected: FAIL because `index.ts` does not exist.

- [ ] **Step 4: Register commands and define active state**

Create `extensions/quickfix/index.ts` with a default registration function. Make the public formatter loader injectable so Node tests do not require installed Pi runtime modules:

```ts
type QuickfixDependencies = {
	loadPiPromptModule: () => Promise<Pick<typeof import("@mariozechner/pi-coding-agent"), "formatSkillsForPrompt">>;
};

const defaultDependencies: QuickfixDependencies = {
	loadPiPromptModule: () => import("@mariozechner/pi-coding-agent"),
};

export default function registerQuickfix(
	pi: ExtensionAPI,
	dependencies: QuickfixDependencies = defaultDependencies,
): void {
	// Register commands and events.
}
```

Use this state shape:

```ts
type QuickfixPhase = "classifying" | "entering" | "active" | "returning";
type ActiveQuickfix = {
	sessionId: string;
	originId: string;
	markerId?: string;
	profile: QuickfixProfileId;
	request: string;
	summary?: string;
	phase: QuickfixPhase;
};

let activeQuickfix: ActiveQuickfix | undefined;
```

Add small helpers for notifications, widget display, state clearing, first-user-message lookup, active-path membership, and profile selector mapping.

Use a string widget to avoid a custom component:

```ts
ctx.ui.setWidget("quickfix", [
	`Quick-fix active (${profile.label}). Return with /end-quickfix.`,
]);
```

- [ ] **Step 5: Implement summary, selector, skill-resolution, and start flow**

The `/quickfix` handler performs this order:

1. Require `ctx.mode === "tui"` and `ctx.hasUI`.
2. Refuse an active lifecycle.
3. Parse arguments and collect an input request when required.
4. Capture `sessionId`, `originId`, the active `getBranch()` result and its first user message for branch membership and navigation. Separately capture `ctx.sessionManager.buildContextEntries()` for classifier input.
5. Set an internal `classifying` guard.
6. Call `classifyQuickfix()` with `serializeQuickfixBranch(ctx.sessionManager.buildContextEntries())`.
7. Use an explicit profile when supplied.
8. Otherwise accept only a high-confidence non-ambiguous profile.
9. Show `ui.select()` for low confidence, ambiguity, invalid output, or classifier failure.
10. Clear the guard and return when the selector is cancelled.
11. Resolve required skills from `ctx.getSystemPromptOptions().skills` before navigation.
12. If an explicit profile was supplied and classification failed, continue with that profile and no summary.
13. Build the initial prompt.
14. Call `startQuickfixLifecycle()`.

The branch action uses the review pattern:

```ts
const result = await ctx.navigateTree(firstUserMessage.id, {
	summarize: false,
	label: `quickfix:${profile.id}`,
});
```

`activateEntering()` records state, shows the widget, and leaves `markerId` undefined. `dispatchInitialPrompt()` calls `pi.sendUserMessage(initialPrompt)`. `recoverEditor()` calls `ctx.ui.setEditorText(initialPrompt)`.

Notify the user when classification falls back to the selector. Include the classifier error without exposing credentials or raw provider payloads.

- [ ] **Step 6: Add successful and fallback start tests**

Expand `index.test.ts` to prove:

- high-confidence classification chooses the returned profile;
- explicit `--profile` overrides classifier profile output;
- low confidence shows the selector;
- classifier failure shows the selector and uses no summary;
- selector cancellation causes no navigation;
- missing profile skills cause no navigation;
- navigation occurs before dispatch;
- dispatch failure leaves the widget active and restores editor text;
- classifier input comes from `buildContextEntries()`, while branch membership and branch-point selection use `getBranch()`.

Do not add an automated no-Git test. The fake harness has no Git dependency, so such a test would assert nothing. Instead, directly inspect the extension imports and API calls to verify that it does not import or invoke a Git library, Git command, or process API. Record this direct verification in the task report.

- [ ] **Step 7: Run all quick-fix tests**

Run:

```sh
node --test --experimental-strip-types extensions/quickfix/*.test.ts
```

Expected: PASS with no failed tests.

- [ ] **Step 8: Commit interactive branch entry**

```sh
git add extensions/quickfix/index.ts extensions/quickfix/index.test.ts
git commit -m "feat(quickfix): enter interactive quick-fix branches"
```

---

### Task 6: Enforce Per-Turn Boundaries and Return to the Origin

**Files:**
- Modify: `extensions/quickfix/index.ts`
- Modify: `extensions/quickfix/index.test.ts`

**Interfaces:**
- Consumes: `filterQuickfixSystemPrompt()`, `QUICKFIX_BLOCKED_TOOLS`, `finishQuickfixLifecycle()`, and active state from Task 5.
- Produces: branch marker capture, follow-up filtering, tool blocking, stale-state cleanup, and `/end-quickfix`.

- [ ] **Step 1: Write initial-turn and follow-up filtering tests**

Capture the `before_agent_start` handler in the fake Pi harness.

Prove these cases:

- In `entering`, the current leaf becomes `markerId` and the handler returns a filtered system prompt.
- After marker capture, state changes to `active`.
- In `active`, a branch containing `markerId` remains filtered.
- A branch without `markerId` clears state and returns no prompt override.
- A different session ID clears state and returns no override.
- A filter error notifies the user, keeps the quick-fix widget, and returns a safe quick-fix prompt that excludes the normal skill catalog.

Inject a deterministic formatter through `loadPiPromptModule`. Inspect the handler result and make sure that `brainstorming` and `writing-plans` are absent.

- [ ] **Step 2: Implement `before_agent_start` filtering**

Register:

```ts
pi.on("before_agent_start", async (event, ctx) => {
	// Resolve entering marker or confirm active branch membership.
	const { formatSkillsForPrompt } = await dependencies.loadPiPromptModule();
	// Pass the formatter to filterQuickfixSystemPrompt(), then return { systemPrompt }.
});
```

During `entering`, require a non-null current leaf. Save it as `markerId` and set phase to `active` before filtering.

During `active`, compare the current session ID and active branch entry IDs with state. Clear stale state and widget when either does not match.

If prompt filtering fails after branch entry, fail closed. Notify the user, then return only the quick-fix contract and a stop instruction:

```ts
ctx.ui.notify(result.error, "error");
return {
	systemPrompt: [
		QUICKFIX_CONTRACT,
		"Quick-fix prompt filtering failed. Do not edit files. Report the configuration error and ask the user to run /end-quickfix.",
	].join("\n\n"),
};
```

This exceptional prompt omits all normal skills and appended workflow text. The notification contains only the filter error, not provider credentials or raw request data.

- [ ] **Step 3: Write tool-gate tests**

Capture the `tool_call` handler. Prove that active quick-fix turns return:

```ts
{
	block: true,
	reason: "Quick-fix mode does not permit nested orchestration. Complete the bounded fix directly or report NEEDS_NORMAL_WORKFLOW.",
}
```

for `subagent` and `run_team`.

Prove that `read`, `bash`, `edit`, `write`, and unknown unrelated tools return no block. Prove that the same orchestration tools remain available outside the marked branch.

- [ ] **Step 4: Implement the tool gate**

Register `tool_call`. Block only when the current session and active branch match. Use `QUICKFIX_BLOCKED_TOOLS.has(event.toolName)`. Do not set `terminate: true` because the model can recover and report scope expansion.

- [ ] **Step 5: Write cleanup and `/end-quickfix` tests**

Prove these behaviors:

- `session_tree` clears state after manual navigation away from the marker.
- `session_switch`, `session_fork`, and `session_start` clear state and widget.
- `/end-quickfix` waits for idle state before origin navigation.
- Successful return clears state and widget after navigation.
- Cancelled or failed return restores phase `active` and keeps the widget.
- The origin navigation uses `{ summarize: false }`.
- The quick-fix branch remains in the fake session tree.
- Calling `/end-quickfix` without active state shows an informational notification.

- [ ] **Step 6: Implement cleanup handlers and `/end-quickfix`**

Register `session_tree`, `session_switch`, `session_fork`, and `session_start` handlers.

The `session_tree` handler must not clear state during controlled `entering` or `returning` navigation. During `active`, clear state only when the branch marker is absent.

Implement `/end-quickfix` through `finishQuickfixLifecycle()`:

```ts
await finishQuickfixLifecycle({
	waitForIdle: () => ctx.waitForIdle(),
	markReturning: () => { activeQuickfix = { ...lockedState, phase: "returning" }; },
	navigateToOrigin: async () => {
		try {
			const result = await ctx.navigateTree(lockedState.originId, { summarize: false });
			return result.cancelled
				? { ok: false, error: "Navigation cancelled. Use /end-quickfix to try again.", cancelled: true }
				: { ok: true };
		} catch (error) {
			return { ok: false, error: `Failed to return: ${error instanceof Error ? error.message : String(error)}` };
		}
	},
	restoreActive: () => { activeQuickfix = { ...lockedState, phase: "active" }; setQuickfixWidget(ctx, lockedState.profile); },
	clearActive: () => clearQuickfixState(ctx),
});
```

Notify success only after state and widget cleanup.

- [ ] **Step 7: Run the complete quick-fix test suite**

Run:

```sh
node --test --experimental-strip-types extensions/quickfix/*.test.ts
```

Expected: PASS with no failed tests.

- [ ] **Step 8: Run existing extension regression tests**

Run:

```sh
node --test --experimental-strip-types \
  extensions/quickfix/*.test.ts \
  extensions/review/*.test.ts \
  extensions/answer/answer-parser.test.ts \
  extensions/auth-scope/index.test.ts
```

Expected: PASS with no failed tests.

- [ ] **Step 9: Commit boundaries and return flow**

```sh
git add extensions/quickfix/index.ts extensions/quickfix/index.test.ts
git commit -m "feat(quickfix): enforce interactive branch boundaries"
```

---

### Task 7: Run Runtime and TUI Verification

**Files:**
- Verify: `extensions/quickfix/`
- Verify: `modules/checks/pi-config-extension-load.nix`
- Verify: `docs/specs/2026-08-17-quickfix-extension-design.md`

**Interfaces:**
- Consumes: the complete extension from Tasks 1 through 6.
- Produces: completion evidence. No new production interface is expected.

- [ ] **Step 1: Run the focused suite from a clean process**

Run:

```sh
node --test --experimental-strip-types extensions/quickfix/*.test.ts
```

Expected: PASS with no failed tests.

- [ ] **Step 2: Run whitespace and repository-state checks**

Run:

```sh
git diff --check
git status --short
```

Expected: no whitespace errors. Only intended quick-fix files and plan/spec commits are present.

- [ ] **Step 3: Build the packaged extension-load check**

Run:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: PASS. Logs contain no `Failed to load extension`, `No such built-in module`, or `Cannot find package` errors.

Do not add a new test for literal Nix file contents. This change relies on existing directory discovery and the runtime extension-load check.

- [ ] **Step 4: Run the full flake check**

Run:

```sh
nix flake check --accept-flake-config --print-build-logs
```

Expected: PASS.

- [ ] **Step 5: Perform a direct TUI smoke test**

Start the packaged Pi configuration in a repository with an existing conversation. Complete this procedure:

1. Enter `/quickfix Fix a small, reversible defect in a temporary fixture`.
2. Make sure that the classifier selects a profile or opens the selector.
3. Inspect the active widget and profile name.
4. Ask one follow-up question in the quick-fix branch.
5. Inspect the effective prompt through a temporary diagnostic hook or debugger.
6. Make sure that `brainstorming`, `writing-plans`, and the normal Superpowers appendix are absent.
7. Ask the model to start a subagent and make sure that the tool gate blocks it.
8. Enter `/end-quickfix`.
9. Make sure that Pi returns to the saved origin.
10. Open the session tree and make sure that the quick-fix branch remains available.

Do not use a production file for the smoke-test edit. Use a disposable fixture and remove it after the test.

- [ ] **Step 6: Review the implementation against the specification**

Check every specification section against the implementation:

- commands and UI;
- four fixed profiles;
- one model call;
- active-branch-only summary input;
- branch entry and return;
- per-turn prompt filtering;
- orchestration tool gate;
- error recovery;
- no Git-state inspection.

If a requirement is absent, return to its owning task and add a failing test before the fix.

- [ ] **Step 7: Commit verification-only fixes when required**

If verification required a code correction, stage only those corrected files and use:

```sh
git commit -m "fix(quickfix): correct runtime integration"
```

If all checks pass without changes, do not create an empty commit.

- [ ] **Step 8: Request final code review**

Dispatch the canonical fresh-context `reviewer`. Give it:

- the approved specification path;
- this implementation plan;
- base SHA `95b98ab^` and the current head SHA;
- the complete feature diff;
- focused test output;
- extension-load and flake-check output;
- TUI smoke-test notes.

Resolve all valid findings through failing tests before completion.
