# Context Paging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production no-ledger context-paging extension that keeps every user request, retains the newest contiguous suffix of complete model turns within a model-derived budget, and makes evicted history and large outputs exactly recoverable.

**Architecture:** Project the raw active session branch into atomic user and model-turn history items, then expose two consumers of that projection: a navigator that excludes paging-tool turns from its index, and a context policy that keeps those turns eligible for outbound selection. Keep exact output recovery in a separate module that changes only outbound copies, while the extension entry point owns settings, lifecycle hooks, context replacement, compaction cancellation, and tool registration.

**Tech Stack:** TypeScript, Pi 0.85.1 extension APIs, `@earendil-works/pi-ai`, TypeBox, `node:test`, `node:assert/strict`, JSON, Nix flakes, Home Manager.

## Global Constraints

- Register exactly `search_history`, `browse_history`, `load_history`, and `read_context_output`; never register `update_task_state` or create ledger, todo, experiment, provider-gateway, tokenizer-pin, spend-accounting, or fatal-state behavior.
- Read navigation, selection, and output recovery from `ctx.sessionManager.getBranch()`, never from compacted context, and never rewrite stored session entries.
- Treat one user message as one atomic user item and one assistant message plus all of its tool results as one atomic model turn.
- Exclude paging-tool turns only from navigator indexing, search, browse, and `load_history`; keep complete paging-tool turns eligible for outbound context so each tool result is visible on the immediate follow-up request.
- Let `read_context_output` resolve raw predecessor paging-tool turns so repeated reads can recover a paged `search_history`, `browse_history`, `load_history`, or `read_context_output` result.
- Preserve every active-branch user request exactly and in chronological order.
- Retained model turns must form one newest contiguous complete-turn suffix. Do not skip an oversized intervening turn to include an older turn.
- Measure the chained system prompt, every active tool name/description/schema, and selected messages by serialized UTF-8 bytes. The maximum measured input is `Math.floor(ctx.model.contextWindow * 0.60)`.
- Treat one UTF-8 byte as one token-equivalent accounting unit. Do not use provider names, model names, `maxTokens`, or a pinned tokenizer.
- Page an assistant content block or complete tool-result message when its serialized JSON exceeds `16_000` UTF-8 bytes. Each `read_context_output` page contains at most `2_000` JavaScript UTF-16 code units.
- Keep tool exchanges complete in outbound context and preserve tool-call ID, tool name, namespace, result error state, and ordering in paged copies.
- `search_history` and `browse_history` compact responses must serialize to at most `8_000` characters. Exact `load_history` results and `search_history({ load: true })` results are not subject to that reference-response limit.
- Browse semantics are fixed:
  - an explicit `backward` or `forward` anchor is excluded;
  - unanchored `backward` includes the newest item and returns newest-first;
  - unanchored `forward` includes the oldest item and returns oldest-first;
  - `around` includes its anchor, returns chronologically, centers its stride-aligned window when possible, and shifts at boundaries;
  - unanchored `around` uses the newest item;
  - an unanchored empty browse returns `[]`; an unknown explicit anchor is an error.
- A trusted project may override `contextPaging.enabled` and `handoff.autoEnabled`; an untrusted project may not. Invalid or absent project values fall back to the global value. Packaged defaults are `contextPaging.enabled: true`, `handoff.autoEnabled: false`, and `handoff.autoThresholdTokens: 150000`.
- When context paging is disabled, keep all four tools registered but make executions fail clearly. Do not replace context or cancel compaction.
- Automatic handoff starts disabled on every startup, new session, resume, fork, and reload unless valid settings enable it. `/handoff auto on` remains a current-session opt-in, and manual `/handoff <goal>` remains unchanged.
- Add no new external dependency. Keep production files focused and normally below 400 meaningful lines; split tests by production module.
- Do not add automated tests that merely restate static JSON or Nix source. Parse static JSON directly and verify packaging through the runtime extension-load check and full flake check.

## File Map

- `extensions/context-paging/history.ts`: raw active-branch projection, atomic history types, paging-turn classification, file/tool metadata, and message flattening.
- `extensions/context-paging/navigator.ts`: in-memory navigator, relevance ranking, compact references, exact browse semantics, validation, and atomic exact loading.
- `extensions/context-paging/output-pages.ts`: immutable outbound paging, stable references, and exact page reads from projected raw history.
- `extensions/context-paging/context-policy.ts`: resident-context byte accounting, mandatory users, contiguous suffix selection, and outbound message construction.
- `extensions/context-paging/tools.ts`: the four strict Pi tool definitions, disabled guards, compact response limits, and runtime argument validation.
- `extensions/context-paging/index.ts`: default extension factory, settings resolution, active-branch rebuilds, lifecycle hooks, context replacement, abort notices, and compaction cancellation.
- `extensions/context-paging/*.test.ts`: focused behavioral tests beside each production module.
- `extensions/handoff-auto.ts`, `extensions/handoff.ts`, `tests/extensions/handoff-auto.test.ts`, `tests/extensions/handoff.test.ts`: packaged automatic-handoff opt-in default.
- `settings.json`, `modules/checks/pi-config-extension-load.nix`: packaged defaults and runtime proof without managing the user's loadout state.

---

### Task 1: Project the raw active branch into atomic history

**Files:**
- Create: `extensions/context-paging/history.ts`
- Create: `extensions/context-paging/history.test.ts`

**Interfaces:**
- Consumes: Pi `SessionEntry[]` from `ctx.sessionManager.getBranch()` and Pi AI user, assistant, tool-call, and tool-result message types.
- Produces:
  - `PAGING_TOOL_NAMES`
  - `PagingToolName`
  - `UserHistoryItem`
  - `ModelTurnHistoryItem`
  - `HistoryItem`
  - `HistoryProjectionError`
  - `projectActiveBranch(entries: readonly SessionEntry[]): HistoryItem[]`
  - `isPagingToolTurn(item: HistoryItem): boolean`
  - `flattenHistoryItems(items: readonly HistoryItem[]): AgentMessage[]`

- [ ] **Step 1: Write the atomic projection tests**

Create fixtures that use stored entry IDs and ISO entry timestamps, then cover one user item and one assistant-plus-results turn:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import {
	flattenHistoryItems,
	HistoryProjectionError,
	isPagingToolTurn,
	projectActiveBranch,
} from "./history.ts";

const userEntry = (id: string, content: string) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: `2026-09-21T00:00:0${id.length}.000Z`,
	message: { role: "user", content, timestamp: 1 },
});

const assistantEntry = (id: string, content: unknown[]) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-09-21T00:00:10.000Z",
	message: {
		role: "assistant",
		content,
		api: "test",
		provider: "provider-a",
		model: "model-a",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	},
});

const resultEntry = (id: string, toolCallId: string, text: string, isError = false) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-09-21T00:00:11.000Z",
	message: {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError,
		timestamp: 3,
	},
});

