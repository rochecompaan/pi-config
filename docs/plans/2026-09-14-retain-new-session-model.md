# Retain `/new` Session Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain the active provider, model, and effective thinking level when `/new` replaces a normal saved Pi session.

**Architecture:** One extension writes a versioned custom entry before a `new` session switch. A fresh extension instance reads that entry from the prior session and restores the model before the thinking level.

**Tech Stack:** TypeScript, Pi 0.85.1 extension APIs, Pi `SessionManager`, `node:test`, Bun, and Nix flake checks.

**Specification:** `docs/specs/2026-09-14-new-session-model-retention-design.md`

## Global Constraints

- Work only in `/home/roche/projects/pi/roche-pi/.worktrees/retain-new-session-model` on branch `feat/retain-new-session-model`.
- Support normal saved sessions only. Do not add support for `--no-session`.
- Retain `provider`, `modelId`, and the effective `thinkingLevel` only across built-in `/new` transitions.
- Do not persist the runtime choice across Pi process restarts.
- Do not change configured startup defaults.
- Do not change `/resume`, `/fork`, `/clone`, or `/reload` behavior.
- Do not patch or fork upstream Pi.
- Do not register a replacement command named `new`.
- Use custom entry type `retain-new-session-model` with schema version `1`.
- Keep the custom entry outside the model context and transcript. Do not register an entry renderer.
- Restore the model before the thinking level.
- Let `pi.setThinkingLevel()` clamp the level to the restored model capabilities.
- Keep replacement-session defaults when restoration cannot complete.
- Prefix warnings with `[retain-new-session-model]`.
- Do not include credentials, exception text, or previous-session contents in warnings.
- Keep implementation and parsing in `extensions/retain-new-session-model/index.ts`.
- Do not add Bun or npm dependencies.
- Do not add a static content test for Nix wiring.
- Treat `checks.x86_64-linux.jailed-github-broker` and `timed out waiting for expected file` as the known baseline error.

---

## File Map

Create these files:

- `extensions/retain-new-session-model/index.ts` — validates handoff entries and owns both session lifecycle handlers.
- `extensions/retain-new-session-model/index.test.ts` — proves capture, selection, restoration order, transition scope, and error behavior.

No Nix source file needs a change. `modules/packages/pi-config.nix:91-124` already copies the complete `extensions/` directory into the Pi resource package.

The production module has one responsibility: transfer one runtime choice across one built-in `/new` transition. Keep its public surface to constants, data types, pure selection logic, and the default extension factory.

---

### Task 1: Define and capture the versioned handoff

**Files:**
- Create: `extensions/retain-new-session-model/index.test.ts`
- Create: `extensions/retain-new-session-model/index.ts`

**Interfaces:**
- Produces: `HANDOFF_ENTRY_TYPE = "retain-new-session-model"`
- Produces: `RuntimeChoiceHandoff`
- Produces: `HandoffSelection`
- Produces: `selectNewestHandoff(entries: readonly unknown[]): HandoffSelection`
- Produces: the default extension factory with the `session_before_switch` handler

- [ ] **Step 1: Write the failing capture and selection tests**

Create `extensions/retain-new-session-model/index.test.ts` with this initial content:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import retainNewSessionModel, {
	HANDOFF_ENTRY_TYPE,
	selectNewestHandoff,
} from "./index.ts";

type EventHandler = (event: any, ctx: any) => unknown;

class FakePi {
	readonly appendedEntries: Array<{ customType: string; data: unknown }> = [];
	readonly handlers = new Map<string, EventHandler[]>();

	on(event: string, handler: EventHandler): void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
	}

	appendEntry(customType: string, data: unknown): void {
		this.appendedEntries.push({ customType, data });
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
```

- [ ] **Step 2: Run the focused test and verify the expected import error**

Run:

```bash
bun test extensions/retain-new-session-model/index.test.ts
```

Expected: FAIL because `extensions/retain-new-session-model/index.ts` does not exist.

- [ ] **Step 3: Add the handoff types, validator, selector, and capture handler**

Create `extensions/retain-new-session-model/index.ts` with this content:

```typescript
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

export const HANDOFF_ENTRY_TYPE = "retain-new-session-model";

const HANDOFF_VERSION = 1 as const;
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

export type RuntimeChoiceHandoff = {
	version: typeof HANDOFF_VERSION;
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
};

export type HandoffSelection =
	| { kind: "missing" }
	| { kind: "invalid"; reason: "malformed" | "unsupported-version" }
	| { kind: "found"; choice: RuntimeChoiceHandoff };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string"
		&& (THINKING_LEVELS as readonly string[]).includes(value);
}

