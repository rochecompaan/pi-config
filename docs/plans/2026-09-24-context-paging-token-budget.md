# Configurable Context-Paging Token Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan. The sole writer must also use test-driven-development and verification-before-completion.

**Goal:** Make the context-paging rolling token budget configurable, default it to 128,000 tokens, cap it by a declared model context window, and report the effective budget in paging notices.

**Architecture:** Keep settings resolution in the extension entry point and keep context selection pure. Resolve `{ enabled, tokenBudget }` once for the session, pass `tokenBudget` into `selectContext`, derive one effective budget there, and use that value for selection, errors, and paging notices. Preserve the protected-exchange overflow path by treating a missing model limit as unbounded only for that temporary overflow check.

**Tech Stack:** TypeScript, Pi extension API, Node built-in test runner with type stripping, JSON settings, Nix flake checks.

---

## Global Constraints

- `contextPaging.tokenBudget` is optional and defaults to `128000`.
- Accept only positive safe integers. Reject zero, negatives, fractions, strings, arrays, objects, non-finite numbers, and unsafe integers.
- Resolve a valid trusted-project value before a valid global value, then use the default.
- Ignore all project settings when the project is untrusted.
- Resolve `contextPaging.enabled` with its existing precedence and fallback behavior.
- Calculate the normal selection budget as `Math.min(configuredTokenBudget, modelContextWindow)` when the model declares a valid context window.
- Use the configured token budget when the model does not declare a context window.
- Continue rejecting declared model windows that are non-finite or non-positive.
- Keep the selector independent of settings files and mutable module state.
- Keep complete-message, tool-exchange, unread protected-exchange, recovery, and raw-history behavior unchanged.
- Generate paging notices transiently. Do not append them to stored session history.
- Format the effective budget with English thousands separators in the notice.
- Do not change output-page sizes or history recovery limits.
- Do not add tests for README text or the static JSON setting. Verify those files directly, per the repository Testing Value Gate.

## File Structure

- `extensions/context-paging/context-policy.ts` — rename and raise the exported default, accept an explicit configured budget, calculate the effective budget, and render it in paging notices.
- `extensions/context-paging/context-policy.test.ts` — preserve legacy 64,000-token fixture pressure while adding focused tests for the 128,000 default, custom budgets, missing model metadata, model caps, and dynamic notice text.
- `extensions/context-paging/context-policy.regression.test.ts` — pass the explicit fixture budget so the observed-session regression remains stable.
- `extensions/context-paging/index.ts` — resolve one settings object, retain it for the session, and pass its token budget into the selector.
- `extensions/context-paging/index.test.ts` — cover source precedence, validation fallback, session wiring, and transient custom-budget notices.
- `settings.json` — publish `contextPaging.tokenBudget: 128000` in the packaged global configuration.
- `README.md` — document the setting, validation, precedence, model cap, and notice behavior.

`context-policy.ts` is already above the module-size split-pressure threshold, but it has one cohesive responsibility: pure context grouping and selection. This change only alters its budget input and notice rendering, so do not mix in a structural refactor. `index.ts` remains below 200 lines after the settings changes. The test files may remain larger because they contain focused fixtures for the same module behavior.

### Task 1: Make the Selector Accept and Report an Explicit Budget

**Files:**
- Modify: `extensions/context-paging/context-policy.test.ts:1-433`
- Modify: `extensions/context-paging/context-policy.regression.test.ts:61-84`
- Modify: `extensions/context-paging/index.test.ts:275-289`
- Modify: `extensions/context-paging/context-policy.ts:6-428`
- Modify: `extensions/context-paging/index.ts:1-128`

**Interfaces:**

```typescript
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 128_000;

export type ContextSelectionInput = {
	messages: readonly AgentMessage[];
	systemPrompt: string;
	activeTools: readonly ResidentToolDefinition[];
	modelContextWindow: number | undefined;
	tokenBudget: number;
	rawHistoryItems?: readonly HistoryItem[];
};
```

- [ ] **Step 1: Update the policy fixtures for an explicit test budget**

