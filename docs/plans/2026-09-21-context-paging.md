# Context Paging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore context paging with a 64,000-token rolling input window that keeps coherent turns, preserves raw history, and exposes exact recovery tools.

**Architecture:** Pi continues to build canonical model context. The extension filters the deep-copied `context` event messages through one policy module. A separate raw-branch projection supplies stable history IDs and exact recovery data to an in-memory navigator. The selector uses Pi's exported `estimateTokens`, removes the oldest coherent units, and protects one unread trailing tool exchange.

**Tech Stack:** TypeScript, Pi extension events, `@earendil-works/pi-coding-agent`, `@mariozechner/pi-agent-core`, TypeBox, Node's test runner, Nix flakes.

## Global Constraints

- Use `docs/specs/2026-09-21-context-paging-design.md` as the source of truth.
- Keep the normal full-input budget at exactly `64_000` estimated tokens.
- Use `Math.min(64_000, ctx.model.contextWindow)` when the active model declares a smaller window.
- Import and use Pi's exported `estimateTokens`. Do not add a token-counter adapter.
- Count the system prompt, active tool definitions, canonical messages, tool results, and paging notice.
- Select from the canonical `event.messages` deep copy. Do not rebuild outbound context from raw history.
- Remove the oldest coherent completed user turns first.
- Keep the active user message. Remove its oldest completed assistant exchanges only when required.
- Keep each assistant tool call and every matching result as one atomic exchange.
- Keep parallel tool calls and results in one atomic exchange.
- Return the original canonical messages when the complete input fits.
- Do not replace outputs at a fixed byte threshold.
- Protect the newest unread trailing tool exchange for one follow-up model call.
- Permit only that protected exchange to exceed the normal budget.
- Keep temporary overflow within the active model's declared context window.
- If the protected exchange cannot fit, replace result payloads with compact recovery notices.
- Keep the assistant tool calls and result envelopes during emergency replacement.
- Add at most one synthetic paging notice per provider call.
- Put the notice before retained conversation messages and count it in the estimate.
- Never append the notice or a paging placeholder to stored session history.
- Use `ctx.sessionManager.getBranch()` only for history navigation and stable recovery references.
- Keep stored raw messages and metadata unchanged.
- Exclude paging-tool turns from navigation, but not from canonical model context.
- Cancel automatic compaction for `threshold` and `overflow` reasons only.
- Permit manual `/compact`.
- Keep canonical compaction and branch summaries until FIFO selection removes them.
- Always register `search_history`, `browse_history`, `load_history`, and `read_context_output`.
- Do not register `update_task_state`.
- Do not modify automatic handoff behavior.
- Do not add or manage `loadout.json`.
- Do not add a named loadout profile.
- Do not add external dependencies.
- Keep production modules focused. Split a production file before it exceeds 400 meaningful lines.
- Use commit `5fda8aa` only as a reference for preserved history-tool contracts.
- Do not cherry-pick `5fda8aa`. Its byte budget, 16KB replacement, compaction, handoff, and loadout choices are rejected.
- Use automated tests for production behavior.
- Do not add tests that assert static JSON, Nix text, package-lock content, or documentation text.

---

## File Map

- `extensions/context-paging/history.ts`: project raw branch entries into stable, immutable history items.
- `extensions/context-paging/history.test.ts`: cover raw projection, tool-result atomicity, stable IDs, and storage safety.
- `extensions/context-paging/navigator.ts`: index, search, browse, and atomically load raw history items.
- `extensions/context-paging/navigator.test.ts`: retain the approved search, browse, filter, and load contracts.
- `extensions/context-paging/output-pages.ts`: read exact JSON pages from raw assistant and tool-result output.
- `extensions/context-paging/output-pages.test.ts`: cover exact paging and input validation without automatic replacement.
- `extensions/context-paging/context-policy.ts`: estimate full input, group canonical messages, select retained units, and build notices.
- `extensions/context-paging/context-policy.test.ts`: cover accounting, coherent FIFO selection, notices, overflow, and errors.
- `extensions/context-paging/context-policy.regression.test.ts`: reproduce the observed incoherent-task-state regression.
- `extensions/context-paging/tools.ts`: register the four strict public recovery tools.
- `extensions/context-paging/tools.test.ts`: cover schemas, registration, bounds, disabled behavior, and exact loads.
- `extensions/context-paging/index.ts`: resolve settings and connect lifecycle, context, compaction, and tool dependencies.
- `extensions/context-paging/index.test.ts`: cover integration, lifecycle rebuilds, failure isolation, and raw-storage safety.
- `settings.json`: package `contextPaging.enabled: true`.
- `modules/checks/pi-config-extension-load.nix`: prove that the packaged runtime loads and activates the four tools.

No handoff file changes are part of this plan.

---

### Task 1: Project the raw active branch

**Files:**
- Create: `extensions/context-paging/history.test.ts`
- Create: `extensions/context-paging/history.ts`

**Interfaces:**
- Consumes: Pi `SessionEntry`, `AgentMessage`, `AssistantMessage`, and `ToolResultMessage` types.
- Produces: `PAGING_TOOL_NAMES`, `PagingToolName`, `HistoryMetadata`, `HistoryItem`, `HistoryProjectionError`, `projectActiveBranch()`, `isPagingToolTurn()`, and `findModelTurnByToolCallId()`.
- Does not produce: a function that rebuilds outbound model messages from raw history.

- [ ] **Step 1: Write raw-projection tests**

Create `history.test.ts` with fixtures for user entries, assistant entries, and tool-result entries. Include these assertions:

```typescript
const before = structuredClone(entries);
const items = projectActiveBranch(entries as any);

assert.deepEqual(items.map((item) => item.id), ["user-1", "assistant-1"]);
assert.equal(items[0].kind, "user");
assert.equal(items[1].kind, "modelTurn");
assert.deepEqual(
	items[1].kind === "modelTurn"
		? items[1].toolResults.map((result) => result.toolCallId)
		: [],
	["call-2", "call-1"],
);
assert.deepEqual(entries, before);
```

Cover these cases in named tests:

```typescript
assert.equal(findModelTurnByToolCallId(items, "call-1")?.id, "assistant-1");
assert.equal(findModelTurnByToolCallId(items, "missing"), undefined);
assert.equal(isPagingToolTurn(pagingTurn), true);
assert.equal(isPagingToolTurn(normalTurn), false);
```

Also assert these errors:

```typescript
assert.throws(
	() => projectActiveBranch(orphanResultBranch as any),
	(error: unknown) => error instanceof HistoryProjectionError
		&& error.code === "ORPHAN_TOOL_RESULT",
);
assert.throws(
	() => projectActiveBranch(duplicateResultBranch as any),
	(error: unknown) => error instanceof HistoryProjectionError
		&& error.code === "DUPLICATE_TOOL_RESULT",
);
assert.throws(
	() => projectActiveBranch(incompleteOlderBranch as any),
	(error: unknown) => error instanceof HistoryProjectionError
		&& error.code === "INCOMPLETE_TOOL_RESULTS",
);
```

A newest incomplete assistant exchange is not yet a complete history item. Assert that projection omits only that exchange.

- [ ] **Step 2: Run the test and observe the red state**

Run:

```sh
node --test --experimental-strip-types extensions/context-paging/history.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `history.ts`.

- [ ] **Step 3: Define focused history types**

Create `history.ts` with these public types:

```typescript
export const PAGING_TOOL_NAMES = [
	"search_history",
	"browse_history",
	"load_history",
	"read_context_output",
] as const;

export type PagingToolName = typeof PAGING_TOOL_NAMES[number];

export type HistoryMetadata = {
	tools: string[];
	files: string[];
	failed: boolean;
};

export type UserHistoryItem = {
	id: string;
	kind: "user";
	sequence: number;
	timestamp: string;
	userMessage: UserMessage;
};

export type ModelTurnHistoryItem = {
	id: string;
	kind: "modelTurn";
	sequence: number;
	timestamp: string;
	assistantMessage: AssistantMessage;
	toolResults: ToolResultMessage[];
	metadata: HistoryMetadata;
};

export type HistoryItem = UserHistoryItem | ModelTurnHistoryItem;

export type HistoryProjectionErrorCode =
	| "ORPHAN_TOOL_RESULT"
	| "DUPLICATE_TOOL_RESULT"
	| "INCOMPLETE_TOOL_RESULTS"
	| "MISMATCHED_TOOL_RESULT";

export class HistoryProjectionError extends Error {
	constructor(readonly code: HistoryProjectionErrorCode, message = code) {
		super(message);
		this.name = "HistoryProjectionError";
	}
}
```

Keep the complete stored message objects on each item. Do not clone, rewrite, or serialize them.

- [ ] **Step 4: Implement atomic projection**

Port the sound projection rules from `5fda8aa:extensions/context-paging/history.ts`.

Use the stored entry ID for each history ID. For an assistant entry, collect only contiguous tool results that match its tool-call IDs. Preserve result order from the branch.

Use this public shape:

```typescript
export function projectActiveBranch(entries: readonly SessionEntry[]): HistoryItem[];
export function isPagingToolTurn(item: HistoryItem): boolean;
export function findModelTurnByToolCallId(
	items: readonly HistoryItem[],
	toolCallId: string,
): ModelTurnHistoryItem | undefined;
```

Do not port `flattenHistoryItems()`. The context policy must not derive outbound context from raw items.

- [ ] **Step 5: Run the focused test**

Run:

```sh
node --test --experimental-strip-types extensions/context-paging/history.test.ts
```

Expected: PASS. The branch fixture remains deeply equal to its pre-call copy.

- [ ] **Step 6: Commit the raw-history module**

```sh
git add extensions/context-paging/history.ts extensions/context-paging/history.test.ts
git commit -m "feat(context-paging): project raw history"
```

---

### Task 2: Restore the in-memory navigator

**Files:**
- Create: `extensions/context-paging/navigator.test.ts`
- Create: `extensions/context-paging/navigator.ts`

**Interfaces:**
- Consumes: `HistoryItem` and `isPagingToolTurn()` from Task 1.
- Produces: `HistorySearchInput`, `HistoryBrowseInput`, `HistoryReference`, `HistoryNavigatorError`, and `HistoryNavigator`.
- Keeps paging-tool model turns outside search, browse, and exact load results.

- [ ] **Step 1: Write navigator contract tests**

Create the test fixtures from the preserved implementation at commit `5fda8aa`. Add exact tests for this public interface:

```typescript
const navigator = new HistoryNavigator(items);

const references = navigator.search({
	query: "needle",
	files: ["src/a.ts"],
	tools: ["read"],
	failed: false,
	limit: 5,
});

assert.equal(references[0].historyId, "turn-2");
assert.ok(references[0].preview.length <= 160);
assert.deepEqual(
	navigator.load(["turn-2", "user-1"]).map((item) => item.id),
	["turn-2", "user-1"],
);
```

Retain this browse matrix:

```typescript
assert.deepEqual(ids(navigator.browse({ direction: "backward", count: 2 })), ["h4", "h3"]);
assert.deepEqual(ids(navigator.browse({ direction: "forward", count: 2 })), ["h0", "h1"]);
assert.deepEqual(ids(navigator.browse({ direction: "around", count: 3 })), ["h2", "h3", "h4"]);
assert.deepEqual(ids(navigator.browse({ historyId: "h2", direction: "backward", count: 2 })), ["h1", "h0"]);
assert.deepEqual(ids(navigator.browse({ sequence: 2, direction: "forward", count: 2 })), ["h3", "h4"]);
assert.deepEqual(ids(navigator.browse({ historyId: "h2", direction: "around", count: 3 })), ["h1", "h2", "h3"]);
assert.deepEqual(ids(navigator.browse({ historyId: "h4", direction: "backward", count: 2, stride: 2 })), ["h2", "h0"]);
assert.deepEqual(ids(navigator.browse({ historyId: "h2", direction: "around", count: 3, stride: 2 })), ["h0", "h2", "h4"]);
```

Also cover these rules:

- Search is case-insensitive.
- All supplied filters apply together.
- Search ranks content, tool names, and file-like arguments.
- Empty unanchored browse returns `[]`.
- Explicit `historyId` and `sequence` together cause an error.
- An unknown explicit anchor causes `UNKNOWN_HISTORY_ANCHOR`.
- One unknown ID makes `load()` fail without partial output.
- A paging-tool turn never appears in search, browse, or load.
- `rebuild()` replaces the old branch index.

- [ ] **Step 2: Run the test and observe the red state**

Run:

```sh
node --test --experimental-strip-types extensions/context-paging/navigator.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `navigator.ts`.

- [ ] **Step 3: Implement the navigator interface**

Use these exact public types:

```typescript
export type HistorySearchInput = {
	query: string;
	files?: string[];
	tools?: string[];
	failed?: boolean;
	limit?: number;
};

export type HistoryBrowseInput = {
	historyId?: string;
	sequence?: number;
	direction: "backward" | "forward" | "around";
	count?: number;
	stride?: number;
};

export type HistoryReference = {
	historyId: string;
	sequence: number;
	kind: HistoryItem["kind"];
	timestamp: string;
	preview: string;
	tools: string[];
	files: string[];
	failed: boolean;
	previousHistoryId: string | null;
	nextHistoryId: string | null;
};

export type HistoryNavigatorErrorCode =
	| "INVALID_HISTORY_NAVIGATOR_INPUT"
	| "UNKNOWN_HISTORY_ANCHOR"
	| "UNKNOWN_HISTORY_ID";

export class HistoryNavigatorError extends Error {
	constructor(readonly code: HistoryNavigatorErrorCode, message: string) {
		super(message);
		this.name = "HistoryNavigatorError";
	}
}

export class HistoryNavigator {
	constructor(items?: readonly HistoryItem[]);
	rebuild(items: readonly HistoryItem[]): void;
	search(input: HistorySearchInput): HistoryReference[];
	browse(input: HistoryBrowseInput): HistoryReference[];
	load(historyIds: readonly string[]): HistoryItem[];
}
```

Port the ranking and validation behavior from commit `5fda8aa`. Keep the module independent from context selection.

- [ ] **Step 4: Run the navigator test**

Run:

```sh
node --test --experimental-strip-types extensions/context-paging/navigator.test.ts
```

Expected: PASS with the complete browse matrix.

- [ ] **Step 5: Run the raw-history and navigator tests together**

Run:

```sh
node --test --experimental-strip-types \
  extensions/context-paging/history.test.ts \
  extensions/context-paging/navigator.test.ts
```

Expected: PASS with no paging-tool turns in navigator results.

- [ ] **Step 6: Commit the navigator**

```sh
git add extensions/context-paging/navigator.ts extensions/context-paging/navigator.test.ts
git commit -m "feat(context-paging): restore history navigator"
```

---

### Task 3: Restore exact output reads without automatic replacement

**Files:**
- Create: `extensions/context-paging/output-pages.test.ts`
- Create: `extensions/context-paging/output-pages.ts`

**Interfaces:**
- Consumes: raw `HistoryItem` values from Task 1.
- Produces: `MAXIMUM_OUTPUT_PAGE_CHARACTERS`, `ContextOutputReadInput`, `ContextOutputPage`, and `readContextOutput()`.
- Does not produce: `MAXIMUM_INLINE_OUTPUT_BYTES`, `pageTurnOutputs()`, `pageAllTurnOutputs()`, or `PagedTurnView`.

- [ ] **Step 1: Write exact-read tests**

Create one model-turn fixture with these outputs:

```typescript
const assistantText = "a".repeat(20_000);
const resultText = "b".repeat(20_000);
```

Assert exact serialized paging:

```typescript
const first = readContextOutput([turn], {
	historyId: turn.id,
	source: "toolResult",
	toolCallId: "call-1",
	limit: 2_000,
});

assert.equal(first.offset, 0);
assert.equal(first.text.length, 2_000);
assert.equal(first.nextOffset, 2_000);

const final = readContextOutput([turn], {
	historyId: turn.id,
	source: "toolResult",
	toolCallId: "call-1",
	offset: first.totalCharacters,
});
assert.equal(final.text, "");
assert.equal(final.nextOffset, null);
```

Add table tests that reject:

- an unknown history ID
- a user history item
- an unknown assistant `contentIndex`
- an unknown result `toolCallId`
- both discriminators together
- a missing required discriminator
- a negative or fractional offset
- a limit outside `1..2_000`
- an offset beyond the serialized output length.

- [ ] **Step 2: Run the test and observe the red state**

Run:

```sh
node --test --experimental-strip-types extensions/context-paging/output-pages.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `output-pages.ts`.

- [ ] **Step 3: Implement only exact page reads**

Use this public interface:

```typescript
export const MAXIMUM_OUTPUT_PAGE_CHARACTERS = 2_000;

export type ContextOutputReadInput = {
	historyId: string;
	source: "assistant" | "toolResult";
	contentIndex?: number;
	toolCallId?: string;
	offset?: number;
	limit?: number;
};

export type ContextOutputPage = {
	offset: number;
	nextOffset: number | null;
	totalCharacters: number;
	text: string;
};

export function readContextOutput(
	items: readonly HistoryItem[],
	input: ContextOutputReadInput,
): ContextOutputPage;
```

Serialize the selected assistant content block or complete tool-result message with `JSON.stringify`. Slice the serialized text only after all validation passes.

Do not port any fixed 16KB output-replacement code from `5fda8aa`.

- [ ] **Step 4: Run the exact-read test**

Run:

```sh
node --test --experimental-strip-types extensions/context-paging/output-pages.test.ts
```

Expected: PASS. Both 20,000-character fixtures remain available through exact raw-history reads.

- [ ] **Step 5: Commit the output reader**

```sh
git add extensions/context-paging/output-pages.ts extensions/context-paging/output-pages.test.ts
git commit -m "feat(context-paging): restore exact output reads"
```

---

### Task 4: Select normal canonical context by estimated tokens

**Files:**
- Create: `extensions/context-paging/context-policy.test.ts`
- Create: `extensions/context-paging/context-policy.regression.test.ts`
- Create: `extensions/context-paging/context-policy.ts`

**Interfaces:**
- Consumes: canonical `AgentMessage[]`, the system prompt, active tool definitions, the model context window, and optional raw history items.
- Produces: `CONTEXT_TOKEN_BUDGET`, `ResidentToolDefinition`, `ContextSelectionInput`, `ContextSelection`, `ContextSelectionError`, and `selectContext()`.
- Uses raw history only to add stable recovery references. It never uses raw history to rebuild messages.

- [ ] **Step 1: Write accounting and pass-through tests**

Use Pi's estimator in the test oracle:

```typescript
import { estimateTokens } from "@earendil-works/pi-coding-agent";

const systemMessage = {
	role: "user" as const,
	content: "system prompt",
	timestamp: 0,
};
const toolMessage = {
	role: "user" as const,
	content: JSON.stringify([{ name: "read", description: "Read", parameters: { type: "object" } }]),
	timestamp: 0,
};
const expected = estimateTokens(systemMessage)
	+ estimateTokens(toolMessage)
	+ messages.reduce((total, message) => total + estimateTokens(message), 0);

const selection = selectContext({
	messages,
	systemPrompt: systemMessage.content,
	activeTools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
	modelContextWindow: 100_000,
});