test("projects users and complete assistant tool exchanges as atomic items", () => {
	const entries = [
		userEntry("user-1", "inspect src/index.ts"),
		assistantEntry("turn-1", [
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } },
		]),
		resultEntry("result-1", "call-1", "file contents"),
		{ type: "label", id: "label-1", parentId: null, timestamp: "2026-09-21T00:00:12.000Z" },
	] as any;

	const items = projectActiveBranch(entries);
	assert.equal(items.length, 2);
	assert.equal(items[0].id, "user-1");
	assert.equal(items[0].sequence, 0);
	assert.equal(items[1].id, "turn-1");
	assert.equal(items[1].sequence, 1);
	assert.deepEqual(items[1].kind === "modelTurn" ? items[1].metadata : undefined, {
		tools: ["read"],
		files: ["src/index.ts"],
		failed: false,
	});
	assert.deepEqual(flattenHistoryItems(items), [
		entries[0].message,
		entries[1].message,
		entries[2].message,
	]);
});
```

Add parameterized assertions that each of the four paging tool names makes `isPagingToolTurn()` true. Also assert that a mixed assistant turn containing a paging tool and another tool is classified as a paging turn.

- [ ] **Step 2: Add malformed and incomplete-turn tests**

Add these cases:

```typescript
test("omits only an incomplete newest assistant turn", () => {
	const entries = [
		userEntry("user-1", "search"),
		assistantEntry("turn-1", [
			{ type: "toolCall", id: "call-1", name: "search_history", arguments: { query: "x" } },
		]),
	] as any;
	assert.deepEqual(projectActiveBranch(entries).map((item) => item.id), ["user-1"]);
});

test("rejects incomplete older turns and orphan or duplicate results", () => {
	const incompleteOlder = [
		assistantEntry("turn-1", [
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } },
		]),
		userEntry("user-2", "continue"),
	] as any;
	assert.throws(
		() => projectActiveBranch(incompleteOlder),
		(error: unknown) => error instanceof HistoryProjectionError && error.code === "INCOMPLETE_TOOL_RESULTS",
	);

	assert.throws(
		() => projectActiveBranch([resultEntry("result-1", "missing", "x")] as any),
		(error: unknown) => error instanceof HistoryProjectionError && error.code === "ORPHAN_TOOL_RESULT",
	);

	const duplicate = [
		assistantEntry("turn-1", [
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } },
		]),
		resultEntry("result-1", "call-1", "first"),
		resultEntry("result-2", "call-1", "second"),
	] as any;
	assert.throws(
		() => projectActiveBranch(duplicate),
		(error: unknown) => error instanceof HistoryProjectionError && error.code === "DUPLICATE_TOOL_RESULT",
	);
});
```

Also cover two parallel tool calls whose results arrive in stored source order and a result whose ID does not belong to the preceding assistant turn.

- [ ] **Step 3: Run the history test and confirm it fails because the module is absent**

```sh
node --test --experimental-strip-types extensions/context-paging/history.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `history.ts`.

- [ ] **Step 4: Define the history model and paging-tool set**

Use these public shapes in `history.ts`:

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
```

Define `HistoryProjectionError.code` as the closed union `"ORPHAN_TOOL_RESULT" | "INCOMPLETE_TOOL_RESULTS" | "DUPLICATE_TOOL_RESULT"`.

- [ ] **Step 5: Implement raw projection and metadata extraction**

Filter the branch to `type === "message"` entries whose message role is `user`, `assistant`, or `toolResult`. Walk that filtered list once. For an assistant message, collect only immediately following tool results, validate every tool-call ID exactly once, and omit the assistant only when the incomplete exchange reaches the end of the filtered list.

Extract tool names from every `toolCall` block. Extract file strings recursively from tool arguments when the key, case-insensitively, is `path`, `file`, `files`, `filePath`, or `file_path`; accept a string or an array of strings and deduplicate while preserving encounter order.

Use these helpers without mutating stored messages:

```typescript
const PAGING_TOOL_SET = new Set<string>(PAGING_TOOL_NAMES);

export function isPagingToolTurn(item: HistoryItem): boolean {
	return item.kind === "modelTurn" && item.metadata.tools.some((name) => PAGING_TOOL_SET.has(name));
}

export function flattenHistoryItems(items: readonly HistoryItem[]): AgentMessage[] {
	return items.flatMap((item) => item.kind === "user"
		? [item.userMessage]
		: [item.assistantMessage, ...item.toolResults]);
}
```

Sequence numbers must be assigned from projected active-branch order on every call. IDs must remain the stored user or assistant entry IDs.

- [ ] **Step 6: Run the history test and confirm it passes**

```sh
node --test --experimental-strip-types extensions/context-paging/history.test.ts
```

Expected: PASS with atomic projection, paging classification, malformed-history rejection, and incomplete-tail behavior covered.

- [ ] **Step 7: Commit the history module**

```sh
git add extensions/context-paging/history.ts extensions/context-paging/history.test.ts
git commit -m "feat(context-paging): project atomic session history"
```

---

### Task 2: Build the navigator and freeze browse behavior

**Files:**
- Create: `extensions/context-paging/navigator.ts`
- Create: `extensions/context-paging/navigator.test.ts`

**Interfaces:**
- Consumes: `HistoryItem[]` and `isPagingToolTurn()` from Task 1.
- Produces:
  - `HistorySearchInput`
  - `HistoryBrowseInput`
  - `HistoryReference`
  - `HistoryNavigatorError`
  - `HistoryNavigator.rebuild(items)`
  - `HistoryNavigator.search(input)`
  - `HistoryNavigator.browse(input)`
  - `HistoryNavigator.load(historyIds)`

- [ ] **Step 1: Write search, filtering, and exact-load tests**

Use these local fixture builders to create projected user and model-turn items directly:

```typescript
function userItem(id: string, sequence: number, text: string): HistoryItem {
	return {
		id,
		kind: "user",
		sequence,
		timestamp: `2026-09-21T00:00:${String(sequence).padStart(2, "0")}.000Z`,
		userMessage: { role: "user", content: text, timestamp: sequence } as any,
	};
}

function turnItem(
	id: string,
	sequence: number,
	text: string,
	tools: string[],
	files: string[],
	failed: boolean,
): HistoryItem {
	return {
		id,
		kind: "modelTurn",
		sequence,
		timestamp: `2026-09-21T00:01:${String(sequence).padStart(2, "0")}.000Z`,
		assistantMessage: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
			timestamp: sequence,
		} as any,
		toolResults: [],
		metadata: { tools, files, failed },
	};
}
```

Add assertions for case-insensitive relevance, chronological tie-breaking, previews, metadata filters, and atomic load failure:

```typescript
test("search ranks matching stored content and applies every supplied filter", () => {
	const navigator = new HistoryNavigator([
		userItem("u1", 0, "Parser discussion"),
		turnItem("m1", 1, "parser parser", ["read"], ["src/parser.ts"], false),
		turnItem("m2", 2, "parser failure", ["bash"], ["src/parser.ts"], true),
	]);

	assert.deepEqual(
		navigator.search({
			query: "PARSER",
			files: ["src/parser.ts"],
			tools: ["bash"],
			failed: true,
			limit: 5,
		}).map((reference) => reference.historyId),
		["m2"],
	);
});