In `extensions/context-paging/context-policy.test.ts`, replace the old constant import and positional `selected` helper with this setup:

```typescript
import {
	DEFAULT_CONTEXT_TOKEN_BUDGET,
	ContextSelectionError,
	selectContext,
} from "./context-policy.ts";

const LEGACY_TEST_TOKEN_BUDGET = 64_000;

type SelectionOverrides = {
	modelContextWindow?: number;
	tokenBudget?: number;
	rawHistoryItems?: HistoryItem[];
};

const selected = (
	messages: readonly object[],
	{
		modelContextWindow = 100_000,
		tokenBudget = LEGACY_TEST_TOKEN_BUDGET,
		rawHistoryItems,
	}: SelectionOverrides = {},
) => selectContext({
	messages: messages as any,
	systemPrompt: "resident prompt",
	activeTools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
	modelContextWindow,
	tokenBudget,
	rawHistoryItems,
});
```

Change the raw-history call in `adds a stable raw history ID to a notice for a matched evicted message` to the object form:

```typescript
const selection = selected(messages, { modelContextWindow: 100_000, rawHistoryItems });
```

Add `tokenBudget: LEGACY_TEST_TOKEN_BUDGET` to every direct `selectContext` call in this test file that does not use `selected`. This includes the accounting test, both model-cap assertions, the three protected-exchange tests, and the resident/active overflow assertions.

In `extensions/context-paging/context-policy.regression.test.ts`, keep the observed fixture at its historical pressure by adding:

```typescript
const selected = selectContext({
	messages: messages as any,
	systemPrompt: "resident prompt",
	activeTools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
	modelContextWindow: 64_000,
	tokenBudget: 64_000,
});
```

Do not increase the legacy fixture budget to the new default. Those cases prove coherent FIFO removal and protected-exchange behavior at a known threshold, not default resolution.

- [ ] **Step 2: Add failing tests for default, custom, capped, and missing-window behavior**

In `accounts resident inputs and canonical messages with Pi estimates`, assert the renamed default and keep the existing accounting selection on the legacy fixture budget:

```typescript
assert.equal(DEFAULT_CONTEXT_TOKEN_BUDGET, 128_000);
assert.equal(selection.estimatedTokens, expected);
assert.equal(selection.budgetTokens, LEGACY_TEST_TOKEN_BUDGET);
assert.deepEqual(selection.messages, messages);
assert.equal(selectContext({
	messages: [],
	systemPrompt: "resident",
	activeTools: [],
	modelContextWindow: 32_000,
	tokenBudget: DEFAULT_CONTEXT_TOKEN_BUDGET,
}).budgetTokens, 32_000);
```

Append this focused test after the accounting test:

```typescript
test("uses an explicit token budget when model context metadata is absent", () => {
	const selection = selectContext({
		messages: [],
		systemPrompt: "resident",
		activeTools: [],
		modelContextWindow: undefined,
		tokenBudget: 96_000,
	});

	assert.equal(selection.budgetTokens, 96_000);
	assert.equal(selection.mode, "within-budget");
});
```

In `adds one counted paging notice before retained canonical messages and can evict another unit`, call the helper with a configured budget above the declared model limit:

```typescript
const selection = selected(messages, {
	modelContextWindow: 64_000,
	tokenBudget: DEFAULT_CONTEXT_TOKEN_BUDGET,
});
```

Add this assertion beside the existing paging-notice assertions:

```typescript
assert.match(marker(selection.messages[0]), /Older context left the 64,000-token rolling window\./);
```

This proves the normal notice reports the effective model-capped value, not either a fixed literal or the configured 128,000 value.

In `keeps a protected unread trailing parallel tool exchange for one follow-up call`, use a distinct custom normal budget:

```typescript
const selection = selectContext({
	messages: messages as any,
	systemPrompt: "resident prompt",
	activeTools: [],
	modelContextWindow: 100_000,
	tokenBudget: 48_000,
	rawHistoryItems,
});
```