assert.equal(CONTEXT_TOKEN_BUDGET, 64_000);
assert.equal(selection.estimatedTokens, expected);
assert.equal(selection.budgetTokens, 64_000);
assert.deepEqual(selection.messages, messages);
```

Use strings with emoji, JSON punctuation, and repeated whitespace. These inputs guard against a bytes-based or characters-based substitute.

Add a model-window case:

```typescript
assert.equal(selectContext({
	messages: [],
	systemPrompt: "resident",
	activeTools: [],
	modelContextWindow: 32_000,
}).budgetTokens, 32_000);
```

- [ ] **Step 2: Write coherent-selection tests**

Build canonical fixtures directly. Do not call `projectActiveBranch()` to create selector input.

Cover these cases:

```typescript
assert.deepEqual(rolesAndMarkers(selection.messages), [
	["user", "new request"],
	["assistant", "new answer"],
]);
assert.equal(hasMarker(selection.messages, "old request"), false);
assert.equal(hasMarker(selection.messages, "old answer"), false);
```

Add exact assertions for these rules:

- Prefix summary units leave before later user turns.
- Old completed user turns leave with all of their answers.
- The active user message never leaves normal selection.
- The active turn loses its oldest completed assistant exchanges first.
- The newest active exchanges remain.
- One assistant tool call and all matching results stay together.
- Parallel calls and results stay together.
- No orphan tool result enters the selected output.
- An output larger than 16,000 bytes stays byte-for-byte equal when the complete input fits.
- The first generated notice starts with `[Context paging notice — generated by the extension]`.
- The generated notice appears before retained canonical messages.
- The generated notice estimate can force one additional old unit to leave.
- A notice for a matched evicted item includes a valid raw `historyId`.
- The notice names `search_history`, `browse_history`, `load_history`, and `read_context_output`.
- A canonical compaction summary remains until FIFO selection removes it.
- An invalid or missing model context window causes `INVALID_MODEL_CONTEXT`.
- Resident input above the usable budget causes `RESIDENT_INPUT_TOO_LARGE`.
- Resident input plus the active user message above the budget causes `ACTIVE_REQUEST_TOO_LARGE`.

- [ ] **Step 3: Write the observed-session regression test before the selector**

Create `context-policy.regression.test.ts`. The fixture must contain:

1. an old completed requirements request and answer
2. a recent simple request and answer
3. a current user request
4. repeated assistant tool exchanges for the current request.

Use markers that expose incoherent output:

```typescript
const messages = observedSessionFixture({
	oldRequest: "OLD_REQUIREMENTS_REQUEST",
	oldAnswer: "OLD_REQUIREMENTS_ANSWER",
	recentRequest: "RECENT_SIMPLE_REQUEST",
	recentAnswer: "RECENT_SIMPLE_ANSWER",
	activeRequest: "ACTIVE_IMPLEMENTATION_REQUEST",
	exchangeCount: 8,
});

const selected = selectContext({
	messages,
	systemPrompt: "resident prompt",
	activeTools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
	modelContextWindow: 64_000,
});

assert.equal(hasMarker(selected.messages, "ACTIVE_IMPLEMENTATION_REQUEST"), true);
assertCompletedTurnsAreCoherent(selected.messages);
assert.equal(
	hasMarker(selected.messages, "OLD_REQUIREMENTS_REQUEST")
		&& !hasMarker(selected.messages, "OLD_REQUIREMENTS_ANSWER"),
	false,
);
```

Size fixture content with repeated deterministic text. Make the complete fixture exceed the budget. Keep the newest active exchanges small enough to fit.

- [ ] **Step 4: Run the policy tests and observe the red state**

Run:

```sh
node --test --experimental-strip-types \
  extensions/context-paging/context-policy.test.ts \
  extensions/context-paging/context-policy.regression.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `context-policy.ts`.

- [ ] **Step 5: Define the selector interface and error codes**

Create these exports:

```typescript
export const CONTEXT_TOKEN_BUDGET = 64_000;

export type ResidentToolDefinition = {
	name: string;
	description: string;
	parameters: unknown;
};

export type ContextSelectionInput = {
	messages: readonly AgentMessage[];
	systemPrompt: string;
	activeTools: readonly ResidentToolDefinition[];
	modelContextWindow: number | undefined;
	rawHistoryItems?: readonly HistoryItem[];
};

export type ContextSelectionMode = "within-budget" | "paged" | "protected-overflow" | "recovery";

export type ContextSelection = {
	messages: AgentMessage[];
	estimatedTokens: number;
	budgetTokens: number;
	mode: ContextSelectionMode;
};

export type ContextSelectionErrorCode =
	| "INVALID_MODEL_CONTEXT"
	| "RESIDENT_INPUT_TOO_LARGE"
	| "ACTIVE_REQUEST_TOO_LARGE"
	| "INVALID_MESSAGE_STRUCTURE";

export class ContextSelectionError extends Error {
	constructor(
		readonly code: ContextSelectionErrorCode,
		message: string,
		readonly residentTokens?: number,
		readonly estimatedTokens?: number,
		readonly budgetTokens?: number,
	) {
		super(message);
		this.name = "ContextSelectionError";
	}
}
```

The error message must call all token values estimates.

- [ ] **Step 6: Implement Pi-based accounting**

Import the estimator directly:

```typescript
import { estimateTokens } from "@earendil-works/pi-coding-agent";
```

Estimate the resident inputs with temporary user messages:

```typescript
const temporaryUserMessage = (content: string): UserMessage => ({
	role: "user",
	content,
	timestamp: 0,
});

const residentTokens = estimateTokens(temporaryUserMessage(input.systemPrompt))
	+ estimateTokens(temporaryUserMessage(JSON.stringify(
		input.activeTools.map(({ name, description, parameters }) => ({ name, description, parameters })),
	)));
```

Estimate each retained canonical message with `estimateTokens(message)`. Do not add the temporary messages to the returned array.

- [ ] **Step 7: Implement canonical grouping and FIFO selection**

Keep the grouping types private to `context-policy.ts`:

```typescript
type ToolExchange = {
	assistant: AssistantMessage;
	results: ToolResultMessage[];
	messages: AgentMessage[];
};

type PrefixUnit = { kind: "prefix"; messages: AgentMessage[] };
type CompletedTurnUnit = { kind: "completedTurn"; messages: AgentMessage[] };
type ActiveTurnUnit = {
	kind: "activeTurn";
	user: UserMessage;
	exchanges: ToolExchange[];
};
```

Use `isToolCallBlock` from `@mariozechner/pi-agent-core` to find tool calls. Treat an assistant message without tool calls as one exchange with an empty result list.

Apply this order:

1. Group canonical prefix messages before the first normal user message.
2. Group each completed user turn through the message before the next user.
3. Treat the newest user turn as active.
4. Validate every assistant tool call against contiguous matching results.
5. Preserve canonical order inside all units.
6. Return the original message objects when the full candidate fits.
7. Remove prefix units and completed user turns from oldest to newest.
8. If required, remove completed active-turn exchanges from oldest to newest.
9. Add one synthetic notice after the first removal.
10. Recalculate the total after every removal because the notice consumes tokens.