test("load resolves the complete request atomically in requested order", () => {
	const navigator = new HistoryNavigator([
		userItem("u1", 0, "one"),
		userItem("u2", 1, "two"),
	]);
	assert.deepEqual(navigator.load(["u2", "u1"]).map((item) => item.id), ["u2", "u1"]);
	assert.throws(() => navigator.load(["u1", "missing"]), /Unknown history ID missing/);
});
```

Assert previews collapse whitespace and contain at most 160 characters. Assert adjacent IDs refer only to navigator-visible items.

- [ ] **Step 2: Write paging exclusion and visible sequence tests**

```typescript
test("paging turns stay out of every navigator operation", () => {
	const navigator = new HistoryNavigator([
		userItem("u1", 0, "request"),
		turnItem("paging", 1, "private paging result marker", ["read_context_output"], [], false),
		turnItem("normal", 2, "normal result marker", ["read"], ["src/a.ts"], false),
	]);

	assert.deepEqual(navigator.search({ query: "marker" }).map((ref) => ref.historyId), ["normal"]);
	assert.deepEqual(navigator.browse({ direction: "forward", count: 10 }).map((ref) => [ref.historyId, ref.sequence]), [
		["u1", 0],
		["normal", 1],
	]);
	assert.throws(() => navigator.load(["paging"]), /Unknown history ID paging/);
});
```

This test locks navigator sequence numbers to the filtered visible order, without changing raw projected item sequence numbers used by context selection.

- [ ] **Step 3: Write the complete browse matrix**

For visible IDs `h0` through `h4`, assert:

```typescript
const ids = (value: HistoryReference[]) => value.map((reference) => reference.historyId);

assert.deepEqual(ids(navigator.browse({ direction: "backward", count: 2 })), ["h4", "h3"]);
assert.deepEqual(ids(navigator.browse({ direction: "forward", count: 2 })), ["h0", "h1"]);
assert.deepEqual(ids(navigator.browse({ direction: "around", count: 3 })), ["h2", "h3", "h4"]);

assert.deepEqual(ids(navigator.browse({ historyId: "h2", direction: "backward", count: 2 })), ["h1", "h0"]);
assert.deepEqual(ids(navigator.browse({ sequence: 2, direction: "forward", count: 2 })), ["h3", "h4"]);
assert.deepEqual(ids(navigator.browse({ historyId: "h2", direction: "around", count: 3 })), ["h1", "h2", "h3"]);

assert.deepEqual(ids(navigator.browse({ historyId: "h4", direction: "backward", count: 2, stride: 2 })), ["h2", "h0"]);
assert.deepEqual(ids(navigator.browse({ historyId: "h2", direction: "around", count: 3, stride: 2 })), ["h0", "h2", "h4"]);
assert.deepEqual(ids(navigator.browse({ historyId: "h0", direction: "backward", count: 2 })), []);
assert.deepEqual(ids(navigator.browse({ historyId: "h4", direction: "forward", count: 2 })), []);
```

For an empty navigator, assert all three unanchored directions return `[]`. Assert an explicit missing ID or sequence fails with `UNKNOWN_HISTORY_ANCHOR`. Assert supplying both anchors fails.

- [ ] **Step 4: Run the navigator test and confirm the module is absent**

```sh
node --test --experimental-strip-types extensions/context-paging/navigator.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `navigator.ts`.

- [ ] **Step 5: Implement navigator rebuild, compact references, and BM25 ranking**

Keep the relevance index private inside `navigator.ts`; do not add another production file or dependency. Tokenize with:

```typescript
function tokenize(text: string): string[] {
	return text.toLowerCase().match(/[a-z0-9_./:-]+/g) ?? [];
}
```

Use BM25 constants `K1 = 1.2` and `B = 0.75`. Rank descending by score and ascending by visible navigator order for equal scores. Search text must concatenate exact user content or assistant content, tool-call names and serialized arguments, tool-result content, extracted files, and file path segments.

On rebuild:

```typescript
rebuild(items: readonly HistoryItem[]): void {
	this.items = items
		.filter((item) => !isPagingToolTurn(item))
		.map((item, sequence) => ({ ...item, sequence }));
	this.itemById = new Map(this.items.map((item) => [item.id, item]));
	this.itemBySequence = new Map(this.items.map((item) => [item.sequence, item]));
	this.references = this.items.map((item, index) => buildReference(item, index, this.items));
	this.rebuildSearchIndex();
}
```

Validate query length `0..200`, filter arrays up to 10 strings of at most 200 characters, result counts `1..10`, IDs up to 128 characters, sequence `0..1_000_000`, and at most three load IDs.

- [ ] **Step 6: Implement exact browse index selection**

Use virtual boundaries for unanchored directional browsing:

```typescript
function directionalIndexes(
	length: number,
	anchorIndex: number | undefined,
	direction: "backward" | "forward",
	count: number,
	stride: number,
): number[] {
	const step = direction === "backward" ? -stride : stride;
	let current = anchorIndex === undefined
		? direction === "backward" ? length - 1 : 0
		: anchorIndex + step;
	const indexes: number[] = [];
	while (indexes.length < count && current >= 0 && current < length) {
		indexes.push(current);
		current += step;
	}
	return indexes;
}
```

For `around`, build the stride-aligned candidate indexes that contain the anchor, choose a window of at most `count`, center with `Math.floor((count - 1) / 2)` items before the anchor when possible, clamp the window start to both ends, and return the sliced indexes in ascending order. An unanchored `around` uses `length - 1` as its anchor. Return `[]` before resolving an omitted anchor when history is empty.

- [ ] **Step 7: Run the navigator test and confirm it passes**

```sh
node --test --experimental-strip-types extensions/context-paging/navigator.test.ts
```

Expected: PASS with the full anchored, unanchored, stride, boundary, empty-history, filtering, and atomic-load matrix covered.

- [ ] **Step 8: Commit the navigator**

```sh
git add extensions/context-paging/navigator.ts extensions/context-paging/navigator.test.ts
git commit -m "feat(context-paging): add history navigator"
```

---

### Task 3: Page large outputs without mutating raw history

**Files:**
- Create: `extensions/context-paging/output-pages.ts`
- Create: `extensions/context-paging/output-pages.test.ts`

**Interfaces:**
- Consumes: `HistoryItem` and `ModelTurnHistoryItem` from Task 1.
- Produces:
  - `MAXIMUM_INLINE_OUTPUT_BYTES = 16_000`
  - `MAXIMUM_OUTPUT_PAGE_CHARACTERS = 2_000`
  - `ContextOutputReference`
  - `ContextOutputReadInput`
  - `ContextOutputPage`
  - `PagedTurnView`
  - `pageTurnOutputs(turn, maximumInlineBytes?)`
  - `pageAllTurnOutputs(turn)`
  - `readContextOutput(items, input)`

- [ ] **Step 1: Write immutable paging tests for assistant blocks and tool results**