Change its overflow assertion and add a dynamic protected-notice assertion:

```typescript
assert.ok(selection.estimatedTokens > 48_000);
assert.ok(selection.estimatedTokens <= 100_000);
assert.match(marker(selection.messages[0]), /The normal rolling budget is 48,000 estimated tokens\./);
```

This proves protected overflow remains temporary while its notice reports the configured normal budget.

In `reports invalid model windows and resident or active request overflows as estimates`, remove `undefined` from the invalid-window loop:

```typescript
for (const modelContextWindow of [0, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
	assert.throws(
		() => selectContext({
			messages: [],
			systemPrompt: "resident",
			activeTools: [],
			modelContextWindow,
			tokenBudget: LEGACY_TEST_TOKEN_BUDGET,
		}),
		(error: unknown) => error instanceof ContextSelectionError
			&& error.code === "INVALID_MODEL_CONTEXT" && /estimate/i.test(error.message),
	);
}
```

Before running the tests, update the accounting selection itself to include:

```typescript
tokenBudget: LEGACY_TEST_TOKEN_BUDGET,
```

- [ ] **Step 3: Run the focused policy tests and confirm the red state**

Run:

```bash
node --test --experimental-strip-types \
  --test-name-pattern="accounts resident|explicit token budget|counted paging notice|protected unread|invalid model windows" \
  extensions/context-paging/context-policy.test.ts
```

Expected: FAIL because `DEFAULT_CONTEXT_TOKEN_BUDGET` is not exported, the selector does not accept the explicit budget, and `undefined` still triggers `INVALID_MODEL_CONTEXT`.

- [ ] **Step 4: Implement effective-budget calculation and dynamic notice text**

In `extensions/context-paging/context-policy.ts`, replace the fixed constant with:

```typescript
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 128_000;
```

Add `tokenBudget: number` to `ContextSelectionInput` immediately after `modelContextWindow`.

Change `pagingNotice` to accept the effective budget and render it:

```typescript
function pagingNotice(
	budgetTokens: number,
	historyId: string | undefined,
	toolReference?: ToolRecoveryReference,
): UserMessage {
	const lines = [
		"[Context paging notice — generated by the extension]",
		`Older context left the ${budgetTokens.toLocaleString("en-US")}-token rolling window. Raw session history is unchanged.`,
		"Use search_history or browse_history to find stored items.",
		"Use load_history for exact items or read_context_output for exact output pages.",
	];
	if (historyId !== undefined) lines.push(`Recent evicted historyId: ${JSON.stringify(historyId)}.`);
	if (toolReference) {
		lines.push(`Tool name: ${toolReference.toolName}.`);
		lines.push(`Read evicted tool output with read_context_output(${JSON.stringify({
			historyId: toolReference.historyId,
			source: "toolResult",
			toolCallId: toolReference.toolCallId,
			offset: 0,
			limit: 2000,
		})}).`);
	}
	return temporaryUserMessage(lines.join("\n"));
}
```

Make the protected-overflow notice dynamic as well:

```typescript
function protectedOverflowNotice(budgetTokens: number): UserMessage {
	return temporaryUserMessage([
		"[Context paging notice — generated by the extension]",
		"The newest tool-result exchange is present in full for this follow-up call.",
		`The normal rolling budget is ${budgetTokens.toLocaleString("en-US")} estimated tokens.`,
		"This exchange can leave context after this call.",
		"Use search_history or browse_history, then load_history or read_context_output, to recover it.",
	].join("\n"));
}
```

Replace the beginning of `selectContext` with:

```typescript
export function selectContext(input: ContextSelectionInput): ContextSelection {
	if (
		input.modelContextWindow !== undefined
		&& (!Number.isFinite(input.modelContextWindow) || input.modelContextWindow <= 0)
	) {
		throw error("INVALID_MODEL_CONTEXT", "The active model context-window estimate is invalid.", 0, 0, 0);
	}
	const budgetTokens = input.modelContextWindow === undefined
		? input.tokenBudget
		: Math.min(input.tokenBudget, input.modelContextWindow);
	const modelLimit = input.modelContextWindow ?? Number.POSITIVE_INFINITY;
	const residentTokens = residentTokenEstimate(input);
```