Build the normal notice from these exact lines:

```typescript
const lines = [
	"[Context paging notice — generated by the extension]",
	"Older context left the 64,000-token rolling window. Raw session history is unchanged.",
	"Use search_history or browse_history to find stored items.",
	"Use load_history for exact items or read_context_output for exact output pages.",
];
if (matchedHistoryId !== undefined) {
	lines.push(`Recent evicted historyId: ${JSON.stringify(matchedHistoryId)}.`);
}
```

Add the last line only when a canonical evicted message matches one raw history item. Use the actual stored ID.

If the resident input alone exceeds the budget, throw `RESIDENT_INPUT_TOO_LARGE`.

If the resident input plus the complete active user message exceeds the budget, throw `ACTIVE_REQUEST_TOO_LARGE`.

If canonical messages contain an orphan result or an incomplete older exchange, throw `INVALID_MESSAGE_STRUCTURE`.

- [ ] **Step 8: Run the normal policy and regression tests**

Run:

```sh
node --test --experimental-strip-types \
  extensions/context-paging/context-policy.test.ts \
  extensions/context-paging/context-policy.regression.test.ts
```

Expected: PASS for accounting, coherent FIFO removal, large unchanged output, notice accounting, and the observed-session fixture.

- [ ] **Step 9: Commit normal context selection**

```sh
git add \
  extensions/context-paging/context-policy.ts \
  extensions/context-paging/context-policy.test.ts \
  extensions/context-paging/context-policy.regression.test.ts
git commit -m "feat(context-paging): select canonical rolling context"
```

---

### Task 5: Protect one unread tool-result exchange

**Files:**
- Modify: `extensions/context-paging/context-policy.test.ts`
- Modify: `extensions/context-paging/context-policy.ts`

**Interfaces:**
- Extends: `selectContext()` from Task 4.
- Uses: `findModelTurnByToolCallId()` from Task 1 for stable raw-history references.
- Preserves: the Task 4 public selector interface.

- [ ] **Step 1: Write protected-follow-up tests**

Create a canonical active turn that ends with one assistant tool-call message and matching results. Make the total exceed `64_000`, but keep it below a `100_000` model window.

Assert:

```typescript
const selected = selectContext({
	messages,
	systemPrompt: "resident prompt",
	activeTools: [],
	modelContextWindow: 100_000,
	rawHistoryItems,
});

assert.equal(selected.mode, "protected-overflow");
assert.ok(selected.estimatedTokens > 64_000);
assert.ok(selected.estimatedTokens <= 100_000);
assert.equal(hasToolCall(selected.messages, "new-call"), true);
assert.equal(hasToolResult(selected.messages, "new-call"), true);
assert.equal(hasMarker(selected.messages, "older completed turn"), false);
assert.match(noticeText(selected.messages), /present in full for this follow-up call/);
```

Include two parallel tool calls. Assert that both calls and both results remain.

Assert that no old prefix, completed turn, or removable active exchange remains during overflow.

- [ ] **Step 2: Write the subsequent-call test**

Append a normal assistant response after the prior tool exchange. This raw position means that the exchange is no longer unread.

```typescript
const selected = selectContext({
	messages: [
		...messages,
		assistantText("MODEL_HAS_RESPONDED"),
		userText("NEXT_REQUEST"),
	],
	systemPrompt: "resident prompt",
	activeTools: [],
	modelContextWindow: 100_000,
	rawHistoryItems: [...rawHistoryItems, respondedTurn, nextUserItem],
});

assert.notEqual(selected.mode, "protected-overflow");
assert.equal(hasMarker(selected.messages, "large old result"), false);
assert.match(noticeText(selected.messages), /"historyId":"raw-turn-id"/);
assert.match(noticeText(selected.messages), /"toolCallId":"old-call"/);
```

The notice must include exact `read_context_output` arguments with `offset: 0` and `limit: 2000`.

- [ ] **Step 3: Write the actual-model-limit recovery test**

Make the protected result exceed the active model's declared context window.

Assert:

```typescript
const recovered = selectContext({
	messages: oversizedProtectedMessages,
	systemPrompt: "resident prompt",
	activeTools: [],
	modelContextWindow: 70_000,
	rawHistoryItems,
});

assert.equal(recovered.mode, "recovery");
assert.ok(recovered.estimatedTokens <= 70_000);
assert.equal(hasToolCall(recovered.messages, "huge-call"), true);
const result = findToolResult(recovered.messages, "huge-call");
assert.equal(result.toolCallId, "huge-call");
assert.equal(result.toolName, "read");
assert.match(textOf(result), /read_context_output/);
assert.match(textOf(result), /"historyId":"raw-huge-turn"/);
```

Also assert that the raw result object and the original canonical result object remain deeply unchanged.

- [ ] **Step 4: Run the new cases and observe the red state**

Run:

```sh
node --test --experimental-strip-types \
  --test-name-pattern="protected|subsequent|model limit" \
  extensions/context-paging/context-policy.test.ts
```

Expected: FAIL because Task 4 does not permit protected overflow or emergency replacement.

- [ ] **Step 5: Detect the unread trailing exchange**

A protected exchange must meet all these conditions:

1. It is the last canonical exchange.
2. Its assistant message contains at least one tool call.
3. Every call has a matching trailing result.
4. No later assistant response exists.
5. The raw branch ends with the same tool-call batch and matching results.

Use tool-call IDs to connect the canonical exchange to `rawHistoryItems`. Do not persist a read marker.

- [ ] **Step 6: Implement protected overflow**

Use this selection order:

1. Remove all old completed units.
2. Remove all removable active-turn exchanges.
3. Keep the active user message.
4. Keep the protected exchange.
5. Add one overflow notice.
6. Permit an estimate above `budgetTokens` only when the estimate does not exceed `modelContextWindow`.

The overflow notice must state:

```text
[Context paging notice — generated by the extension]
The newest tool-result exchange is present in full for this follow-up call.
The normal rolling budget is 64,000 estimated tokens.
This exchange can leave context after this call.
Use search_history or browse_history, then load_history or read_context_output, to recover it.
```

- [ ] **Step 7: Implement emergency recovery content**

If the protected exchange still exceeds the actual model window, clone only the outbound result messages. Replace each result content payload with a text block like this:

```text
[Context paging recovery — generated by the extension]
This tool result exceeded the active model context window.
Read the exact stored result with read_context_output({"historyId":"raw-huge-turn","source":"toolResult","toolCallId":"huge-call","offset":0,"limit":2000}).
```

Keep `role`, `toolCallId`, `toolName`, `isError`, `timestamp`, `usage`, and other envelope fields. Keep the assistant tool-call message unchanged.