export function selectNewestHandoff(entries: readonly unknown[]): HandoffSelection {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecord(entry)
			|| entry.type !== "custom"
			|| entry.customType !== HANDOFF_ENTRY_TYPE) {
			continue;
		}

		const data = entry.data;
		if (!isRecord(data)) return { kind: "invalid", reason: "malformed" };
		if (typeof data.version === "number" && data.version !== HANDOFF_VERSION) {
			return { kind: "invalid", reason: "unsupported-version" };
		}
		if (data.version !== HANDOFF_VERSION
			|| typeof data.provider !== "string"
			|| data.provider.length === 0
			|| typeof data.modelId !== "string"
			|| data.modelId.length === 0
			|| !isThinkingLevel(data.thinkingLevel)) {
			return { kind: "invalid", reason: "malformed" };
		}

		return {
			kind: "found",
			choice: {
				version: HANDOFF_VERSION,
				provider: data.provider,
				modelId: data.modelId,
				thinkingLevel: data.thinkingLevel,
			},
		};
	}

	return { kind: "missing" };
}

export default function retainNewSessionModel(pi: ExtensionAPI): void {
	pi.on("session_before_switch", (event, ctx) => {
		if (event.reason !== "new" || !ctx.model || !ctx.thinkingLevel) return;

		pi.appendEntry<RuntimeChoiceHandoff>(HANDOFF_ENTRY_TYPE, {
			version: HANDOFF_VERSION,
			provider: ctx.model.provider,
			modelId: ctx.model.id,
			thinkingLevel: ctx.thinkingLevel,
		});
	});
}
```

The custom entry stays invisible because the extension does not register an entry renderer.

- [ ] **Step 4: Run the focused test and verify capture behavior**

Run:

```bash
bun test extensions/retain-new-session-model/index.test.ts
```

Expected: PASS for all four tests.

- [ ] **Step 5: Commit the capture behavior**

Run:

```bash
git add extensions/retain-new-session-model/index.ts extensions/retain-new-session-model/index.test.ts
git commit -m "feat(pi): capture runtime choice before new session"
```

---

### Task 2: Restore the runtime choice after `/new`

**Files:**
- Modify: `extensions/retain-new-session-model/index.test.ts`
- Modify: `extensions/retain-new-session-model/index.ts`

**Interfaces:**
- Consumes: `selectNewestHandoff(entries: readonly unknown[]): HandoffSelection`
- Produces: `SessionEntriesReader`
- Produces: `RetainNewSessionModelDependencies`
- Produces: a default reader that calls `SessionManager.open(sessionFile).getEntries()`
- Extends: the default extension factory with the `session_start` handler

- [ ] **Step 1: Extend the fake Pi API for restore assertions**

Replace the `FakePi` class in `extensions/retain-new-session-model/index.test.ts` with this version:

```typescript
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
```

Add this fixture code after `handoffEntry()`:

```typescript
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
```

- [ ] **Step 2: Write the failing successful-restore and scope tests**

Append these tests to `extensions/retain-new-session-model/index.test.ts`:

```typescript
test("restores the newest model before its thinking level and stays silent", async () => {
	const pi = new FakePi();
	const restoredModel = { provider: "anthropic", id: "claude-opus-4-6" };
	const readFiles: string[] = [];
	retainNewSessionModel(pi as any, {
		readSessionEntries: async (sessionFile) => {
			readFiles.push(sessionFile);
			return [
				validHandoff({ modelId: "claude-sonnet-4-5", thinkingLevel: "low" }),
				validHandoff({ thinkingLevel: "xhigh" }),
			];
		},
	});
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
	retainNewSessionModel(pi as any, {
		readSessionEntries: async (sessionFile) => {
			readFiles.push(sessionFile);
			return [validHandoff()];
		},
	});
	const { context } = createContext([
		{ provider: "anthropic", id: "claude-opus-4-6" },
	]);

	for (const reason of ["startup", "reload", "resume", "fork"] as const) {
		await pi.emit("session_start", {
			reason,
			previousSessionFile: "/tmp/previous-session.jsonl",
		}, context);
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
```

- [ ] **Step 3: Run the focused test and verify the missing restore handler**

Run:

```bash
bun test extensions/retain-new-session-model/index.test.ts
```

Expected: FAIL because no `session_start` handler reads or applies the retained runtime choice.

- [ ] **Step 4: Add the session reader and restore handler**

Add these definitions before the default extension factory in `extensions/retain-new-session-model/index.ts`:

```typescript
export type SessionEntriesReader = (
	sessionFile: string,
) => Promise<readonly unknown[]> | readonly unknown[];

export interface RetainNewSessionModelDependencies {
	readSessionEntries: SessionEntriesReader;
}

const defaultDependencies: RetainNewSessionModelDependencies = {
	async readSessionEntries(sessionFile) {
		const { SessionManager } = await import("@mariozechner/pi-coding-agent");
		return SessionManager.open(sessionFile).getEntries();
	},
};
```

Replace the default extension factory with this version:

```typescript
export default function retainNewSessionModel(
	pi: ExtensionAPI,
	dependencies: RetainNewSessionModelDependencies = defaultDependencies,
): void {
	pi.on("session_before_switch", (event, ctx) => {
		if (event.reason !== "new" || !ctx.model || !ctx.thinkingLevel) return;

		pi.appendEntry<RuntimeChoiceHandoff>(HANDOFF_ENTRY_TYPE, {
			version: HANDOFF_VERSION,
			provider: ctx.model.provider,
			modelId: ctx.model.id,
			thinkingLevel: ctx.thinkingLevel,
		});
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "new" || !event.previousSessionFile) return;

		const entries = await dependencies.readSessionEntries(event.previousSessionFile);
		const selection = selectNewestHandoff(entries);
		if (selection.kind !== "found") return;

		const model = ctx.modelRegistry.find(
			selection.choice.provider,
			selection.choice.modelId,
		);
		if (!model) return;

		const restored = await pi.setModel(model);
		if (!restored) return;

		pi.setThinkingLevel(selection.choice.thinkingLevel);
	});
}
```

The dynamic import keeps focused Bun tests independent from Pi runtime module resolution. The extension-load check exercises that resolution in the packaged Pi runtime.

- [ ] **Step 5: Run the focused test and verify restore behavior**

Run:

```bash
bun test extensions/retain-new-session-model/index.test.ts
```

Expected: PASS. The ordered call list proves that model restoration occurs before thinking-level restoration.

- [ ] **Step 6: Commit successful restoration**

Run:

```bash
git add extensions/retain-new-session-model/index.ts extensions/retain-new-session-model/index.test.ts
git commit -m "feat(pi): restore runtime choice after new session"
```

---

### Task 3: Preserve defaults and warn on restore errors

**Files:**
- Modify: `extensions/retain-new-session-model/index.test.ts`
- Modify: `extensions/retain-new-session-model/index.ts`

**Interfaces:**
- Consumes: `HandoffSelection`, `RetainNewSessionModelDependencies`, and Pi model setters
- Produces: safe warning messages for malformed data, unsupported versions, read errors, unavailable models, authentication errors, and model activation errors
- Preserves: the fallback thinking level whenever model restoration fails

- [ ] **Step 1: Write the failing warning and fallback tests**

Append these tests to `extensions/retain-new-session-model/index.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the focused test and verify the warning assertions fail**

Run:

```bash
bun test extensions/retain-new-session-model/index.test.ts
```

Expected: FAIL because invalid, unavailable, and authentication paths return without warnings. The read and model exceptions also escape their handlers.

- [ ] **Step 3: Add safe warning messages and guarded restore behavior**

Add this code before the default extension factory in `extensions/retain-new-session-model/index.ts`:

```typescript
type RestoreWarning =
	| "malformed"
	| "unsupported-version"
	| "read-error"
	| "unavailable-model"
	| "authentication"
	| "model-activation";

const WARNING_MESSAGES: Record<RestoreWarning, string> = {
	malformed: "Ignored malformed /new runtime handoff; using replacement-session defaults.",
	"unsupported-version": "Ignored unsupported /new runtime handoff version; using replacement-session defaults.",
	"read-error": "Could not read the previous session; using replacement-session defaults.",
	"unavailable-model": "The retained model is unavailable; using replacement-session defaults.",
	authentication: "Pi could not authenticate the retained model; using replacement-session defaults.",
	"model-activation": "Pi could not restore the retained model; using replacement-session defaults.",
};

function warn(ctx: ExtensionContext, reason: RestoreWarning): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(`[retain-new-session-model] ${WARNING_MESSAGES[reason]}`, "warning");
}
```

Replace the `session_start` handler with this guarded version:

```typescript
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "new" || !event.previousSessionFile) return;

		let entries: readonly unknown[];
		try {
			entries = await dependencies.readSessionEntries(event.previousSessionFile);
		} catch {
			warn(ctx, "read-error");
			return;
		}

		const selection = selectNewestHandoff(entries);
		if (selection.kind === "missing") return;
		if (selection.kind === "invalid") {
			warn(ctx, selection.reason);
			return;
		}

		let model: ReturnType<ExtensionContext["modelRegistry"]["find"]>;
		try {
			model = ctx.modelRegistry.find(
				selection.choice.provider,
				selection.choice.modelId,
			);
		} catch {
			warn(ctx, "model-activation");
			return;
		}
		if (!model) {
			warn(ctx, "unavailable-model");
			return;
		}

		let restored: boolean;
		try {
			restored = await pi.setModel(model);
		} catch {
			warn(ctx, "model-activation");
			return;
		}
		if (!restored) {
			warn(ctx, "authentication");
			return;
		}

		pi.setThinkingLevel(selection.choice.thinkingLevel);
	});
```

Do not catch or rewrite the thinking level. Pi validates the stored union value and clamps it to the restored model capabilities.

- [ ] **Step 4: Run the focused test suite**

Run:

```bash
bun test extensions/retain-new-session-model/index.test.ts
```

Expected: PASS. Successful restoration stays silent. Every restore error keeps the fallback thinking level unchanged.

- [ ] **Step 5: Stage the new files before git-backed Nix verification**

Run:

```bash
git add extensions/retain-new-session-model/index.ts extensions/retain-new-session-model/index.test.ts
git diff --cached --check
```

Expected: PASS with no whitespace errors. Staging makes the new files visible to the normal flake source.

- [ ] **Step 6: Verify packaged Pi can load all configured extensions**

Run:

```bash
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: PASS. This command verifies the dynamic Pi import in a Home Manager-like runtime layout.

- [ ] **Step 7: Run the full flake check and separate the known baseline error**

Run:

```bash
set -o pipefail
nix flake check --accept-flake-config --print-build-logs \
	2>&1 | tee /tmp/retain-new-session-model-flake-check.log
status=${PIPESTATUS[0]}

if [ "$status" -ne 0 ]; then
	rg -n "jailed-github-broker|timed out waiting for expected file" \
		/tmp/retain-new-session-model-flake-check.log
	! rg -n "Failed to load extension|Extension does not export a valid factory function|No such built-in module|Cannot find package" \
		/tmp/retain-new-session-model-flake-check.log
fi
```

Expected: The full check either passes or fails only in `checks.x86_64-linux.jailed-github-broker`. The known error text is `timed out waiting for expected file`.

If another check fails, stop before the commit and investigate that error.

- [ ] **Step 8: Commit the completed extension**

Run:

```bash
git commit -m "feat(pi): retain runtime choice across new sessions"
```

Expected: The commit contains only the final warning and fallback changes from this task. The two earlier commits retain the TDD history.