Pass `budgetTokens` to both normal paging-notice call sites:

```typescript
...(removed ? [pagingNotice(budgetTokens, evictedHistoryId)] : []),
```

```typescript
const candidate = (
	notice = removed ? pagingNotice(budgetTokens, evictedHistoryId, evictedToolReference) : undefined,
): AgentMessage[] => [
```

Pass the effective budget into the protected notice and use `modelLimit` for the two protected-exchange hard-limit comparisons:

```typescript
const overflowMessages = candidate(protectedOverflowNotice(budgetTokens));
const overflowEstimate = residentTokens + messageEstimate(overflowMessages);
if (overflowEstimate <= modelLimit) {
	return { messages: overflowMessages, estimatedTokens: overflowEstimate, budgetTokens, mode: "protected-overflow" };
}
```

```typescript
if (recoveredEstimate <= modelLimit) {
	return { messages: recoveredMessages, estimatedTokens: recoveredEstimate, budgetTokens, mode: "recovery" };
}
```

Do not change the normal budget loops, unit-removal order, recovery payloads, or error codes.

- [ ] **Step 5: Keep the extension working on the new selector interface**

In `extensions/context-paging/index.ts`, import the renamed default:

```typescript
import {
	DEFAULT_CONTEXT_TOKEN_BUDGET,
	selectContext,
	type ResidentToolDefinition,
} from "./context-policy.ts";
```

Until Task 2 supplies the resolved setting, pass the new default explicitly in the context event:

```typescript
const selection = selectContext({
	messages,
	systemPrompt: ctx.getSystemPrompt(),
	activeTools: activeResidentTools(pi),
	modelContextWindow: ctx.model?.contextWindow,
	tokenBudget: DEFAULT_CONTEXT_TOKEN_BUDGET,
	rawHistoryItems,
});
```

In `extensions/context-paging/index.test.ts`, increase the old transient-notice fixture from 300,000 to 600,000 characters so it still crosses the new 128,000-token default:

```typescript
const canonicalMessages = [user(`old ${"x".repeat(600_000)}`), user("current")];
```

- [ ] **Step 6: Run the selector, regression, and integration tests**

Run:

```bash
node --test --experimental-strip-types \
  extensions/context-paging/context-policy.test.ts \
  extensions/context-paging/context-policy.regression.test.ts \
  extensions/context-paging/index.test.ts
```

Expected: PASS. The protected-exchange tests must still report `protected-overflow` or `recovery` in the same cases as before.

- [ ] **Step 7: Review and commit the selector seam**

Run:

```bash
git diff --check
git diff -- \
  extensions/context-paging/context-policy.ts \
  extensions/context-paging/context-policy.test.ts \
  extensions/context-paging/context-policy.regression.test.ts \
  extensions/context-paging/index.ts \
  extensions/context-paging/index.test.ts
```

Confirm that `context-policy.ts` contains no fixed `64,000` or `128,000` notice text and that every `selectContext` call passes `tokenBudget`.

Then commit:

```bash
git add \
  extensions/context-paging/context-policy.ts \
  extensions/context-paging/context-policy.test.ts \
  extensions/context-paging/context-policy.regression.test.ts \
  extensions/context-paging/index.ts \
  extensions/context-paging/index.test.ts
git commit -m "feat(context-paging): accept explicit token budgets"
```

### Task 2: Resolve Token Budgets from Global and Trusted Project Settings

**Files:**
- Modify: `extensions/context-paging/index.test.ts:1-304`
- Modify: `extensions/context-paging/index.ts:9-138`
- Modify: `settings.json:1-12`

**Interfaces:**

```typescript
export type ResolvedContextPagingSettings = {
	enabled: boolean;
	tokenBudget: number;
};

export function resolveContextPagingSettings(
	sources: ContextPagingSettingsSources,
): ResolvedContextPagingSettings;
```