Create a turn with one large assistant text block, one namespaced tool call, and one large failed tool result. Deep-clone it before paging, then assert:

```typescript
const sourceBefore = structuredClone(sourceTurn);
const view = pageTurnOutputs(sourceTurn, 100);

assert.deepEqual(sourceTurn, sourceBefore);
assert.equal(view.references.length, 2);
assert.match(view.item.assistantMessage.content[0].type === "text"
	? view.item.assistantMessage.content[0].text
	: "", /read_context_output/);
assert.equal(view.item.assistantMessage.content[1].type, "toolCall");
assert.equal(view.item.assistantMessage.content[1].id, "call-1");
assert.equal(view.item.assistantMessage.content[1].name, "bash");
assert.equal(view.item.assistantMessage.content[1].namespace, "functions");
assert.equal(view.item.toolResults[0].toolCallId, "call-1");
assert.equal(view.item.toolResults[0].toolName, "bash");
assert.equal(view.item.toolResults[0].isError, true);
```

Add a non-ASCII case whose character count is below the threshold but UTF-8 byte count exceeds it. Add `pageAllTurnOutputs()` coverage proving every assistant block and tool-result message receives a bounded reference.

- [ ] **Step 2: Write exact repeated-read and validation tests**

Use this model turn whose assistant called `load_history` and whose result contains a long JSON value:

```typescript
const pagingTurn: ModelTurnHistoryItem = {
	id: "paging-turn",
	kind: "modelTurn",
	sequence: 0,
	timestamp: "2026-09-21T00:00:00.000Z",
	assistantMessage: {
		role: "assistant",
		content: [{
			type: "toolCall",
			id: "load-call",
			name: "load_history",
			arguments: { historyIds: ["source"] },
		}],
		stopReason: "toolUse",
		timestamp: 1,
	} as any,
	toolResults: [{
		role: "toolResult",
		toolCallId: "load-call",
		toolName: "load_history",
		content: [{ type: "text", text: "😀".repeat(900) }],
		details: { marker: "raw paging result" },
		isError: false,
		timestamp: 2,
	}],
	metadata: { tools: ["load_history"], files: [], failed: false },
};
```

Read it repeatedly:

```typescript
const first = readContextOutput([pagingTurn], {
	historyId: pagingTurn.id,
	source: "toolResult",
	toolCallId: "load-call",
	offset: 0,
	limit: 17,
});
const second = readContextOutput([pagingTurn], {
	historyId: pagingTurn.id,
	source: "toolResult",
	toolCallId: "load-call",
	offset: first.nextOffset as number,
	limit: 2_000,
});
const original = JSON.stringify(pagingTurn.toolResults[0]);
assert.equal(first.text + second.text, original);
assert.equal(second.nextOffset, null);
assert.equal(second.totalCharacters, original.length);
```

Use an emoji or other surrogate-pair value and prove concatenated pages reproduce `JSON.stringify(original)` exactly. Assert rejection of unknown IDs, non-model IDs, unknown content indexes and tool-call IDs, wrong discriminator fields, negative/non-integer offsets, limits outside `1..2_000`, and offsets greater than the serialized length.

- [ ] **Step 3: Run the output paging test and confirm the module is absent**

```sh
node --test --experimental-strip-types extensions/context-paging/output-pages.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `output-pages.ts`.

- [ ] **Step 4: Implement stable references and immutable outbound copies**

Use this public reference union:

```typescript
export type ContextOutputReference =
	| { historyId: string; source: "assistant"; contentIndex: number }
	| { historyId: string; source: "toolResult"; toolCallId: string };

