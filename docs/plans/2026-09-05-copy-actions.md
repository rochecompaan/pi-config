# Copy Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Pi's `/copy` command with one searchable picker for full messages, cleaned pipe messages, fenced code, and inline code.

**Architecture:** A pure extraction core builds typed copy items from assistant messages. A TUI adapter selects an item, and an action adapter copies or inserts it.

**Tech Stack:** TypeScript, Pi 0.84 extension interfaces, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, Node.js test runner, and Nix flake checks.

**Specification:** `docs/specs/2026-09-05-copy-actions-design.md`

## Global Constraints

- Work only in the `feature/copy-actions` worktree.
- Register the extension command as `/copy`.
- Plain `/copy` must always open the unified picker.
- Do not add a direct selector or a latest-message fast path.
- Include only assistant messages from the active branch.
- Include full messages, triple-backtick fenced blocks, and every non-empty single-backtick inline span.
- A pipe-prefixed line must start with the exact two-character prefix `| `.
- Remove one `| ` prefix from each matching line.
- Join consecutive cleaned pipe lines with an empty separator.
- Ignore pipe and inline matches inside closed fenced blocks.
- Full messages and pipe messages permit copy only.
- Fenced and inline code permit copy and editor insertion.
- Do not execute selected content.
- Use Pi's exported `copyToClipboard()` function.
- Keep production modules focused and preferably under 200 lines.
- Preserve the upstream MIT notice for `@signalridge/pi-code-actions`.
- Use `node:test`. Do not add Bun or npm dependencies.

---

## File Map

Create these production files:

- `extensions/copy-actions/index.ts` — registers `/copy` and coordinates the command.
- `extensions/copy-actions/copy-items.ts` — defines copy-item types and collects branch items.
- `extensions/copy-actions/extract.ts` — extracts fenced, inline, and pipe items from text.
- `extensions/copy-actions/search.ts` — builds and ranks the picker search index.
- `extensions/copy-actions/ui.ts` — renders the unified picker and returns one selection.
- `extensions/copy-actions/actions.ts` — copies or inserts the selected item.
- `extensions/copy-actions/NOTICE` — contains the upstream MIT notice.

Create these behavior tests:

- `extensions/copy-actions/extract.test.ts`
- `extensions/copy-actions/copy-items.test.ts`
- `extensions/copy-actions/search.test.ts`
- `extensions/copy-actions/actions.test.ts`
- `extensions/copy-actions/index.test.ts`

No Nix source file needs a change. `modules/packages/pi-config.nix` already copies the complete `extensions/` directory.

---

### Task 1: Define copy items and extract message fragments

**Files:**
- Create: `extensions/copy-actions/copy-items.ts`
- Create: `extensions/copy-actions/extract.ts`
- Create: `extensions/copy-actions/extract.test.ts`

**Interfaces:**
- Produces: `CopyItemKind`, `CopyAction`, `CopyItem`, `ExtractedCopyItem`, `CopySelection`
- Produces: `copyItemKindLabel(kind: CopyItemKind): string`
- Produces: `isInsertableCopyItem(item: CopyItem): boolean`
- Produces: `extractCopyItems(text: string): ExtractedCopyItem[]`

- [ ] **Step 1: Add the item types and the failing extraction tests**

Create `copy-items.ts` with the stable domain interface:

```typescript
export type CopyItemKind = "message" | "pipe-message" | "code" | "inline";
export type CopyAction = "copy" | "insert";

export type CopyItem = {
	id: string;
	kind: CopyItemKind;
	content: string;
	messageId: string;
	sourceLabel: string;
	sourcePosition: number;
	language?: string;
};

export type ExtractedCopyItem = Pick<
	CopyItem,
	"kind" | "content" | "sourcePosition" | "language"
>;

export type CopySelection = {
	item: CopyItem;
	action: CopyAction;
};

const COPY_ITEM_KIND_LABELS: Record<CopyItemKind, string> = {
	message: "message",
	"pipe-message": "pipe message",
	code: "code",
	inline: "inline",
};

export function copyItemKindLabel(kind: CopyItemKind): string {
	return COPY_ITEM_KIND_LABELS[kind];
}

export function isInsertableCopyItem(item: CopyItem): boolean {
	return item.kind === "code" || item.kind === "inline";
}
```

Create `extract.test.ts` with these cases:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { extractCopyItems } from "./extract.ts";

test("extracts fenced and every inline code item in source order", () => {
	assert.deepEqual(
		extractCopyItems("Use `main`, then:\n```ts\nconst answer = 42;\n```\nRun `git status`."),
		[
			{ kind: "inline", content: "main", sourcePosition: 4 },
			{
				kind: "code",
				content: "const answer = 42;",
				language: "ts",
				sourcePosition: 18,
			},
			{ kind: "inline", content: "git status", sourcePosition: 51 },
		],
	);
});