- [ ] **Step 1: Replace the settings test with enabled and token-budget cases**

In `extensions/context-paging/index.test.ts`, replace the named import with:

```typescript
import contextPagingExtension, { resolveContextPagingSettings } from "./index.ts";
```

Split the current combined settings/registration test. Use these settings-resolution tests:

```typescript
test("resolves enabled setting precedence", () => {
	assert.equal(resolveContextPagingSettings({
		globalSettings: {},
		projectTrusted: false,
	}).enabled, true);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { enabled: false } },
		projectTrusted: false,
	}).enabled, false);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { enabled: false } },
		projectSettings: { contextPaging: { enabled: true } },
		projectTrusted: true,
	}).enabled, true);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { enabled: false } },
		projectSettings: { contextPaging: { enabled: true } },
		projectTrusted: false,
	}).enabled, false);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { enabled: true } },
		projectSettings: { contextPaging: { enabled: "yes" } },
		projectTrusted: true,
	}).enabled, true);
});

test("resolves valid token budgets by trusted source precedence", () => {
	assert.equal(resolveContextPagingSettings({
		globalSettings: {},
		projectTrusted: false,
	}).tokenBudget, 128_000);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { tokenBudget: 96_000 } },
		projectTrusted: false,
	}).tokenBudget, 96_000);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { tokenBudget: 96_000 } },
		projectSettings: { contextPaging: { tokenBudget: 72_000 } },
		projectTrusted: true,
	}).tokenBudget, 72_000);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { tokenBudget: 96_000 } },
		projectSettings: { contextPaging: { tokenBudget: 72_000 } },
		projectTrusted: false,
	}).tokenBudget, 96_000);
});

test("falls through invalid token budgets without throwing", () => {
	for (const tokenBudget of [
		0,
		-1,
		1.5,
		"128000",
		[],
		{},
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
	]) {
		assert.equal(resolveContextPagingSettings({
			globalSettings: { contextPaging: { tokenBudget } },
			projectTrusted: false,
		}).tokenBudget, 128_000);
	}

	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { tokenBudget: 96_000 } },
		projectSettings: { contextPaging: { tokenBudget: "invalid" } },
		projectTrusted: true,
	}).tokenBudget, 96_000);
});
```

Keep handler-registration coverage as a separate test:

```typescript
test("registers only paging lifecycle handlers", () => {
	const harness = createHarness();
	assert.equal(harness.tools.length, 4);
	assert.deepEqual([...harness.handlers.keys()].sort(), [
		"context",
		"session_before_compact",
		"session_start",
		"session_tree",
		"turn_end",
	]);
	assert.equal(harness.handlers.has("session_before_tree"), false);
});
```

- [ ] **Step 2: Make the transient-notice integration test prove budget wiring**

In `does not mutate stored history and generates transient notices`, construct the harness with a custom global budget and return the fixture to 300,000 characters:

```typescript
const harness = createHarness({
	globalSettings: { contextPaging: { enabled: true, tokenBudget: 32_000 } },
	projectTrusted: false,
});
const canonicalMessages = [user(`old ${"x".repeat(300_000)}`), user("current")];
```

After the existing count assertions, add:

```typescript
assert.match(marker(first.messages[0]), /Older context left the 32,000-token rolling window\./);
assert.match(marker(second.messages[0]), /Older context left the 32,000-token rolling window\./);
```

This integration test proves the resolved value crosses the extension-to-selector boundary and remains transient on repeated context events.

- [ ] **Step 3: Run the focused settings tests and confirm the red state**

Run:

```bash
node --test --experimental-strip-types \
  --test-name-pattern="resolves enabled|resolves valid token|falls through invalid|registers only|transient notices" \
  extensions/context-paging/index.test.ts
```

Expected: FAIL because `resolveContextPagingSettings` does not exist and the extension still passes the fixed default.

- [ ] **Step 4: Implement validated settings resolution**