export type ContextOutputReadInput = {
	historyId: string;
	source: "assistant" | "toolResult";
	contentIndex?: number;
	toolCallId?: string;
	offset?: number;
	limit?: number;
};
```

For ordinary paging, compare `Buffer.byteLength(JSON.stringify(value), "utf8")` with the threshold. Page each assistant content block separately and each complete tool-result message as one value. For a paged tool-call block, preserve `type`, `id`, `name`, and `namespace`, and replace only its arguments with `{ contextOutputReference: reference }`. Spread a paged tool result before replacing `content` and `details` so IDs, name, usage, timestamps, and error state survive.

The notice must name `read_context_output`, include the exact reference JSON, state the `2_000`-character maximum page size, and include no more than 256 preview characters from the serialized source.

- [ ] **Step 5: Implement strict raw-source reads**

Validate the discriminator manually even though the public tool schema is strict:

```typescript
if (input.source === "assistant") {
	if (!Number.isSafeInteger(input.contentIndex) || (input.contentIndex as number) < 0) {
		throw new Error("Assistant output requires a nonnegative integer contentIndex.");
	}
	if (input.toolCallId !== undefined) {
		throw new Error("Assistant output does not accept toolCallId.");
	}
} else {
	if (typeof input.toolCallId !== "string" || input.toolCallId.length === 0) {
		throw new Error("Tool-result output requires toolCallId.");
	}
	if (input.contentIndex !== undefined) {
		throw new Error("Tool-result output does not accept contentIndex.");
	}
}
```

Find the source in the complete projected active-branch item list, including paging-tool turns. Serialize the original block or complete tool-result message with `JSON.stringify()`. Slice by JavaScript string offsets, allow `offset === text.length`, reject `offset > text.length`, and return:

```typescript
{
	offset,
	nextOffset: end < text.length ? end : null,
	totalCharacters: text.length,
	text: text.slice(offset, end),
}
```

- [ ] **Step 6: Run the output paging test and confirm it passes**

```sh
node --test --experimental-strip-types extensions/context-paging/output-pages.test.ts
```

Expected: PASS with immutable paging, metadata preservation, UTF-8 thresholding, UTF-16 page offsets, repeated reads, and invalid-reference handling covered.

- [ ] **Step 7: Commit output recovery**

```sh
git add extensions/context-paging/output-pages.ts extensions/context-paging/output-pages.test.ts
git commit -m "feat(context-paging): add exact output paging"
```

---

### Task 4: Select bounded outbound context

**Files:**
- Create: `extensions/context-paging/context-policy.ts`
- Create: `extensions/context-paging/context-policy.test.ts`

**Interfaces:**
- Consumes: all projected `HistoryItem[]` from Task 1 and paged turn views from Task 3.
- Produces:
  - `ResidentToolDefinition = { name: string; description: string; parameters: unknown }`
  - `ContextSelectionInput = { items: readonly HistoryItem[]; systemPrompt: string; activeTools: readonly ResidentToolDefinition[]; contextWindow: number | undefined }`
  - `ContextSelection = { messages: AgentMessage[]; selectedHistoryIds: string[]; selectedModelTurnIds: string[]; evictedHistoryIds: string[]; outputReferences: ContextOutputReference[]; measuredInputBytes: number; maximumInputBytes: number }`
  - `ContextBudgetError`
  - `measureContextBytes(systemPrompt, activeTools, messages)`
  - `selectContext(input: ContextSelectionInput): ContextSelection`

- [ ] **Step 1: Write budget-accounting and mandatory-user tests**

Build a helper that creates a model-agnostic context window from a target byte budget:

```typescript
const contextWindowForBudget = (bytes: number) => Math.ceil(bytes / 0.60);
```

Assert that adding bytes to either the system prompt or an active tool description/schema can turn a passing selection into `MANDATORY_CONTEXT_TOO_LARGE`. Assert every user message object is returned by identity in chronological order even when intervening model turns are evicted.

Add invalid-model cases for `undefined`, `0`, negative, fractional, `NaN`, and `Infinity`, and assert `ContextBudgetError.code === "INVALID_MODEL_CONTEXT"`.

- [ ] **Step 2: Write contiguous-suffix and no-skip tests**

Create three model turns where the middle turn is too large after paging and the oldest and newest are small. Assert only the newest turn survives; the oldest must not be selected across the failed boundary.

```typescript
const selection = selectContext({
	items: [userOne, oldSmallTurn, middleHugeTurn, newestSmallTurn],
	systemPrompt: "system",
	activeTools: [],
	contextWindow: contextWindowForBudget(targetBytes),
});
assert.deepEqual(selection.selectedModelTurnIds, [newestSmallTurn.id]);
assert.deepEqual(selection.evictedHistoryIds, [oldSmallTurn.id, middleHugeTurn.id]);
```

Assert the output never contains a tool result without its preceding assistant message.

- [ ] **Step 3: Add paging-turn visibility regressions**

Define a raw-branch builder for a user request, assistant paging call, and result:

```typescript
function pagingBranch(toolName: PagingToolName, marker: string) {
	return [
		{
			type: "message",
			id: `${toolName}-user`,
			parentId: null,
			timestamp: "2026-09-21T00:00:00.000Z",
			message: { role: "user", content: `run ${toolName}`, timestamp: 1 },
		},
		{
			type: "message",
			id: `${toolName}-turn`,
			parentId: null,
			timestamp: "2026-09-21T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: `${toolName}-call`, name: toolName, arguments: {} }],
				stopReason: "toolUse",
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: `${toolName}-result`,
			parentId: null,
			timestamp: "2026-09-21T00:00:02.000Z",
			message: {
				role: "toolResult",
				toolCallId: `${toolName}-call`,
				toolName,
				content: [{ type: "text", text: marker }],
				isError: false,
				timestamp: 3,
			},
		},
	];
}
```

For each paging tool name, build both consumers from the same projected items:

```typescript
for (const toolName of PAGING_TOOL_NAMES) {
	const items = projectActiveBranch(pagingBranch(toolName, `${toolName}-result-marker`) as any);
	const navigator = new HistoryNavigator(items);
	const selection = selectContext({
		items,
		systemPrompt: "system",
		activeTools: [],
		contextWindow: 10_000,
	});

	assert.equal(
		JSON.stringify(selection.messages).includes(`${toolName}-result-marker`),
		true,
		`${toolName} result must be visible on the immediate follow-up`,
	);
	assert.deepEqual(navigator.search({ query: `${toolName}-result-marker` }), []);
}
```

This is the required regression that distinguishes navigator exclusion from outbound context selection.

- [ ] **Step 4: Add large-output and provider-agnostic model fixtures**

Assert a large assistant block and large tool result become references while the raw item remains unchanged. Use two fixtures such as:

```typescript
for (const contextWindow of [32_000, 200_000]) {
	const selection = selectContext({
		items,
		systemPrompt: "shared system prompt",
		activeTools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
		contextWindow,
	});
	assert.ok(selection.maximumInputBytes === Math.floor(contextWindow * 0.60));
	assert.ok(selection.measuredInputBytes <= selection.maximumInputBytes);
}
```

Do not put provider or model names in the input or implementation.

- [ ] **Step 5: Run the policy test and confirm the module is absent**

```sh
node --test --experimental-strip-types extensions/context-paging/context-policy.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `context-policy.ts`.

- [ ] **Step 6: Implement resident measurement and budget errors**

Use this accounting shape:

```typescript
export function measureContextBytes(
	systemPrompt: string,
	activeTools: readonly ResidentToolDefinition[],
	messages: readonly AgentMessage[],
): number {
	return Buffer.byteLength(JSON.stringify({
		systemPrompt,
		tools: activeTools.map(({ name, description, parameters }) => ({ name, description, parameters })),
		messages,
	}), "utf8");
}
```

Require `contextWindow` to be a positive finite integer and set `maximumInputBytes = Math.floor(contextWindow * 0.60)`. Measure resident context plus all user messages first. Throw `MANDATORY_CONTEXT_TOO_LARGE` with measured and maximum byte counts when it does not fit.

- [ ] **Step 7: Implement newest-contiguous-suffix selection**

Sort by sequence, pin every user ID, and walk model turns from newest to oldest. For each candidate, first store `pageTurnOutputs(turn)`, measure all pinned users plus the tentative suffix, then replace only that candidate with `pageAllTurnOutputs(turn)` and remeasure if needed. If the all-paged candidate still does not fit, break; do not consider any older turn.

Build output messages by filtering the original ordered history to pinned user IDs and selected turn IDs, substituting only selected paged turn copies, then call `flattenHistoryItems()`. Return:

```typescript
{
	messages,
	selectedHistoryIds,
	selectedModelTurnIds,
	evictedHistoryIds,
	outputReferences,
	measuredInputBytes,
	maximumInputBytes,
}
```

An empty model-turn suffix is valid when mandatory users fit but the newest complete turn does not.

- [ ] **Step 8: Run the policy test and all lower-level paging tests**

```sh
node --test --experimental-strip-types \
  extensions/context-paging/history.test.ts \
  extensions/context-paging/navigator.test.ts \
  extensions/context-paging/output-pages.test.ts \
  extensions/context-paging/context-policy.test.ts
```

Expected: PASS with no raw-message mutations and no paging-tool turns in navigator results.

- [ ] **Step 9: Commit the context policy**

```sh
git add extensions/context-paging/context-policy.ts extensions/context-paging/context-policy.test.ts
git commit -m "feat(context-paging): select bounded context suffix"
```

---

### Task 5: Define the four public paging tools

**Files:**
- Create: `extensions/context-paging/tools.ts`
- Create: `extensions/context-paging/tools.test.ts`

**Interfaces:**
- Consumes:
  - `HistoryNavigator` from Task 2
  - `readContextOutput()` and `ContextOutputReadInput` from Task 3
  - a fresh active-branch snapshot supplied by the extension entry point
- Produces:
  - `HistorySnapshot = { allItems: readonly HistoryItem[]; navigator: HistoryNavigator }`
  - `ContextPagingToolDependencies = { isEnabled(): boolean; snapshot(ctx: ExtensionContext): HistorySnapshot }`
  - `registerContextPagingTools(pi, dependencies): void`

- [ ] **Step 1: Write registration and strict-schema tests**

Capture definitions passed to a fake `registerTool()`. Assert the names are exactly:

```typescript
[
	"search_history",
	"browse_history",
	"load_history",
	"read_context_output",
]
```