test("does not extract inline or pipe items inside fenced code", () => {
	const items = extractCopyItems("```text\n`hidden`\n| hidden\n```\n`visible`\n| shown");
	assert.deepEqual(items.map(({ kind, content }) => ({ kind, content })), [
		{ kind: "code", content: "`hidden`\n| hidden" },
		{ kind: "inline", content: "visible" },
		{ kind: "pipe-message", content: "shown" },
	]);
});

test("groups consecutive pipe lines and removes newlines without replacement", () => {
	const items = extractCopyItems("Intro\n| Hello,\n| world\nBreak\n| Again");
	assert.deepEqual(
		items.filter((item) => item.kind === "pipe-message").map((item) => item.content),
		["Hello,world", "Again"],
	);
});

test("requires an exact pipe-space prefix and preserves remaining spaces", () => {
	const items = extractCopyItems(" | indented\n|missing-space\n|  kept \n| ");
	assert.deepEqual(
		items.filter((item) => item.kind === "pipe-message").map((item) => item.content),
		[" kept "],
	);
});

test("skips empty fenced and pipe items", () => {
	assert.deepEqual(extractCopyItems("```\n\n```\n| "), []);
});
```

- [ ] **Step 2: Run the extraction tests and observe the expected failure**

Run:

```sh
nix develop -c node --test --experimental-strip-types extensions/copy-actions/extract.test.ts
```

Expected result: FAIL because `extensions/copy-actions/extract.ts` does not exist.

- [ ] **Step 3: Implement deterministic extraction**

Create `extract.ts`. Use one fence pass to record closed fenced ranges. Then extract inline and pipe items outside those ranges.

```typescript
// Adapted from @signalridge/pi-code-actions. See NOTICE.
import type { ExtractedCopyItem } from "./copy-items.ts";

type SourceRange = { start: number; end: number };

function isInsideRanges(position: number, ranges: readonly SourceRange[]): boolean {
	return ranges.some((range) => position >= range.start && position < range.end);
}

export function extractCopyItems(text: string): ExtractedCopyItem[] {
	const items: ExtractedCopyItem[] = [];
	const fencedRanges: SourceRange[] = [];
	const fencedPattern = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;

	while ((match = fencedPattern.exec(text)) !== null) {
		const language = match[1]?.trim() || undefined;
		const content = (match[2] ?? "").replace(/\r?\n$/, "");
		fencedRanges.push({ start: match.index, end: match.index + match[0].length });
		if (content.length > 0) {
			items.push({
				kind: "code",
				content,
				sourcePosition: match.index,
				...(language ? { language } : {}),
			});
		}
	}

	const inlinePattern = /`([^`\r\n]+)`/g;
	while ((match = inlinePattern.exec(text)) !== null) {
		if (!isInsideRanges(match.index, fencedRanges)) {
			items.push({
				kind: "inline",
				content: match[1] ?? "",
				sourcePosition: match.index,
			});
		}
	}

	let pipeStart = -1;
	let pipeParts: string[] = [];
	const flushPipeBlock = (): void => {
		if (pipeStart >= 0) {
			const content = pipeParts.join("");
			if (content.length > 0) {
				items.push({ kind: "pipe-message", content, sourcePosition: pipeStart });
			}
		}
		pipeStart = -1;
		pipeParts = [];
	};

	const linePattern = /([^\r\n]*)(\r?\n|$)/g;
	while ((match = linePattern.exec(text)) !== null) {
		if (match[0].length === 0) break;
		const line = match[1] ?? "";
		if (!isInsideRanges(match.index, fencedRanges) && line.startsWith("| ")) {
			if (pipeStart < 0) pipeStart = match.index;
			pipeParts.push(line.slice(2));
		} else {
			flushPipeBlock();
		}
	}
	flushPipeBlock();

	return items.sort((left, right) => left.sourcePosition - right.sourcePosition);
}
```

Do not trim extracted content. Remove only syntax that the specification names.

- [ ] **Step 4: Run the extraction tests and observe a passing result**

Run:

```sh
nix develop -c node --test --experimental-strip-types extensions/copy-actions/extract.test.ts
```

Expected result: 5 tests pass and 0 tests fail.

- [ ] **Step 5: Commit the extraction core**

```sh
git add extensions/copy-actions/copy-items.ts extensions/copy-actions/extract.ts extensions/copy-actions/extract.test.ts
git commit -m "feat(copy-actions): extract copyable message content"
```

---

### Task 2: Collect and order copy items from the active branch

**Files:**
- Modify: `extensions/copy-actions/copy-items.ts`
- Create: `extensions/copy-actions/copy-items.test.ts`

**Interfaces:**
- Consumes: `extractCopyItems(text: string): ExtractedCopyItem[]`
- Produces: `extractAssistantText(content: unknown): string`
- Produces: `collectCopyItems(entries: BranchEntry[]): CopyItem[]`