In `extensions/context-paging/index.ts`, keep `ContextPagingSettingsSources` and add:

```typescript
export type ResolvedContextPagingSettings = {
	enabled: boolean;
	tokenBudget: number;
};
```

Add a focused token-budget reader beside `readEnabledSetting`:

```typescript
function readTokenBudgetSetting(settings: unknown): number | undefined {
	if (!isRecord(settings) || !isRecord(settings.contextPaging)) return undefined;
	const value = settings.contextPaging.tokenBudget;
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
}
```

Replace `resolveContextPagingEnabled` with:

```typescript
/** Resolves trusted-project context-paging settings over global settings. */
export function resolveContextPagingSettings(
	sources: ContextPagingSettingsSources,
): ResolvedContextPagingSettings {
	const projectSettings = sources.projectTrusted ? sources.projectSettings : undefined;
	return {
		enabled: readEnabledSetting(projectSettings)
			?? readEnabledSetting(sources.globalSettings)
			?? true,
		tokenBudget: readTokenBudgetSetting(projectSettings)
			?? readTokenBudgetSetting(sources.globalSettings)
			?? DEFAULT_CONTEXT_TOKEN_BUDGET,
	};
}
```

An invalid trusted-project token budget must yield `undefined` from the reader so the global source remains visible.

- [ ] **Step 5: Store and use the resolved session settings object**

At the beginning of `contextPagingExtension`, replace the `enabled` boolean with:

```typescript
let resolvedSettings: ResolvedContextPagingSettings = settingsSources
	? resolveContextPagingSettings(settingsSources)
	: { enabled: false, tokenBudget: DEFAULT_CONTEXT_TOKEN_BUDGET };
```

Update tool registration:

```typescript
registerContextPagingTools(pi, {
	isEnabled: () => resolvedSettings.enabled,
	snapshot: rebuild,
});
```

Update `session_start` while preserving fail-closed reload behavior:

```typescript
pi.on("session_start", async (_event, ctx) => {
	if (!settingsSources) {
		resolvedSettings = { ...resolvedSettings, enabled: false };
		resolvedSettings = resolveContextPagingSettings(await loadSettings(ctx));
	}
	rebuildSafely(ctx);
});
```

Use `resolvedSettings.enabled` in the `context` and `session_before_compact` guards. Replace the temporary selector argument from Task 1 with:

```typescript
tokenBudget: resolvedSettings.tokenBudget,
```

Do not catch JSON parse errors inside `loadSettings`; the existing startup test must continue to prove fail-closed behavior for malformed settings files.

- [ ] **Step 6: Publish the new setting in packaged global settings**

Change the existing block in `settings.json` to:

```json
"contextPaging": {
  "enabled": true,
  "tokenBudget": 128000
},
```

Do not add an automated test for this literal JSON value. The resolver behavior is already covered, and Task 3 will parse the file directly.

- [ ] **Step 7: Run the integration and complete context-paging test suites**

Run:

```bash
node --test --experimental-strip-types extensions/context-paging/index.test.ts
node --test --experimental-strip-types extensions/context-paging/*.test.ts
```

Expected: PASS. The invalid-token cases must not reject or notify, malformed JSON must still fail closed, and the custom-budget integration test must show `32,000` in both transient notices.

- [ ] **Step 8: Review and commit settings resolution**

Run:

```bash
git diff --check
git diff -- extensions/context-paging/index.ts extensions/context-paging/index.test.ts settings.json
```

Confirm that:

- the extension owns one resolved settings object rather than separate mutable values;
- untrusted project settings never reach either reader;
- `Number.isSafeInteger` and `value > 0` are both present;
- the context event passes `resolvedSettings.tokenBudget`;
- no output-page or history-tool limits changed.

Then commit:

```bash
git add extensions/context-paging/index.ts extensions/context-paging/index.test.ts settings.json
git commit -m "feat(context-paging): resolve configurable token budgets"
```

### Task 3: Document the Setting and Run Release-Grade Verification