Assert no definition is named `update_task_state`, every root schema has `type: "object"` and `additionalProperties: false`, and `direction` and `source` serialize as normal string enums rather than top-level unions.

- [ ] **Step 2: Write tool-result, bound, and disabled tests**

Execute definitions directly with a snapshot fixture. Cover:

- `search_history` returns references by default;
- `search_history({ load: true })` returns at most the first three exact matching items;
- `browse_history` returns references in navigator order;
- `load_history` returns exact items in requested order and fails without partial output when any ID is missing;
- a compact response over 8,000 characters throws `RESPONSE_TOO_LARGE` instead of truncating JSON;
- exact loaded output larger than 8,000 characters succeeds;
- `read_context_output` returns the page result and accepts repeated offsets;
- every tool throws `Context paging is disabled by contextPaging.enabled.` before reading a snapshot when disabled.

Use a snapshot-call counter to prove each enabled execution rebuilds from the current raw branch exactly once.

- [ ] **Step 3: Run the tool test and confirm the module is absent**

```sh
node --test --experimental-strip-types extensions/context-paging/tools.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `tools.ts`.

- [ ] **Step 4: Implement strict TypeBox schemas**

Import `StringEnum` from `@earendil-works/pi-ai` and `Type` from `typebox`. Use `Type.Object(properties, { additionalProperties: false })` for all roots.

The browse and output discriminators must be:

```typescript
direction: StringEnum(["backward", "forward", "around"] as const)
source: StringEnum(["assistant", "toolResult"] as const)
```

Use the exact min/max values from the spec. Keep `historyId` and `sequence` mutually exclusive through navigator runtime validation. Keep `contentIndex` and `toolCallId` source-dependent through `readContextOutput()` validation.

- [ ] **Step 5: Implement execution and response helpers**

Every execution starts with:

```typescript
function requireEnabled(dependencies: ContextPagingToolDependencies): void {
	if (!dependencies.isEnabled()) {
		throw new Error("Context paging is disabled by contextPaging.enabled.");
	}
}
```

Create compact and exact result helpers:

```typescript
function compactJsonResult<T>(details: T) {
	const text = JSON.stringify(details);
	if (text.length > 8_000) {
		throw new Error(`RESPONSE_TOO_LARGE: Tool response is ${text.length} characters; maximum is 8000.`);
	}
	return { content: [{ type: "text" as const, text }], details };
}

function exactJsonResult<T>(details: T) {
	return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}