- [ ] **Step 1: Write the failing collector tests**

Create `copy-items.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { collectCopyItems, extractAssistantText } from "./copy-items.ts";

const older = {
	type: "message",
	id: "older",
	timestamp: "2026-09-05T09:00:00.000Z",
	message: { role: "assistant", content: "```sh\necho old\n```" },
};

const newer = {
	type: "message",
	id: "newer",
	timestamp: "2026-09-05T10:00:00.000Z",
	message: { role: "assistant", content: "| Hello,\n| world\nUse `main`." },
};

test("joins assistant text blocks and ignores non-text blocks", () => {
	assert.equal(
		extractAssistantText([
			{ type: "text", text: "First" },
			{ type: "thinking", thinking: "hidden" },
			{ type: "text", text: "Second" },
		]),
		"First\n\nSecond",
	);
});

test("collects newest messages first with the full message before extracts", () => {
	const items = collectCopyItems([older, newer] as never);
	assert.deepEqual(
		items.map((item) => [item.messageId, item.kind, item.content]),
		[
			["newer", "message", "| Hello,\n| world\nUse `main`."],
			["newer", "pipe-message", "Hello,world"],
			["newer", "inline", "main"],
			["older", "message", "```sh\necho old\n```"],
			["older", "code", "echo old"],
		],
	);
});

test("excludes non-assistant, non-message, and empty assistant entries", () => {
	const items = collectCopyItems([
		{ ...older, id: "user", message: { role: "user", content: "ignored" } },
		{ type: "custom", id: "custom", timestamp: older.timestamp },
		{ ...older, id: "empty", message: { role: "assistant", content: [] } },
	] as never);
	assert.deepEqual(items, []);
});

test("creates stable unique item identifiers", () => {
	const items = collectCopyItems([newer] as never);
	assert.equal(new Set(items.map((item) => item.id)).size, items.length);
	assert.equal(items[0]?.id, "newer:message");
});
```

- [ ] **Step 2: Run the collector tests and observe the expected failure**

Run:

```sh
nix develop -c node --test --experimental-strip-types extensions/copy-actions/copy-items.test.ts
```

Expected result: FAIL because `collectCopyItems()` and `extractAssistantText()` do not exist.

- [ ] **Step 3: Implement text collection and ordering**

Add these imports and interfaces to `copy-items.ts`:

```typescript
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { extractCopyItems } from "./extract.ts";

export type BranchEntry = ReturnType<
	ExtensionCommandContext["sessionManager"]["getBranch"]
>[number];

type AssistantEntry = {
	id: string;
	timestamp: string;
	content: unknown;
};
```

Add these functions:

```typescript
export function extractAssistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.flatMap((part) => {
			if (!part || typeof part !== "object") return [];
			if ((part as { type?: unknown }).type !== "text") return [];
			const text = (part as { text?: unknown }).text;
			return typeof text === "string" && text.length > 0 ? [text] : [];
		})
		.join("\n\n");
}

function asAssistantEntry(entry: BranchEntry): AssistantEntry | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as { role?: unknown; content?: unknown };
	if (message.role !== "assistant") return undefined;
	return { id: entry.id, timestamp: entry.timestamp, content: message.content };
}

export function collectCopyItems(entries: BranchEntry[]): CopyItem[] {
	const assistantEntries = entries
		.flatMap((entry) => {
			const assistant = asAssistantEntry(entry);
			return assistant ? [assistant] : [];
		})
		.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));

	const items: CopyItem[] = [];
	for (const entry of assistantEntries) {
		const content = extractAssistantText(entry.content);
		if (content.length === 0) continue;
		const sourceLabel = new Date(entry.timestamp).toLocaleTimeString();
		items.push({
			id: `${entry.id}:message`,
			kind: "message",
			content,
			messageId: entry.id,
			sourceLabel,
			sourcePosition: -1,
		});

		for (const extracted of extractCopyItems(content)) {
			items.push({
				...extracted,
				id: `${entry.id}:${extracted.kind}:${extracted.sourcePosition}`,
				messageId: entry.id,
				sourceLabel,
			});
		}
	}
	return items;
}
```

Use a type-only Pi import. The pure tests then run without an installed Pi runtime package.

- [ ] **Step 4: Run both core test files**

Run:

```sh
nix develop -c node --test --experimental-strip-types \
  extensions/copy-actions/extract.test.ts \
  extensions/copy-actions/copy-items.test.ts
```

Expected result: 9 tests pass and 0 tests fail.

- [ ] **Step 5: Commit the branch collector**

```sh
git add extensions/copy-actions/copy-items.ts extensions/copy-actions/copy-items.test.ts
git commit -m "feat(copy-actions): collect assistant copy items"
```

---

### Task 3: Enforce copy and insert actions

**Files:**
- Create: `extensions/copy-actions/actions.ts`
- Create: `extensions/copy-actions/actions.test.ts`