Do not modify `event.messages` or raw history objects in place.

- [ ] **Step 8: Run all policy tests**

Run:

```sh
node --test --experimental-strip-types \
  extensions/context-paging/context-policy.test.ts \
  extensions/context-paging/context-policy.regression.test.ts
```

Expected: PASS. Only the protected exchange can produce a temporary overflow.

- [ ] **Step 9: Commit protected overflow**

```sh
git add extensions/context-paging/context-policy.ts extensions/context-paging/context-policy.test.ts
git commit -m "feat(context-paging): protect unread tool results"
```

---

### Task 6: Register the four public recovery tools

**Files:**
- Create: `extensions/context-paging/tools.test.ts`
- Create: `extensions/context-paging/tools.ts`

**Interfaces:**
- Consumes: `HistoryNavigator`, `readContextOutput()`, and raw history items.
- Produces: `HistorySnapshot`, `ContextPagingToolDependencies`, and `registerContextPagingTools()`.
- Registers exactly four tools.

- [ ] **Step 1: Write tool-registration and schema tests**

Build a fake `ExtensionAPI` that records tool definitions.

Assert exact registration:

```typescript
assert.deepEqual(tools.map((tool) => tool.name), [
	"search_history",
	"browse_history",
	"load_history",
	"read_context_output",
]);
assert.equal(tools.some((tool) => tool.name === "update_task_state"), false);
```

Serialize each TypeBox schema. Assert `type: "object"` and `additionalProperties: false`.

Assert these bounds:

```typescript
assert.deepEqual(search.properties.limit, {
	minimum: 1,
	maximum: 10,
	default: 5,
	type: "integer",
});
assert.deepEqual(load.properties.historyIds, {
	minItems: 1,
	maxItems: 3,
	type: "array",
	items: { maxLength: 128, type: "string" },
});
assert.deepEqual(output.properties.limit, {
	minimum: 1,
	maximum: 2_000,
	default: 2_000,
	type: "integer",
});
```

- [ ] **Step 2: Write execution contract tests**

Cover these behaviors:

```typescript
assert.deepEqual(details(await execute(search, { query: "alpha", load: true })).items
	.map((item: HistoryItem) => item.id), ["u1", "u2", "u3"]);
assert.deepEqual(details(await execute(load, { historyIds: ["u3", "u1"] })).items
	.map((item: HistoryItem) => item.id), ["u3", "u1"]);
await assert.rejects(() => execute(load, { historyIds: ["u1", "missing"] }), /Unknown history ID missing/);
```

Also assert:

- Search and browse compact replies reject serialized output above 8,000 characters.
- Exact loads are not subject to the compact-reply limit.
- `read_context_output` supports repeated calls through `nextOffset`.
- Each execution uses one current snapshot.
- Disabled tools reject before requesting a snapshot.
- Tool descriptions name the recovery tools and repeated output-read process.

- [ ] **Step 3: Run the test and observe the red state**

Run:

```sh
node --test --experimental-strip-types extensions/context-paging/tools.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `tools.ts`.

- [ ] **Step 4: Define strict schemas and dependencies**

Use these exact dependency types:

```typescript
export type HistorySnapshot = {
	allItems: readonly HistoryItem[];
	navigator: HistoryNavigator;
};