```

`search_history` calls `navigator.search(input)`. With `load: true`, take `references.slice(0, 3)`, load those IDs atomically, and use `exactJsonResult({ items })`; otherwise use `compactJsonResult({ references })`. `browse_history` uses the compact helper. `load_history` and `read_context_output` use the exact helper.

Tool descriptions and prompt guidance must tell the model that paging turns are absent from navigation but tool results remain available on the immediate next request, and that repeated `read_context_output` calls use `nextOffset`.

- [ ] **Step 6: Run the tool tests and focused module suite**

```sh
node --test --experimental-strip-types extensions/context-paging/*.test.ts
```

Expected: PASS with exactly four registered tools, strict schemas, atomic errors, compact bounds, exact loads, disabled guards, and repeated output reads covered.

- [ ] **Step 7: Commit the tool catalog**

```sh
git add extensions/context-paging/tools.ts extensions/context-paging/tools.test.ts
git commit -m "feat(context-paging): register paging tools"
```

---

### Task 6: Wire settings, lifecycle restoration, context replacement, and compaction guards

**Files:**
- Create: `extensions/context-paging/index.ts`
- Create: `extensions/context-paging/index.test.ts`

**Interfaces:**
- Consumes: all Task 1-5 modules and Pi `ExtensionAPI`/`ExtensionContext`.
- Produces:
  - default standard Pi extension factory
  - `ContextPagingSettingsSources = { globalSettings: unknown; projectSettings?: unknown; projectTrusted: boolean }`
  - `resolveContextPagingEnabled(sources)`
  - one session-local `HistoryNavigator`
  - rebuilds on `session_start`, `turn_end`, `session_tree`, tool execution snapshots, and every `context` event

- [ ] **Step 1: Write settings-precedence tests**

Test the pure resolver with these rows:

```typescript
assert.equal(resolveContextPagingEnabled({ globalSettings: {}, projectTrusted: false }), true);
assert.equal(resolveContextPagingEnabled({
	globalSettings: { contextPaging: { enabled: false } },
	projectTrusted: false,
}), false);
assert.equal(resolveContextPagingEnabled({
	globalSettings: { contextPaging: { enabled: true } },
	projectSettings: { contextPaging: { enabled: false } },
	projectTrusted: true,
}), false);
assert.equal(resolveContextPagingEnabled({
	globalSettings: { contextPaging: { enabled: true } },
	projectSettings: { contextPaging: { enabled: false } },
	projectTrusted: false,
}), true);
assert.equal(resolveContextPagingEnabled({
	globalSettings: { contextPaging: { enabled: false } },
	projectSettings: { contextPaging: { enabled: "yes" } },
	projectTrusted: true,
}), false);
```

The last case proves an invalid project value falls back to the global value.

- [ ] **Step 2: Build the Pi harness and write lifecycle rebuild tests**

The fake Pi object must capture registered tools and handlers for `session_start`, `turn_end`, `session_tree`, `context`, and `session_before_compact`. The fake context supplies mutable `getBranch()`, `model.contextWindow`, `getSystemPrompt()`, `isProjectTrusted()`, `abort()`, and `ui.notify()`.

For each session-start reason `startup`, `new`, `resume`, `fork`, and `reload`, replace the branch with a unique searchable marker, invoke the handler, execute `search_history`, and assert only the new marker is found. After a `session_tree` event, assert references and sequence numbers describe only the replacement branch.

Mutate the branch without firing another lifecycle event, call `context`, and assert outbound messages come from the new raw branch. This locks the context hook to fresh raw projection rather than stale in-memory navigator state.

- [ ] **Step 3: Write enabled, disabled, abort, and compaction tests**

Assert:

- the default factory always registers all four tools;
- disabled mode leaves the incoming `context` event unchanged, does not call `abort()`, does not cancel `session_before_compact`, and tool execution fails clearly;
- enabled mode returns selected raw-branch messages;
- missing/invalid model context and mandatory overflow call `ctx.abort()` once, issue an error notice, and do not append any custom/fatal entry;
- enabled compaction returns `{ cancel: true }` and emits a warning that raw history was kept;
- projection failure on a context event aborts and reports the projection error;
- successful tree navigation rebuilds, while no `session_before_tree` handler is registered.

- [ ] **Step 4: Run the index test and confirm the module is absent**

```sh
node --test --experimental-strip-types extensions/context-paging/index.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `index.ts`.

- [ ] **Step 5: Implement trusted settings loading**

Use `CONFIG_DIR_NAME` and `getAgentDir()` from `@earendil-works/pi-coding-agent`. Read global `${getAgentDir()}/settings.json`. Read `${ctx.cwd}/${CONFIG_DIR_NAME}/settings.json` only when `ctx.isProjectTrusted()` is true. Parse failures return `undefined` and feed the same resolver as missing values.

Use:

```typescript
const DEFAULT_CONTEXT_PAGING_ENABLED = true;

export function resolveContextPagingEnabled(sources: ContextPagingSettingsSources): boolean {
	const globalValue = readEnabledSetting(sources.globalSettings);
	const projectValue = sources.projectTrusted
		? readEnabledSetting(sources.projectSettings)
		: undefined;
	return projectValue ?? globalValue ?? DEFAULT_CONTEXT_PAGING_ENABLED;
}
```

`readEnabledSetting()` returns a value only for an actual boolean.

- [ ] **Step 6: Implement one navigator and fresh snapshots**

Inside the default factory, keep `enabled`, `allItems`, and one `HistoryNavigator`. Define:

```typescript
const rebuild = (ctx: ExtensionContext): HistorySnapshot => {
	allItems = projectActiveBranch(ctx.sessionManager.getBranch());
	navigator.rebuild(allItems);
	return { allItems, navigator };
};
```

Pass `isEnabled: () => enabled` and `snapshot: rebuild` to `registerContextPagingTools()`. Register tools during extension load, regardless of setting state.

On `session_start`, resolve settings first and rebuild the active raw branch. On `turn_end` and `session_tree`, rebuild and notify on projection errors without creating session entries. The `context` hook must call `rebuild()` again before selection.

- [ ] **Step 7: Implement context replacement and fail-closed aborts**

Build active resident tool definitions from the intersection of `pi.getActiveTools()` and `pi.getAllTools()`. Pass `ctx.getSystemPrompt()`, active definitions, raw projected items, and `ctx.model?.contextWindow` to `selectContext()`.

When enabled and successful, return `{ messages: selection.messages }`. On a budget or projection error:

```typescript
const message = error instanceof Error ? error.message : String(error);
ctx.abort();
ctx.ui.notify(`Context paging aborted this provider turn: ${message}`, "error");
return { messages: event.messages };
```

Do not set a custom entry, custom message, or persistent fatal marker. When disabled, return `undefined` from the context handler.

- [ ] **Step 8: Implement conditional compaction cancellation**

Register only `session_before_compact`, not `session_before_tree`:

```typescript
pi.on("session_before_compact", async (_event, ctx) => {
	if (!enabled) return;
	ctx.ui.notify("Context paging kept raw history and cancelled compaction.", "warning");
	return { cancel: true };
});
```

Tree navigation must remain available; `session_tree` performs the post-navigation rebuild.

- [ ] **Step 9: Run all context-paging tests**

```sh
node --test --experimental-strip-types extensions/context-paging/*.test.ts
```

Expected: PASS with lifecycle rebuilds, raw-branch context selection, settings precedence, disabled behavior, aborts, and compaction behavior covered.

- [ ] **Step 10: Commit the extension runtime**

```sh
git add extensions/context-paging/index.ts extensions/context-paging/index.test.ts
git commit -m "feat(context-paging): wire session lifecycle"
```

---

### Task 7: Make automatic handoff opt-in per session

**Files:**
- Modify: `extensions/handoff-auto.ts:1-99`
- Modify: `extensions/handoff.ts:24-33,219-234,436-446,476-526`
- Modify: `tests/extensions/handoff-auto.test.ts:1-123`
- Modify: `tests/extensions/handoff.test.ts:11-39,220-344`

**Interfaces:**
- Consumes: existing `HandoffSettingsSources`, trusted-project loading, handoff state machine, `/handoff auto` controls, and manual handoff path.
- Produces:
  - `DEFAULT_AUTO_ENABLED = false`
  - `resolveAutoEnabled(sources): boolean`
  - `{ type: "session-start"; enabled: boolean }`
  - disabled packaged/default state on every session start
  - unchanged explicit `auto on`, `auto off`, `auto status`, threshold, preparation, finalization, and manual behavior

- [ ] **Step 1: Write boolean setting-resolution tests**

Add cases equivalent to context paging precedence:

```typescript
assert.equal(resolveAutoEnabled({ globalSettings: {}, projectTrusted: false }), false);
assert.equal(resolveAutoEnabled({
	globalSettings: { handoff: { autoEnabled: true } },
	projectTrusted: false,
}), true);
assert.equal(resolveAutoEnabled({
	globalSettings: { handoff: { autoEnabled: true } },
	projectSettings: { handoff: { autoEnabled: false } },
	projectTrusted: true,
}), false);
assert.equal(resolveAutoEnabled({
	globalSettings: { handoff: { autoEnabled: false } },
	projectSettings: { handoff: { autoEnabled: true } },
	projectTrusted: false,
}), false);
assert.equal(resolveAutoEnabled({
	globalSettings: { handoff: { autoEnabled: true } },
	projectSettings: { handoff: { autoEnabled: "yes" } },
	projectTrusted: true,
}), true);
```

Change the state test to expect `session-start` with `enabled: false` to return `disabled` and `enabled: true` to return `armed`.

- [ ] **Step 2: Update runtime tests for the new default**

Set the shared automatic test fixture to:

```typescript
const thresholdSettings: HandoffDependencies["loadSettings"] = async () => ({
	globalSettings: { handoff: { autoEnabled: true, autoThresholdTokens: 100 } },
	projectTrusted: false,
});
```

Keep automatic-flow tests explicitly enabled so they continue testing countdown, preparation, and finalization rather than the default. Add a separate default-disabled test:

```typescript
test("session start defaults automatic handoff to disabled while manual handoff remains available", async () => {
	const harness = createHarness({
		loadSettings: async () => ({ globalSettings: {}, projectTrusted: false }),
	});
	const command = createCommandContext({ usageTokens: 150_000 });
	await harness.events.get("session_start")?.({ reason: "startup" }, command.ctx);
	await harness.events.get("agent_settled")?.({}, command.ctx);
	await harness.commandHandler("auto status", command.ctx);
	assert.deepEqual(harness.sentMessages, []);
	assert.match(command.notices.at(-1)?.message ?? "", /disabled/);

	await harness.commandHandler("continue the approved plan", command.ctx);
	assert.equal(command.sessionOptions.length, 1);
});
```

Add a loop over startup, new, resume, fork, and reload proving each session start rereads settings and resets an earlier in-memory `auto on` state.

- [ ] **Step 3: Run the handoff tests and confirm the new assertions fail**

```sh
node --test --experimental-strip-types \
  tests/extensions/handoff-auto.test.ts \
  tests/extensions/handoff.test.ts
```

Expected: FAIL because session start still always arms automatic handoff and `resolveAutoEnabled()` does not exist.

- [ ] **Step 4: Implement boolean resolution and the enabled session-start event**

Add:

```typescript
export const DEFAULT_AUTO_ENABLED = false;

export function resolveAutoEnabled(sources: HandoffSettingsSources): boolean {
	const globalValue = readBooleanSetting(sources.globalSettings, "autoEnabled");
	const projectValue = sources.projectTrusted
		? readBooleanSetting(sources.projectSettings, "autoEnabled")
		: undefined;
	return projectValue ?? globalValue ?? DEFAULT_AUTO_ENABLED;
}
```

Reuse the existing record checks. Keep threshold resolution independent, so an invalid boolean does not invalidate a valid threshold.

Change the event union and transition:

```typescript
| { type: "session-start"; enabled: boolean }

case "session-start":
	return event.enabled ? "armed" : "disabled";
```

- [ ] **Step 5: Reset handoff state from settings on every session start**

In `handoff.ts`, default `autoState` to `"disabled"`. During `session_start`, clear preparation, reset threshold to `150_000`, load settings once, resolve both threshold and enabled state, and apply `{ type: "session-start", enabled }`. On read failure, remain disabled at the default threshold.

Do not change the explicit `auto on` transition: it may arm or begin countdown for the current session even when settings default to false. Do not write this opt-in back to settings.

- [ ] **Step 6: Run all handoff tests**

```sh
node --test --experimental-strip-types \
  tests/extensions/handoff-auto.test.ts \
  tests/extensions/handoff.test.ts \
  tests/extensions/handoff-generation.test.ts
```

Expected: PASS with default-disabled status, explicit opt-in, per-session reset, and manual handoff preserved.

- [ ] **Step 7: Commit the automatic-handoff default**

```sh
git add \
  extensions/handoff-auto.ts \
  extensions/handoff.ts \
  tests/extensions/handoff-auto.test.ts \
  tests/extensions/handoff.test.ts
git commit -m "feat(handoff): default automatic rollover off"
```

---

### Task 8: Package settings and runtime proof

**Files:**
- Modify: `settings.json`
- Modify: `modules/checks/pi-config-extension-load.nix:24-119`

**Interfaces:**
- Consumes: pi-loadout 0.0.35's existing no-saved-loadout behavior and packaged extension auto-discovery.
- Produces:
  - packaged `contextPaging.enabled: true`
  - packaged `handoff.autoEnabled: false`
  - no packaged or Home Manager-managed `~/.pi/agent/loadout.json`
  - runtime assertion that all four paging tools are registered and active and `update_task_state` is absent

- [ ] **Step 1: Add and parse the static settings resource**

Add to `settings.json`:

```json
"contextPaging": {
  "enabled": true
},
"handoff": {
  "autoEnabled": false,
  "autoThresholdTokens": 150000
}
```

Run direct parsing instead of adding a static-content test:

```sh
python -m json.tool settings.json >/dev/null
```

Expected: the command exits 0.

- [ ] **Step 2: Extend the Home Manager-like runtime fixture**

Do not create or link `$agent_dir/loadout.json`. The fixture must exercise pi-loadout's normal behavior when the user has no saved default selection.

Add a toolset probe that uses that unconfigured default:

```nix
run_probe context-paging-tools \
  ${pkgs.coreutils}/bin/env \
  PI_TOOLSET_PROBE_OUTPUT="$TMPDIR/context-paging-tools.json" \
  ${selectablePi}/bin/pi \
  --no-session \
  --extension ${probeExtension} \
  -p /write-toolset-probe
```

Then assert:

```python
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
```

This runtime assertion proves the paging tools are registered and active in a clean packaged environment without taking ownership of user loadout state. Do not add a test that parses Nix source text.

- [ ] **Step 3: Stage new files before git-backed Nix evaluation**

```sh
git add \
  extensions/context-paging \
  settings.json \
  modules/checks/pi-config-extension-load.nix
```

Expected: the new extension and settings are visible to normal flake evaluation. Do not commit yet.

- [ ] **Step 4: Run the required runtime extension-load check**

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: exit status 0; all four paging tools appear in both registered and active sets; `update_task_state` is absent; no `Failed to load extension`, `No such built-in module`, or `Cannot find package` message appears.

- [ ] **Step 5: Commit packaging and runtime proof**

```sh
git commit -m "feat(context-paging): package defaults and runtime proof"
```

---

### Task 9: Verify the complete port and request adversarial review

**Files:**
- Verify: `extensions/context-paging/*.ts`
- Verify: `extensions/handoff-auto.ts`
- Verify: `extensions/handoff.ts`
- Verify: `tests/extensions/handoff-auto.test.ts`
- Verify: `tests/extensions/handoff.test.ts`
- Verify: `settings.json`
- Verify: `modules/checks/pi-config-extension-load.nix`
- Verify: `docs/specs/2026-09-21-context-paging-design.md`
- Verify: `docs/plans/2026-09-21-context-paging.md`

**Interfaces:**
- Consumes: all completed implementation tasks.
- Produces: fresh focused-test, full-test, runtime-load, full-flake, diff, status, and adversarial-review evidence.

- [ ] **Step 1: Run the focused behavior suite**

```sh
node --test --experimental-strip-types \
  extensions/context-paging/*.test.ts \
  tests/extensions/handoff-auto.test.ts \
  tests/extensions/handoff.test.ts \
  tests/extensions/handoff-generation.test.ts
```

Expected: PASS with zero failures.

- [ ] **Step 2: Run every repository TypeScript test file**

```sh
node --test --experimental-strip-types \
  $(find extensions tests -name '*.test.ts' -type f | sort)
```

Expected: all existing and new TypeScript test files pass. Record the file, test, pass, fail, cancelled, and skipped counts from this fresh run.

- [ ] **Step 3: Run the required Pi runtime extension-load check again**

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: exit status 0 with all four paging tools active, `update_task_state` absent, and no extension-loading, missing-module, or missing-package regression.

- [ ] **Step 4: Run the full flake check**

```sh
nix flake check --accept-flake-config --print-build-logs
```

Expected: exit status 0. Treat any failure as unresolved until its relation to the branch is proved; do not declare completion from the focused check alone.

- [ ] **Step 5: Review module size and the branch diff**

```sh
wc -l extensions/context-paging/*.ts
git diff --check main...HEAD
git diff --stat main...HEAD
git status --short
git log --oneline main..HEAD
```

Expected:

- no whitespace errors;
- production modules remain focused, with any file over 400 meaningful lines split before review;
- only the approved spec, plan, paging extension, handoff default, tests, settings, and runtime probe changed;
- no uncommitted implementation files;
- focused commits match the task boundaries.

- [ ] **Step 6: Request adversarial code review**

Dispatch the canonical `reviewer` with fresh context. Include:

- spec: `docs/specs/2026-09-21-context-paging-design.md`;
- plan: `docs/plans/2026-09-21-context-paging.md`;
- base SHA from `main` and current head SHA;
- the focused, full TypeScript, runtime extension-load, and full-flake results;
- a concise statement that paging-tool turns must be absent only from navigator results, must remain eligible for immediate outbound context, and must remain raw output-recovery sources;
- the complete browse matrix and the requirement to leave user loadout state unmanaged while proving clean-default tool activation.

Require findings with file and line references. Verify each finding before changing code. Add a regression test when the Testing Value Gate is met, rerun every affected check, and commit each coherent correction.