**Interfaces:**
- Consumes: `CopySelection`, `copyItemKindLabel()`, `isInsertableCopyItem()`
- Produces: `performCopyAction(ctx, selection, copyText): Promise<void>`
- `copyText` has the exact interface `(content: string) => Promise<void>`.

- [ ] **Step 1: Write the failing action tests**

Create `actions.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { performCopyAction } from "./actions.ts";
import type { CopyItem } from "./copy-items.ts";

function item(kind: CopyItem["kind"], content = "content"): CopyItem {
	return {
		id: `item:${kind}`,
		kind,
		content,
		messageId: "message-1",
		sourceLabel: "10:00:00",
		sourcePosition: 0,
	};
}

function context(existing = "") {
	const state = { editor: existing, notifications: [] as Array<[string, string]> };
	const ctx = {
		ui: {
			getEditorText: () => state.editor,
			setEditorText: (value: string) => { state.editor = value; },
			notify: (message: string, level: string) => state.notifications.push([message, level]),
		},
	};
	return { ctx: ctx as never, state };
}

test("copies every item type through the clipboard dependency", async () => {
	for (const kind of ["message", "pipe-message", "code", "inline"] as const) {
		const { ctx, state } = context();
		const copied: string[] = [];
		await performCopyAction(ctx, { item: item(kind, kind), action: "copy" }, async (text) => {
			copied.push(text);
		});
		assert.deepEqual(copied, [kind]);
		assert.deepEqual(state.notifications, [[`Copied ${kind === "pipe-message" ? "pipe message" : kind} to clipboard.`, "info"]]);
	}
});

test("inserts code into empty and non-empty editors", async () => {
	for (const [existing, expected] of [["", "echo ok"], ["existing", "existing\necho ok"]]) {
		const { ctx, state } = context(existing);
		await performCopyAction(ctx, { item: item("code", "echo ok"), action: "insert" }, async () => {});
		assert.equal(state.editor, expected);
		assert.deepEqual(state.notifications, [["Inserted code into editor.", "info"]]);
	}
});

test("rejects insertion for message items without changing the editor", async () => {
	const { ctx, state } = context("existing");
	await performCopyAction(ctx, { item: item("message"), action: "insert" }, async () => {});
	assert.equal(state.editor, "existing");
	assert.deepEqual(state.notifications, [["Only code items can be inserted.", "error"]]);
});

test("shows the clipboard error without changing the editor", async () => {
	const { ctx, state } = context("existing");
	await performCopyAction(ctx, { item: item("message"), action: "copy" }, async () => {
		throw new Error("Clipboard unavailable");
	});
	assert.equal(state.editor, "existing");
	assert.deepEqual(state.notifications, [["Clipboard unavailable", "error"]]);
});
```

- [ ] **Step 2: Run the action tests and observe the expected failure**

Run:

```sh
nix develop -c node --test --experimental-strip-types extensions/copy-actions/actions.test.ts
```

Expected result: FAIL because `extensions/copy-actions/actions.ts` does not exist.

- [ ] **Step 3: Implement the action dispatcher**

Create `actions.ts`:

```typescript
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	copyItemKindLabel,
	isInsertableCopyItem,
	type CopySelection,
} from "./copy-items.ts";

export type CopyText = (content: string) => Promise<void>;

type ActionContext = Pick<ExtensionCommandContext, "ui">;

export async function performCopyAction(
	ctx: ActionContext,
	selection: CopySelection,
	copyText: CopyText,
): Promise<void> {
	if (selection.action === "copy") {
		try {
			await copyText(selection.item.content);
			ctx.ui.notify(
				`Copied ${copyItemKindLabel(selection.item.kind)} to clipboard.`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(
				error instanceof Error ? error.message : "Failed to copy to clipboard.",
				"error",
			);
		}
		return;
	}

	if (!isInsertableCopyItem(selection.item)) {
		ctx.ui.notify("Only code items can be inserted.", "error");
		return;
	}

	const existing = ctx.ui.getEditorText();
	ctx.ui.setEditorText(existing ? `${existing}\n${selection.item.content}` : selection.item.content);
	ctx.ui.notify("Inserted code into editor.", "info");
}
```

This module has no runtime Pi import. Unit tests can use structural fakes.

- [ ] **Step 4: Run all current tests**

Run:

```sh
nix develop -c node --test --experimental-strip-types extensions/copy-actions/*.test.ts
```

Expected result: 13 tests pass and 0 tests fail.

- [ ] **Step 5: Commit the action rules**

```sh
git add extensions/copy-actions/actions.ts extensions/copy-actions/actions.test.ts
git commit -m "feat(copy-actions): add copy and insert actions"
```

---

### Task 4: Add search and the unified picker

**Files:**
- Create: `extensions/copy-actions/search.ts`
- Create: `extensions/copy-actions/search.test.ts`
- Create: `extensions/copy-actions/ui.ts`