export type ContextPagingToolDependencies = {
	isEnabled(): boolean;
	snapshot(ctx: ExtensionContext): HistorySnapshot;
};
```

Define strict root schemas for the approved contracts. Use `StringEnum` for `direction` and `source`.

- [ ] **Step 5: Implement the four handlers**

Use this registration function:

```typescript
export function registerContextPagingTools(
	pi: ExtensionAPI,
	dependencies: ContextPagingToolDependencies,
): void;
```

Keep these response rules:

- `search_history` returns references unless `load: true`.
- `search_history({ load: true })` loads the first three matches.
- `browse_history` returns references.
- `load_history` returns exact items in requested order.
- `read_context_output` returns one exact page.
- Compact reference responses have an 8,000-character serialized limit.
- Exact load and output-page responses have no 8,000-character limit.

- [ ] **Step 6: Run the tool test and focused module suite**

Run:

```sh
node --test --experimental-strip-types extensions/context-paging/*.test.ts
```

Expected: PASS for all six focused test files.

- [ ] **Step 7: Commit the public tools**

```sh
git add extensions/context-paging/tools.ts extensions/context-paging/tools.test.ts
git commit -m "feat(context-paging): register recovery tools"
```

---

### Task 7: Connect settings, lifecycle, context, and compaction

**Files:**
- Create: `extensions/context-paging/index.test.ts`
- Create: `extensions/context-paging/index.ts`

**Interfaces:**
- Consumes: all context-paging modules from Tasks 1 through 6.
- Produces: `ContextPagingSettingsSources`, `resolveContextPagingEnabled()`, and the default Pi extension factory.
- Keeps context selection valid when raw-history navigation fails.

- [ ] **Step 1: Write settings and registration tests**

Cover the complete precedence matrix:

```typescript
assert.equal(resolveContextPagingEnabled({ globalSettings: {}, projectTrusted: false }), true);
assert.equal(resolveContextPagingEnabled({
	globalSettings: { contextPaging: { enabled: false } },
	projectTrusted: false,
}), false);
assert.equal(resolveContextPagingEnabled({
	globalSettings: { contextPaging: { enabled: false } },
	projectSettings: { contextPaging: { enabled: true } },
	projectTrusted: true,
}), true);
assert.equal(resolveContextPagingEnabled({
	globalSettings: { contextPaging: { enabled: false } },
	projectSettings: { contextPaging: { enabled: true } },
	projectTrusted: false,
}), false);
assert.equal(resolveContextPagingEnabled({
	globalSettings: { contextPaging: { enabled: true } },
	projectSettings: { contextPaging: { enabled: "yes" } },
	projectTrusted: true,
}), true);
```

Assert exactly four registered tools and these handlers:

```typescript
assert.deepEqual([...handlers.keys()].sort(), [
	"context",
	"session_before_compact",
	"session_start",
	"session_tree",
	"turn_end",
]);
assert.equal(handlers.has("session_before_tree"), false);
```

- [ ] **Step 2: Write lifecycle rebuild tests**

For each start reason, replace the fake branch and emit `session_start`:

```typescript
for (const reason of ["startup", "new", "resume", "fork", "reload"] as const) {
	harness.setBranch(branchFor(reason));
	await emit(harness, "session_start", { reason });
	assert.deepEqual(await searchIds(harness, reason), [`user-${reason}`]);
}
```

Then cover:

- `turn_end` rebuilds the current active branch.
- successful `session_tree` rebuilds the new branch.
- tree navigation is not cancelled.
- tools describe only the current branch after navigation.

- [ ] **Step 3: Write canonical-context and failure-isolation tests**

Pass canonical `event.messages` that differ from the raw branch. Assert that the returned messages come from the event, not raw projection.

```typescript
const result = await emit(harness, "context", { messages: canonicalMessages });
assert.equal(hasMarker((result as any).messages, "CANONICAL_ONLY"), true);
assert.equal(hasMarker((result as any).messages, "RAW_ONLY"), false);
```

Make raw projection throw `ORPHAN_TOOL_RESULT`. Keep canonical messages valid.

Configure one small active tool, one missing definition, and one large inactive definition. Assert that only the small active definition affects selection.

Assert:

```typescript
assert.deepEqual(await emit(harness, "context", { messages: canonicalMessages }), {
	messages: canonicalMessages,
});
assert.equal(harness.abortCalls(), 0);
assert.match(harness.notifications.at(-1)?.message ?? "", /ORPHAN_TOOL_RESULT/);
```

Then pass malformed canonical messages. Assert that the handler calls `ctx.abort()`, shows an error, and returns the incoming event messages as a non-mutated fallback.

- [ ] **Step 4: Write storage and notice tests**

Copy the raw branch and canonical messages before a paged selection.

```typescript
const rawBefore = structuredClone(harness.branch());
const canonicalBefore = structuredClone(canonicalMessages);
await emit(harness, "context", { messages: canonicalMessages });
assert.deepEqual(harness.branch(), rawBefore);
assert.deepEqual(canonicalMessages, canonicalBefore);
assert.equal(harness.appendCalls(), 0);
```

Emit `context` twice. Assert that each returned result has at most one generated notice. Assert that stored history has none.

- [ ] **Step 5: Write compaction-reason tests**

Assert exact results:

```typescript
assert.deepEqual(await emit(harness, "session_before_compact", { reason: "threshold" }), { cancel: true });
assert.deepEqual(await emit(harness, "session_before_compact", { reason: "overflow" }), { cancel: true });
assert.equal(await emit(harness, "session_before_compact", { reason: "manual" }), undefined);
```

Disable context paging. Assert that all three reasons return `undefined` and `context` returns no replacement.

- [ ] **Step 6: Run the test and observe the red state**

Run:

```sh
node --test --experimental-strip-types extensions/context-paging/index.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `index.ts`.

- [ ] **Step 7: Implement settings and active-tool resolution**

Use this settings interface:

```typescript
export type ContextPagingSettingsSources = {
	globalSettings: unknown;
	projectSettings?: unknown;
	projectTrusted: boolean;
};

export function resolveContextPagingEnabled(
	sources: ContextPagingSettingsSources,
): boolean;
```

Default to enabled. Read project settings only for a trusted project.

Resolve active definitions like this:

```typescript
const activeNames = new Set(pi.getActiveTools());
return pi.getAllTools()
	.filter((tool) => activeNames.has(tool.name))
	.map(({ name, description, parameters }) => ({ name, description, parameters }));
```

Inactive schemas must not consume the token budget.

- [ ] **Step 8: Implement isolated navigator rebuilds**

Maintain one `HistoryNavigator` and one current `allItems` array.

Use one rebuild function for lifecycle handlers and tool snapshots:

```typescript
const rebuild = (ctx: ExtensionContext): HistorySnapshot => {
	const projected = projectActiveBranch(ctx.sessionManager.getBranch());
	navigator.rebuild(projected);
	allItems = projected;
	return { allItems, navigator };
};
```

A tool snapshot can call `rebuild(ctx)` so that exact recovery sees the newest raw result.

If a lifecycle rebuild fails, show a clear navigation error. Do not abort a later valid context operation.

- [ ] **Step 9: Implement the canonical context hook**

Use `event.messages` as the selector input:

```typescript
pi.on("context", (event, ctx) => {
	if (!enabled) return;

	let rawHistoryItems: readonly HistoryItem[] | undefined;
	try {
		rawHistoryItems = rebuild(ctx).allItems;
	} catch (error) {
		ctx.ui.notify(`Context paging history is unavailable: ${errorMessage(error)}`, "error");
	}

	try {
		const selection = selectContext({
			messages: event.messages,
			systemPrompt: ctx.getSystemPrompt(),
			activeTools: activeResidentTools(pi),
			modelContextWindow: ctx.model?.contextWindow,
			rawHistoryItems,
		});
		return { messages: selection.messages };
	} catch (error) {
		ctx.abort();
		ctx.ui.notify(`Context paging aborted this provider call: ${errorMessage(error)}`, "error");
		return { messages: event.messages };
	}
});
```

Do not call `pi.appendEntry()`.

- [ ] **Step 10: Implement reason-aware compaction cancellation**

Use the event reason:

```typescript
pi.on("session_before_compact", async (event) => {
	if (!enabled) return;
	if (event.reason === "threshold" || event.reason === "overflow") {
		return { cancel: true };
	}
});
```

Do not cancel `manual`. Do not register `session_before_tree`.

- [ ] **Step 11: Run the integration and focused suites**

Run:

```sh
node --test --experimental-strip-types extensions/context-paging/index.test.ts
node --test --experimental-strip-types extensions/context-paging/*.test.ts
```

Expected: PASS. Navigator errors do not abort valid canonical selection.

- [ ] **Step 12: Commit extension integration**

```sh
git add extensions/context-paging/index.ts extensions/context-paging/index.test.ts
git commit -m "feat(context-paging): connect paging lifecycle"
```

---

### Task 8: Package the setting and runtime proof

**Files:**
- Modify: `settings.json`
- Modify: `modules/checks/pi-config-extension-load.nix:118-145`

**Interfaces:**
- Consumes: package auto-discovery for `extensions/context-paging/index.ts`.
- Produces: packaged `contextPaging.enabled: true` and runtime proof for tool registration and activation.
- Does not create: a static JSON test, a static Nix test, `loadout.json`, or a named profile.

- [ ] **Step 1: Add the packaged setting**

Insert only this new setting before the existing `handoff` block:

```json
"contextPaging": {
  "enabled": true
},
```

Do not add `handoff.autoEnabled`. Do not modify handoff code or settings.

- [ ] **Step 2: Parse the settings file directly**

Run:

```sh
python3 -m json.tool settings.json >/dev/null
```

Expected: exit status 0.

The Testing Value Gate excludes a new automated test because this change is static JSON.

- [ ] **Step 3: Add the runtime tool probe**

Add this probe after the existing tool probes in `pi-config-extension-load.nix`:

```nix
run_probe context-paging-tools \
  ${pkgs.coreutils}/bin/env \
  PI_TOOLSET_PROBE_OUTPUT="$TMPDIR/context-paging-tools.json" \
  ${selectablePi}/bin/pi \
  --no-session \
  --extension ${probeExtension} \
  -p /write-toolset-probe

python3 - "$TMPDIR/context-paging-tools.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    tools = json.load(f)

required = {
    "search_history",
    "browse_history",
    "load_history",
    "read_context_output",
}
assert required <= set(tools["all"]), tools
assert required <= set(tools["active"]), tools
assert "update_task_state" not in tools["all"], tools
assert "update_task_state" not in tools["active"], tools
PY
```

Do not add a `loadout.json` symlink or fixture.

- [ ] **Step 4: Build and inspect the package contents**

Run:

```sh
out=$(nix build .#packages.x86_64-linux.pi-config --no-link --print-out-paths)
printf '%s\n' "$out"
find "$out/extensions/context-paging" -maxdepth 1 -type f -printf '%f\n' | sort
test ! -e "$out/loadout.json"
```

Expected production files:

```text
context-policy.ts
history.ts
index.ts
navigator.ts
output-pages.ts
tools.ts
```

Expected: no `*.test.ts` file and no packaged `loadout.json`.

- [ ] **Step 5: Run the required runtime extension-load check**

Run:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: exit status 0. All four paging tools appear in both registered and active sets. `update_task_state` is absent.

- [ ] **Step 6: Commit packaging and runtime proof**

```sh
git add settings.json modules/checks/pi-config-extension-load.nix
git commit -m "feat(context-paging): package paging defaults"
```

---

### Task 9: Run final automated, package, and live verification

**Files:**
- Verify: `extensions/context-paging/*.ts`
- Verify: `settings.json`
- Verify: `modules/checks/pi-config-extension-load.nix`
- Verify: `docs/specs/2026-09-21-context-paging-design.md`
- Verify: `docs/plans/2026-09-21-context-paging.md`

**Interfaces:**
- Consumes: every completed task.
- Produces: fresh test, package, runtime, flake, live-session, diff, and adversarial-review evidence.

- [ ] **Step 1: Run the focused context-paging suite**

Run:

```sh
node --test --experimental-strip-types extensions/context-paging/*.test.ts
```

Expected: PASS with zero failures.

- [ ] **Step 2: Run the complete TypeScript suite**

Run:

```sh
node --test --experimental-strip-types \
  $(find extensions tests -name '*.test.ts' -type f | sort)
```

Expected: all tests pass. The baseline before this work was 268 passing tests. Record the new file, test, pass, fail, cancelled, and skipped counts.

- [ ] **Step 3: Repeat the package and runtime checks**

Run:

```sh
python3 -m json.tool settings.json >/dev/null
out=$(nix build .#packages.x86_64-linux.pi-config --no-link --print-out-paths)
find "$out/extensions/context-paging" -maxdepth 1 -type f -printf '%f\n' | sort
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: six production modules, no packaged tests, and a successful runtime probe.

- [ ] **Step 4: Run the full flake check**

Run:

```sh
nix flake check --accept-flake-config --print-build-logs
```

Expected: exit status 0.

- [ ] **Step 5: Inspect size, diff, and status**

Run:

```sh
wc -l extensions/context-paging/*.ts
git diff --check 5892845...HEAD
git diff --stat 5892845...HEAD
git status --short
git log --oneline 5892845..HEAD
```

Expected:

- no whitespace errors
- no production module above 400 meaningful lines
- no handoff source or handoff test changes
- no `loadout.json` or named profile
- no package-lock change
- task-focused commits after the approved design commit.

- [ ] **Step 6: Reload a live Pi session and call all four tools**

In a live session that uses the built package, run:

```text
/reload
```

Then issue these four prompts in order:

```text
Call search_history with {"query":"context paging","limit":1}. Return only the tool result.
```

Copy the returned `historyId`. Replace `HISTORY_ID` in each next prompt with that exact value.

```text
Call browse_history with {"historyId":"HISTORY_ID","direction":"around","count":3}. Return only the tool result.
```

```text
Call load_history with {"historyIds":["HISTORY_ID"]}. Return only the tool result.
```

Choose a model-turn reference from search or browse output. Then issue:

```text
Call read_context_output with the selected historyId, source, contentIndex or toolCallId, offset 0, and limit 2000. Return only the tool result.
```

Expected: all four tools execute. Exact load preserves the requested item. Output paging returns `nextOffset` or `null`.

- [ ] **Step 7: Exercise the rolling window in the live session**

Ask Pi to run a tool that returns more than 16,000 bytes:

```text
Use bash to run python3 -c 'print("BEGIN" + "x" * 20000 + "END")'. Then report whether the result starts with BEGIN and ends with END.
```

Expected: the first follow-up model call receives the complete result. No automatic 16KB recovery placeholder appears.

Continue with unique 8,000-character tool results and normal follow-up responses. Record the context token or percentage indicator in Pi's footer after each group.

Expected:

- usage grows beyond the old approximate 30,000-token ceiling
- normal paging occurs near 64,000 estimated full-input tokens
- the active user request remains
- the newest unread result receives one complete follow-up
- older context becomes available through the four history tools
- automatic threshold or overflow compaction does not replace the rolling window.

Run manual `/compact` once.

Expected: manual compaction succeeds. Its canonical summary remains available in later model context until FIFO removal.

- [ ] **Step 8: Request adversarial code review**

Dispatch the canonical `reviewer` with fresh context. Include:

- specification: `docs/specs/2026-09-21-context-paging-design.md`
- plan: `docs/plans/2026-09-21-context-paging.md`
- base: `5892845`
- head: the current implementation SHA
- focused and full TypeScript results
- package inspection results
- runtime extension-load result
- full flake result
- live-session observations.

Ask the reviewer to examine these risks:

1. token estimates bypass Pi's exported `estimateTokens`
2. raw history leaks into outbound context reconstruction
3. a user request survives without its completed answer
4. tool calls or parallel results split during removal
5. protected overflow retains any non-protected old unit
6. recovery replacement mutates canonical or stored messages
7. paging notices persist or accumulate
8. manual compaction is cancelled
9. history failures abort valid canonical selection
10. handoff or loadout behavior changes outside scope.

- [ ] **Step 9: Apply valid review findings and repeat affected checks**

Use `superpowers:receiving-code-review` before any review-driven change. For each accepted finding, write a failing regression test before the fix.

Repeat the focused suite, full TypeScript suite, runtime extension-load check, and full flake check after the final code change.

- [ ] **Step 10: Prepare branch completion options**

Use `superpowers:finishing-a-development-branch` after every check passes.

Offer local squash merge into `main` as the integration option. Do not offer a regular local merge unless the user requests preserved feature commits.