**Files:**
- Modify: `README.md:1-70`
- Verify: `settings.json`
- Verify: `extensions/context-paging/context-policy.ts`
- Verify: `extensions/context-paging/index.ts`
- Verify: `extensions/context-paging/*.test.ts`
- Verify: `modules/packages/pi-config.nix`

- [ ] **Step 1: Add user-facing context-paging documentation**

Add this section between `Per-launch workflow suite` and `Per-project usage` in `README.md`:

````markdown
## Context paging

The packaged configuration enables context paging with a default rolling budget of 128,000 estimated tokens:

```json
{
  "contextPaging": {
    "enabled": true,
    "tokenBudget": 128000
  }
}
```

`tokenBudget` is optional. It must be a positive safe integer. A trusted project's `.pi/settings.json` can override the global value. An untrusted project is ignored, and an invalid value falls through to the next valid source or the 128,000-token default.

When the active model declares a smaller context window, the extension uses that smaller value. Paging notices show the effective rolling budget. The setting does not change output-page sizes or history recovery limits.
````

Keep the JSON example exactly valid and do not describe project settings as available to untrusted projects.

- [ ] **Step 2: Verify documentation and static configuration directly**

Run:

```bash
node -e 'JSON.parse(require("node:fs").readFileSync("settings.json", "utf8")); console.log("settings.json: valid")'
grep -n 'tokenBudget\|128,000\|positive safe integer\|trusted project' README.md settings.json
git diff --check
```

Expected: the JSON parser prints `settings.json: valid`; the grep output shows the new setting and contract; `git diff --check` is silent.

No new automated test is needed for README prose or the static default entry. These checks verify those Testing Value Gate exclusions directly.

- [ ] **Step 3: Run all context-paging tests with fresh output**

Run:

```bash
node --test --experimental-strip-types extensions/context-paging/*.test.ts
```

Expected: PASS with zero failed tests.

- [ ] **Step 4: Run the packaged extension-load check**

Run:

```bash
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: PASS. The packaged Pi startup path loads the context-paging extension without `Failed to load extension`, missing-module, or missing-package errors.

- [ ] **Step 5: Run the full flake check**

Run:

```bash
nix flake check --accept-flake-config --print-build-logs
```

Expected: PASS.

- [ ] **Step 6: Inspect the final diff and requirement coverage**

Run:

```bash
git status --short
git diff --check
git diff main...HEAD -- \
  extensions/context-paging/context-policy.ts \
  extensions/context-paging/context-policy.test.ts \
  extensions/context-paging/context-policy.regression.test.ts \
  extensions/context-paging/index.ts \
  extensions/context-paging/index.test.ts \
  settings.json \
  README.md
```

Verify each acceptance criterion against the diff and fresh command output:

1. Global settings can set `contextPaging.tokenBudget`.
2. A trusted project can override the global value.
3. Invalid values fall through without a startup error.
4. The exported default is 128,000 estimated tokens.
5. A declared model context window caps the effective budget.
6. Missing model context metadata uses the configured budget.
7. Paging notices show the effective budget.
8. Protected-exchange overflow and recovery tests still pass.
9. Stored raw history remains unchanged.
10. All context-paging, extension-load, and flake checks pass.

- [ ] **Step 7: Commit the documentation**

Run:

```bash
git add README.md
git commit -m "docs(context-paging): explain token budget settings"
```

- [ ] **Step 8: Request adversarial review before branch completion**

Request the canonical `reviewer` with fresh context. Give it:

- the approved design at `docs/specs/2026-09-24-context-paging-token-budget-design.md`;
- this plan;
- base SHA from `main` and the feature branch head SHA;
- the complete `main...HEAD` diff;
- the context-paging test output, extension-load result, and full flake-check result;
- explicit review focus on settings trust/precedence, positive-safe-integer validation, missing model metadata, effective-budget notice text, and protected-exchange overflow behavior.

Address technically valid findings, rerun every affected check, and use the finishing-a-development-branch skill to present branch-completion options. If the user chooses local integration, offer a squash merge into `main`, not a regular merge.