**Interfaces:**
- Consumes: `CopyItem`, `CopySelection`, `copyItemKindLabel()`, `isInsertableCopyItem()`
- Produces: `normalizeForSearch(value: string): string`
- Produces: `buildSearchIndex(copyItems, selectItems): SearchIndexItem[]`
- Produces: `rankedFilterItems(filter, selectItems, searchIndex): SelectItem[]`
- Produces: `pickCopyItem(ctx, copyItems): Promise<CopySelection | undefined>`

- [ ] **Step 1: Write the failing search tests**

Create `search.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { CopyItem } from "./copy-items.ts";
import { buildSearchIndex, normalizeForSearch, rankedFilterItems } from "./search.ts";

const copyItems: CopyItem[] = [
	{
		id: "message",
		kind: "message",
		content: "Release summary for Slack",
		messageId: "m1",
		sourceLabel: "10:00:00",
		sourcePosition: -1,
	},
	{
		id: "pipe",
		kind: "pipe-message",
		content: "Deployment complete",
		messageId: "m1",
		sourceLabel: "10:00:00",
		sourcePosition: 2,
	},
	{
		id: "code",
		kind: "code",
		content: "npm test",
		messageId: "m2",
		sourceLabel: "09:00:00",
		sourcePosition: 4,
		language: "sh",
	},
];
const selectItems: SelectItem[] = copyItems.map((item) => ({ value: item.id, label: item.id }));
const index = buildSearchIndex(copyItems, selectItems);

test("normalizes punctuation and case", () => {
	assert.equal(normalizeForSearch("Pipe-Message: DEPLOYMENT"), "pipe message deployment");
});

test("searches content, type label, time, and language", () => {
	for (const [query, expected] of [
		["slack", "message"],
		["pipe message", "pipe"],
		["09 00", "code"],
		["sh", "code"],
	] as const) {
		assert.equal(rankedFilterItems(query, selectItems, index)[0]?.value, expected);
	}
});

test("keeps source order when scores match and returns all items for an empty filter", () => {
	assert.deepEqual(rankedFilterItems("", selectItems, index), selectItems);
	assert.deepEqual(
		rankedFilterItems("10 00", selectItems, index).map((item) => item.value),
		["message", "pipe"],
	);
});
```

- [ ] **Step 2: Run the search tests and observe the expected failure**

Run:

```sh
nix develop -c node --test --experimental-strip-types extensions/copy-actions/search.test.ts
```

Expected result: FAIL because `extensions/copy-actions/search.ts` does not exist.

- [ ] **Step 3: Adapt the upstream search module**

Create `search.ts` from the upstream ranking logic. Replace `Snippet` with `CopyItem` and index the complete item content.

```typescript
// Adapted from @signalridge/pi-code-actions. See NOTICE.
import type { SelectItem } from "@earendil-works/pi-tui";
import { copyItemKindLabel, type CopyItem } from "./copy-items.ts";

export type SearchIndexItem = {
	item: SelectItem;
	index: number;
	raw: string;
	normalized: string;
};

export function normalizeForSearch(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function buildSearchIndex(
	copyItems: CopyItem[],
	selectItems: SelectItem[],
): SearchIndexItem[] {
	return copyItems.flatMap((copyItem, index) => {
		const item = selectItems[index];
		if (!item) return [];
		const raw = [
			copyItem.content,
			copyItemKindLabel(copyItem.kind),
			copyItem.language ?? "",
			copyItem.sourceLabel,
		].join(" ").toLowerCase();
		return [{ item, index, raw, normalized: normalizeForSearch(raw) }];
	});
}

export function rankedFilterItems(
	filter: string,
	items: SelectItem[],
	searchIndex: SearchIndexItem[],
): SelectItem[] {
	const lower = filter.toLowerCase();
	if (lower.length === 0) return items;
	const normalized = normalizeForSearch(lower);
	const tokens = normalized.length > 0 ? normalized.split(" ") : [];
	const scored: Array<{ item: SelectItem; index: number; score: number }> = [];

	for (const entry of searchIndex) {
		let score = 0;
		const rawIndex = entry.raw.indexOf(lower);
		if (rawIndex !== -1) {
			score = 1000 - rawIndex;
		} else if (tokens.length > 0) {
			let firstPosition = Number.MAX_SAFE_INTEGER;
			if (tokens.some((token) => {
				const position = entry.normalized.indexOf(token);
				if (position === -1) return true;
				firstPosition = Math.min(firstPosition, position);
				return false;
			})) continue;
			score = 500 - firstPosition;
		} else {
			continue;
		}
		scored.push({ item: entry.item, index: entry.index, score });
	}

	scored.sort((left, right) => right.score - left.score || left.index - right.index);
	return scored.map((entry) => entry.item);
}
```

- [ ] **Step 4: Run the search tests and observe a passing result**

Run:

```sh
nix develop -c node --test --experimental-strip-types extensions/copy-actions/search.test.ts
```

Expected result: 3 tests pass and 0 tests fail.

- [ ] **Step 5: Implement the unified picker**

Create `ui.ts`. Adapt the upstream framed `SelectList`, but remove the action menu, Tab insertion, and shell execution.

Use these exact rules in `pickCopyItem()`:

```typescript
// Adapted from @signalridge/pi-code-actions. See NOTICE.
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyHint } from "@earendil-works/pi-coding-agent";
import {
	Container,
	decodeKittyPrintable,
	matchesKey,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";
import {
	copyItemKindLabel,
	isInsertableCopyItem,
	type CopyItem,
	type CopySelection,
} from "./copy-items.ts";
import { buildSearchIndex, rankedFilterItems } from "./search.ts";

const PREVIEW_WIDTH = 52;

function compactPreview(content: string): string {
	const preview = content.replace(/\s+/g, " ").trim();
	if (preview.length === 0) return "(empty)";
	return preview.length <= PREVIEW_WIDTH ? preview : `${preview.slice(0, PREVIEW_WIDTH - 1)}…`;
}

function buildItemLabel(item: CopyItem, index: number, indexWidth: number, timeWidth: number): string {
	const number = String(index + 1).padStart(indexWidth, " ");
	const time = item.sourceLabel.padEnd(timeWidth, " ");
	const language = item.language ? ` (${item.language})` : "";
	return `${number}. ${compactPreview(item.content)} ${time} ${copyItemKindLabel(item.kind)}${language}`;
}

export async function pickCopyItem(
	ctx: ExtensionCommandContext,
	copyItems: CopyItem[],
): Promise<CopySelection | undefined> {
	const indexWidth = String(copyItems.length).length;
	const timeWidth = Math.max(...copyItems.map((item) => item.sourceLabel.length));
	const selectItems: SelectItem[] = copyItems.map((item, index) => ({
		value: String(index),
		label: buildItemLabel(item, index, indexWidth, timeWidth),
		description: "",
	}));
	const searchIndex = buildSearchIndex(copyItems, selectItems);

	const encoded = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Copy message or code")), 1, 0));

		const list = new SelectList(selectItems, Math.min(selectItems.length, 12), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		container.addChild(list);

		let filter = "";
		const help = new Text("", 1, 0);
		const updateHelp = (): void => {
			help.setText(theme.fg(
				"dim",
				`Filter: ${filter || "(none)"} · ${keyHint("tui.select.confirm", "copy")} · Right insert code · ${keyHint("tui.select.cancel", "cancel")}`,
			));
		};
		const updateFilter = (next: string): void => {
			filter = next;
			const state = list as unknown as { filteredItems: SelectItem[]; selectedIndex: number };
			state.filteredItems = rankedFilterItems(filter, selectItems, searchIndex);
			state.selectedIndex = 0;
			updateHelp();
			list.invalidate();
			tui.requestRender();
		};
		const selectedIndex = (): number | undefined => {
			const selected = list.getSelectedItem();
			if (!selected) return undefined;
			const index = Number.parseInt(selected.value, 10);
			return Number.isNaN(index) ? undefined : index;
		};

		list.onSelect = (selected) => done(`copy:${selected.value}`);
		list.onCancel = () => done(null);
		updateHelp();
		container.addChild(help);
		container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (keybindings.matches(data, "tui.select.cancel")) {
					done(null);
					return;
				}
				if (keybindings.matches(data, "tui.select.confirm")) {
					const index = selectedIndex();
					if (index !== undefined) done(`copy:${index}`);
					return;
				}
				if (matchesKey(data, "right")) {
					const index = selectedIndex();
					if (index !== undefined && isInsertableCopyItem(copyItems[index]!)) {
						done(`insert:${index}`);
					}
					return;
				}
				if (matchesKey(data, "backspace")) {
					if (filter.length > 0) updateFilter(filter.slice(0, -1));
					return;
				}
				const printable = decodeKittyPrintable(data);
				if (printable) {
					updateFilter(filter + printable);
					return;
				}
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (!encoded) return undefined;
	const [action, rawIndex] = encoded.split(":");
	const index = Number.parseInt(rawIndex ?? "", 10);
	const item = copyItems[index];
	if (!item || (action !== "copy" && action !== "insert")) return undefined;
	if (action === "insert" && !isInsertableCopyItem(item)) return undefined;
	return { item, action };
}
```

If the installed Pi types reject `decodeKittyPrintable()`, inspect the Pi 0.84 export before changing input handling. Do not replace configured selection bindings with fixed Enter or Escape checks.

- [ ] **Step 6: Run all pure tests and commit the picker**

Run:

```sh
nix develop -c node --test --experimental-strip-types extensions/copy-actions/*.test.ts
git diff --check
git add extensions/copy-actions/search.ts extensions/copy-actions/search.test.ts extensions/copy-actions/ui.ts
git commit -m "feat(copy-actions): add searchable copy picker"
```

Expected result: 16 tests pass and 0 tests fail before the commit.

---

### Task 5: Register `/copy`, retain attribution, and verify the package

**Files:**
- Create: `extensions/copy-actions/index.ts`
- Create: `extensions/copy-actions/index.test.ts`
- Create: `extensions/copy-actions/NOTICE`

**Interfaces:**
- Consumes: `collectCopyItems()`, `pickCopyItem()`, `performCopyAction()`, and Pi's `copyToClipboard()`
- Produces: `registerCopyActions(pi, dependencies?): void`
- Produces: the default extension factory for Pi auto-discovery

- [ ] **Step 1: Write the failing command behavior tests**

Create `index.test.ts` with a complete runtime stub and command fixture:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CopyItem } from "./copy-items.ts";

const extensionDir = path.dirname(fileURLToPath(import.meta.url));

async function writeStubPackage(name: string, source: string): Promise<void> {
	const packageDir = path.join(extensionDir, "node_modules", ...name.split("/"));
	await mkdir(packageDir, { recursive: true });
	await Promise.all([
		writeFile(
			path.join(packageDir, "package.json"),
			JSON.stringify({ name, type: "module", exports: "./index.js" }, null, 2),
		),
		writeFile(path.join(packageDir, "index.js"), source.trimStart()),
	]);
}

await Promise.all([
	writeStubPackage("@earendil-works/pi-coding-agent", `
export async function copyToClipboard() {}
export class DynamicBorder { render() { return []; } invalidate() {} }
export function keyHint(_id, description) { return description; }
`),
	writeStubPackage("@earendil-works/pi-tui", `
export class Container { addChild() {} render() { return []; } invalidate() {} }
export class SelectList {}
export class Text { setText() {} }
export function decodeKittyPrintable() { return undefined; }
export function matchesKey() { return false; }
`),
]);

const { registerCopyActions } = await import("./index.ts");
await rm(path.join(extensionDir, "node_modules"), { recursive: true, force: true });

type CommandHandler = (args: string, ctx: never) => Promise<void>;
type FixtureOptions = {
	cancel?: boolean;
	entries?: unknown[];
	mode?: "tui" | "rpc";
};

function createCommandFixture(options: FixtureOptions = {}) {
	let command: CommandHandler | undefined;
	const notifications: Array<[string, string]> = [];
	const pickCalls: CopyItem[][] = [];
	const performed: Array<{ action: string; kind: string }> = [];
	const entries = options.entries ?? [
		{
			type: "message",
			id: "assistant-1",
			timestamp: "2026-09-05T10:00:00.000Z",
			message: { role: "assistant", content: "Assistant text" },
		},
	];

	const pi = {
		registerCommand: (name: string, definition: { handler: CommandHandler }) => {
			assert.equal(name, "copy");
			command = definition.handler;
		},
	};
	registerCopyActions(pi as never, {
		pickCopyItem: async (_ctx: never, items: CopyItem[]) => {
			pickCalls.push(items);
			if (options.cancel) return undefined;
			return { item: items[0]!, action: "copy" as const };
		},
		performAction: async (_ctx: never, selection) => {
			performed.push({ action: selection.action, kind: selection.item.kind });
		},
	});
	assert.ok(command);

	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: true,
		sessionManager: { getBranch: () => entries },
		ui: {
			notify: (message: string, level: string) => notifications.push([message, level]),
		},
	};
	return { command, ctx: ctx as never, notifications, pickCalls, performed };
}

test("opens the unified picker and performs its selected action", async () => {
	const fixture = createCommandFixture();
	await fixture.command("", fixture.ctx);
	assert.equal(fixture.pickCalls.length, 1);
	assert.equal(fixture.pickCalls[0]?.[0]?.kind, "message");
	assert.deepEqual(fixture.performed, [{ action: "copy", kind: "message" }]);
});

test("treats arguments as normal picker invocations instead of fast paths", async () => {
	const fixture = createCommandFixture();
	await fixture.command("latest", fixture.ctx);
	assert.equal(fixture.pickCalls.length, 1);
});

test("does nothing after picker cancellation", async () => {
	const fixture = createCommandFixture({ cancel: true });
	await fixture.command("", fixture.ctx);
	assert.deepEqual(fixture.performed, []);
});

test("warns when the active branch has no assistant messages", async () => {
	const fixture = createCommandFixture({ entries: [] });
	await fixture.command("", fixture.ctx);
	assert.deepEqual(fixture.notifications, [["No assistant messages to copy.", "warning"]]);
});

test("requires interactive TUI mode", async () => {
	const fixture = createCommandFixture({ mode: "rpc" });
	await fixture.command("", fixture.ctx);
	assert.deepEqual(fixture.notifications, [["/copy requires interactive mode.", "warning"]]);
	assert.equal(fixture.pickCalls.length, 0);
});
```

The imported extension uses the stubs only during module loading. Each behavior test injects the command dependencies that it observes.

- [ ] **Step 2: Run the command tests and observe the expected failure**

Run:

```sh
nix develop -c node --test --experimental-strip-types extensions/copy-actions/index.test.ts
```

Expected result: FAIL because `extensions/copy-actions/index.ts` does not exist.

- [ ] **Step 3: Register and coordinate `/copy`**

Create `index.ts`:

```typescript
import {
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { performCopyAction } from "./actions.ts";
import { collectCopyItems, type BranchEntry, type CopyItem, type CopySelection } from "./copy-items.ts";
import { pickCopyItem } from "./ui.ts";

export type CopyActionsDependencies = {
	pickCopyItem(
		ctx: ExtensionCommandContext,
		items: CopyItem[],
	): Promise<CopySelection | undefined>;
	performAction(
		ctx: ExtensionCommandContext,
		selection: CopySelection,
	): Promise<void>;
};

const defaultDependencies: CopyActionsDependencies = {
	pickCopyItem,
	performAction: (ctx, selection) => performCopyAction(ctx, selection, copyToClipboard),
};

export function registerCopyActions(
	pi: ExtensionAPI,
	dependencies: CopyActionsDependencies = defaultDependencies,
): void {
	pi.registerCommand("copy", {
		description: "Pick an assistant message or code item to copy or insert.",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				if (ctx.hasUI) ctx.ui.notify("/copy requires interactive mode.", "warning");
				return;
			}

			const items = collectCopyItems(ctx.sessionManager.getBranch() as BranchEntry[]);
			if (items.length === 0) {
				ctx.ui.notify("No assistant messages to copy.", "warning");
				return;
			}

			const selection = await dependencies.pickCopyItem(ctx, items);
			if (!selection) return;
			await dependencies.performAction(ctx, selection);
		},
	});
}

export default registerCopyActions;
```

Do not parse `_args`. Every invocation uses the picker.

- [ ] **Step 4: Run all command and behavior tests**

Run:

```sh
nix develop -c node --test --experimental-strip-types extensions/copy-actions/*.test.ts
```

Expected result: 21 tests pass and 0 tests fail.

- [ ] **Step 5: Add the upstream notice**

Create `NOTICE` with this exact text:

```text
This extension contains code adapted from @signalridge/pi-code-actions:
https://github.com/signalridge/pi-extensions/tree/main/packages/pi-code-actions

MIT License

Copyright (c) 2026 Thomas Mustier

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 6: Run the focused test suite and whitespace check**

Run:

```sh
nix develop -c node --test --experimental-strip-types extensions/copy-actions/*.test.ts
git diff --check
```

Expected result: 21 tests pass, 0 tests fail, and `git diff --check` prints no errors.

- [ ] **Step 7: Run the required extension-load check**

Run:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected result: exit code 0 with no extension-load error.

- [ ] **Step 8: Run the complete flake check**

Run:

```sh
nix flake check --accept-flake-config --print-build-logs
```

Expected result: exit code 0.

- [ ] **Step 9: Perform the manual TUI check**

Start Pi with the local extension:

```sh
nix run .#pi -- -e ./extensions/copy-actions/index.ts
```

Create or use assistant responses that contain these values:

````text
A full assistant response.
Use `git status`.
```sh
echo fenced
```
| Hello,
| world
````

Run `/copy` and make sure that:

1. The latest full message is selected first.
2. Search finds `message`, `pipe message`, `code`, and `inline` items.
3. Enter copies the full message without changes.
4. Enter copies the pipe item as `Hello,world`.
5. Enter copies `git status` without backticks.
6. Right Arrow inserts only code and inline items.
7. Right Arrow keeps the picker open for message items.
8. Escape closes the picker without an action.

- [ ] **Step 10: Commit the command and package integration**

```sh
git add extensions/copy-actions/index.ts extensions/copy-actions/index.test.ts extensions/copy-actions/NOTICE
git commit -m "feat(copy-actions): replace the copy command"
```

- [ ] **Step 11: Make sure that the worktree is clean**

Run:

```sh
git status --short --branch
```

Expected result: the output shows `feature/copy-actions` with no changed files.

---

## Completion Criteria

The implementation is complete only after all conditions are true:

- `/copy` always opens the unified picker in TUI mode.
- The picker includes every approved item type from assistant messages on the active branch.
- Pipe-message copies remove exact `| ` prefixes and all line separators.
- Message items cannot enter the editor.
- Code items can copy or enter the editor.
- The extension contains no shell-execution path.
- All focused tests pass.
- The Pi extension-load check passes.
- The complete flake check passes.
- The manual TUI checks pass.
- The upstream MIT notice is present.
