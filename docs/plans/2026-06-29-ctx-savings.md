# ctx-savings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/ctx-savings`, a Pi extension that shows context-mode token and projected cost savings for the current session and current worktree.

**Architecture:** Use a pure core module plus a tiny Pi extension shell. The core reads context-mode SQLite databases read-only, parses Pi session usage for observed cost rates, calculates approximate savings, and renders concise text. The extension shell registers `/ctx-savings` and refreshes a compact footer status from the current-session summary.

**Tech Stack:** TypeScript Pi extension, Node built-ins (`fs`, `path`, `os`, `crypto`, `readline`, `module`), context-mode's installed `better-sqlite3` dependency when available, Node's built-in `node:test` runner.

## Global Constraints

- Save implementation in the existing feature worktree: `/home/roche/projects/pi/roche-pi/.worktrees/ctx-savings`.
- Do not fork or patch upstream context-mode.
- Do not write to context-mode SQLite databases.
- Do not add hard-coded model pricing tables in v1.
- Use approximate token counts: `tokens = round(bytes / 4)`.
- Show `~` for token and projected cost values because they are estimates.
- Scope worktree totals to `session_meta.project_dir == ctx.cwd` after path normalization.
- Derive current context-mode session id with `sha256(ctx.sessionManager.getSessionFile()).slice(0, 16)` when available.
- If cost data is unavailable, omit only the dollar amount.
- Keep modules focused: `extensions/ctx-savings/index.ts` should be a small Pi shell; reusable logic belongs in `extensions/ctx-savings/core.ts`.
- Do not create tests or non-extension helper files as top-level `extensions/*.ts`; Pi treats top-level files as loadable extensions.

---

## File Structure

- Create `extensions/ctx-savings/core.ts`
  - Responsibility: deterministic calculations, formatting, read-only context-mode DB aggregation, Pi session usage parsing, report rendering.
  - Public exports used by tests and the extension shell: `bytesToTokens`, `formatShortNumber`, `formatUsd`, `summarizeBytes`, `projectCostSavings`, `renderSavingsReport`, `renderSavingsStatus`, `deriveContextModeSessionId`, `collectContextModeSavings`, `collectCurrentSessionUsage`, `collectWorktreeUsageFromJsonl`.
- Create `extensions/ctx-savings/index.ts`
  - Responsibility: Pi integration only. Register `/ctx-savings`; set compact status with `ctx.ui.setStatus("ctx-savings", ...)`; call core functions.
- Create `extensions/ctx-savings/core.test.ts`
  - Responsibility: focused Node tests for pure calculations, renderers, path/session helpers, row aggregation, and JSONL cost parsing.
- No Nix changes are required because `modules/packages/pi-config.nix` already copies `extensions/` into the Pi config package.

---

### Task 1: Savings math and text formatting core

**Files:**
- Create: `extensions/ctx-savings/core.ts`
- Create: `extensions/ctx-savings/core.test.ts`

**Interfaces:**
- Consumes: no project-specific code.
- Produces:
  - `export type SavingsSummary = { savedBytes: number; usedBytes: number; withoutBytes: number; savedTokens: number; usedTokens: number; withoutTokens: number; reductionPercent: number }`
  - `export function bytesToTokens(bytes: number): number`
  - `export function formatShortNumber(value: number): string`
  - `export function formatUsd(cost: number | null | undefined): string | null`
  - `export function summarizeBytes(savedBytes: number, usedBytes: number): SavingsSummary`
  - `export function projectCostSavings(savedTokens: number, actualCost: number, actualTokens: number): number | null`
  - `export function renderSavingsReport(input: RenderSavingsInput): string`
  - `export function renderSavingsStatus(scope: RenderedScope): string`

- [ ] **Step 1: Write failing tests for math and rendering**

Create `extensions/ctx-savings/core.test.ts` with this content:

```typescript
import test from "node:test";
import assert from "node:assert/strict";

import {
	bytesToTokens,
	formatShortNumber,
	formatUsd,
	projectCostSavings,
	renderSavingsReport,
	renderSavingsStatus,
	summarizeBytes,
} from "./core.ts";

test("bytesToTokens approximates one token per four bytes", () => {
	assert.equal(bytesToTokens(0), 0);
	assert.equal(bytesToTokens(4), 1);
	assert.equal(bytesToTokens(42), 11);
	assert.equal(bytesToTokens(-100), 0);
});

test("formatShortNumber uses readable token units", () => {
	assert.equal(formatShortNumber(0), "0");
	assert.equal(formatShortNumber(999), "999");
	assert.equal(formatShortNumber(4_000), "4k");
	assert.equal(formatShortNumber(21_000), "21k");
	assert.equal(formatShortNumber(695_000), "695k");
	assert.equal(formatShortNumber(5_800_000), "5.8M");
});

test("formatUsd mirrors session-breakdown display precision", () => {
	assert.equal(formatUsd(null), null);
	assert.equal(formatUsd(Number.NaN), null);
	assert.equal(formatUsd(2), "$2.00");
	assert.equal(formatUsd(0.54), "$0.540");
	assert.equal(formatUsd(0.06), "$0.0600");
});

test("summarizeBytes reports used, without, saved, and reduction", () => {
	const summary = summarizeBytes(84_000, 16_000);
	assert.equal(summary.savedTokens, 21_000);
	assert.equal(summary.usedTokens, 4_000);
	assert.equal(summary.withoutTokens, 25_000);
	assert.equal(summary.reductionPercent, 84);
});

test("summarizeBytes handles zero totals", () => {
	const summary = summarizeBytes(0, 0);
	assert.equal(summary.savedTokens, 0);
	assert.equal(summary.usedTokens, 0);
	assert.equal(summary.withoutTokens, 0);
	assert.equal(summary.reductionPercent, 0);
});

test("projectCostSavings uses observed dollars per token", () => {
	assert.equal(projectCostSavings(21_000, 0.01, 4_000), 0.0525);
	assert.equal(projectCostSavings(21_000, 0, 4_000), null);
	assert.equal(projectCostSavings(21_000, 0.01, 0), null);
});

test("renderSavingsReport shows comparative command output with costs", () => {
	const report = renderSavingsReport({
		session: {
			label: "this session",
			summary: summarizeBytes(84_000, 16_000),
			projectedCost: 0.06,
			inferred: false,
		},
		worktree: {
			label: "this worktree",
			summary: summarizeBytes(720_000, 124_000),
			projectedCost: 0.54,
			inferred: false,
		},
		skippedDbs: 0,
	});

	assert.equal(
		report,
		"ctx saved ~21k tokens (~$0.0600) this session\n" +
			"4k used / 25k without · 84% reduction\n" +
			"\n" +
			"this worktree: ~180k saved (~$0.540)\n" +
			"31k used / 211k without · 85% reduction",
	);
});

test("renderSavingsReport omits costs when usage cost data is unavailable", () => {
	const report = renderSavingsReport({
		session: {
			label: "this session",
			summary: summarizeBytes(84_000, 16_000),
			projectedCost: null,
			inferred: false,
		},
		worktree: {
			label: "this worktree",
			summary: summarizeBytes(720_000, 124_000),
			projectedCost: null,
			inferred: false,
		},
		skippedDbs: 0,
	});

	assert.equal(
		report,
		"ctx saved ~21k tokens this session\n" +
			"4k used / 25k without · 84% reduction\n" +
			"\n" +
			"this worktree: ~180k saved\n" +
			"31k used / 211k without · 85% reduction",
	);
});

test("renderSavingsStatus is compact enough for Pi footer status", () => {
	const status = renderSavingsStatus({
		label: "this session",
		summary: summarizeBytes(84_000, 16_000),
		projectedCost: 0.06,
		inferred: false,
	});
	assert.equal(status, "ctx: 4k / 25k · saved 21k (~$0.0600) · 84%");
});
```

- [ ] **Step 2: Run tests and verify the expected failure**

Run:

```bash
node --test --experimental-strip-types extensions/ctx-savings/core.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./core.ts`.

- [ ] **Step 3: Implement the minimal pure core**

Create `extensions/ctx-savings/core.ts` with these exported types and functions:

```typescript
export type SavingsSummary = {
	savedBytes: number;
	usedBytes: number;
	withoutBytes: number;
	savedTokens: number;
	usedTokens: number;
	withoutTokens: number;
	reductionPercent: number;
};

export type RenderedScope = {
	label: string;
	summary: SavingsSummary;
	projectedCost: number | null;
	inferred: boolean;
};

export type RenderSavingsInput = {
	session: RenderedScope | null;
	worktree: RenderedScope | null;
	skippedDbs: number;
};

function finiteNonNegative(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

function trimOneDecimal(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}

export function bytesToTokens(bytes: number): number {
	return Math.round(finiteNonNegative(bytes) / 4);
}

export function formatShortNumber(value: number): string {
	const rounded = Math.round(finiteNonNegative(value));
	if (rounded >= 1_000_000) return `${trimOneDecimal(rounded / 1_000_000)}M`;
	if (rounded >= 1_000) return `${trimOneDecimal(rounded / 1_000)}k`;
	return rounded.toLocaleString("en-US");
}

export function formatUsd(cost: number | null | undefined): string | null {
	if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) return null;
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost >= 0.1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(4)}`;
}

export function summarizeBytes(savedBytes: number, usedBytes: number): SavingsSummary {
	const saved = finiteNonNegative(savedBytes);
	const used = finiteNonNegative(usedBytes);
	const without = saved + used;
	return {
		savedBytes: saved,
		usedBytes: used,
		withoutBytes: without,
		savedTokens: bytesToTokens(saved),
		usedTokens: bytesToTokens(used),
		withoutTokens: bytesToTokens(without),
		reductionPercent: without > 0 ? Math.round((saved / without) * 100) : 0,
	};
}

export function projectCostSavings(savedTokens: number, actualCost: number, actualTokens: number): number | null {
	if (!Number.isFinite(savedTokens) || savedTokens <= 0) return null;
	if (!Number.isFinite(actualCost) || actualCost <= 0) return null;
	if (!Number.isFinite(actualTokens) || actualTokens <= 0) return null;
	return savedTokens * (actualCost / actualTokens);
}

function costSuffix(cost: number | null): string {
	const formatted = formatUsd(cost);
	return formatted ? ` (~${formatted})` : "";
}

function firstLine(scope: RenderedScope): string {
	const prefix = scope.label === "this session" ? "ctx saved" : `${scope.label}:`;
	const suffix = scope.label === "this session" ? ` ${scope.label}` : "";
	const inferred = scope.inferred ? " inferred" : "";
	return `${prefix} ~${formatShortNumber(scope.summary.savedTokens)} tokens${costSuffix(scope.projectedCost)}${suffix}${inferred}`;
}

function comparisonLine(scope: RenderedScope): string {
	return `${formatShortNumber(scope.summary.usedTokens)} used / ${formatShortNumber(scope.summary.withoutTokens)} without · ${scope.summary.reductionPercent}% reduction`;
}

export function renderSavingsReport(input: RenderSavingsInput): string {
	const sections: string[] = [];
	if (input.session) sections.push(`${firstLine(input.session)}\n${comparisonLine(input.session)}`);
	if (input.worktree) sections.push(`${firstLine(input.worktree)}\n${comparisonLine(input.worktree)}`);
	if (sections.length === 0) return "No context-mode savings data found for this worktree yet.";
	if (input.skippedDbs > 0) sections.push(`Skipped ${input.skippedDbs} unreadable context-mode DB${input.skippedDbs === 1 ? "" : "s"}.`);
	return sections.join("\n\n");
}

export function renderSavingsStatus(scope: RenderedScope): string {
	return `ctx: ${formatShortNumber(scope.summary.usedTokens)} / ${formatShortNumber(scope.summary.withoutTokens)} · saved ${formatShortNumber(scope.summary.savedTokens)}${costSuffix(scope.projectedCost)} · ${scope.summary.reductionPercent}%`;
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
node --test --experimental-strip-types extensions/ctx-savings/core.test.ts
```

Expected: PASS for all tests in `ctx-savings/core.test.ts`. Node may print the existing `MODULE_TYPELESS_PACKAGE_JSON` warning; that warning is acceptable.

- [ ] **Step 5: Commit Task 1**

```bash
git add extensions/ctx-savings/core.ts extensions/ctx-savings/core.test.ts
git commit -m "feat(ctx-savings): add savings formatting core"
```

---

### Task 2: Context-mode SQLite aggregation

**Files:**
- Modify: `extensions/ctx-savings/core.ts`
- Modify: `extensions/ctx-savings/core.test.ts`

**Interfaces:**
- Consumes:
  - `SavingsSummary`, `summarizeBytes()` from Task 1.
- Produces:
  - `export type ContextModeSavings = { sessionRaw: RawSavings | null; worktreeRaw: RawSavings | null; inferredSession: boolean; skippedDbs: number; matchedSessions: number }`
  - `export function deriveContextModeSessionId(ctx: unknown): string | null`
  - `export function normalizeProjectPath(projectPath: string): string`
  - `export function aggregateSessionRows(rows: SessionSavingsRow[], cwd: string, sessionId: string | null): ContextModeSavings`
  - `export async function collectContextModeSavings(options: CollectContextModeSavingsOptions): Promise<ContextModeSavings>`

- [ ] **Step 1: Add failing tests for session id, path matching, and row aggregation**

Append these tests to `extensions/ctx-savings/core.test.ts`:

```typescript
import { createHash } from "node:crypto";
import {
	aggregateSessionRows,
	deriveContextModeSessionId,
	normalizeProjectPath,
} from "./core.ts";

test("deriveContextModeSessionId matches context-mode Pi hashing", () => {
	const sessionFile = "/home/roche/.pi/agent/sessions/demo.jsonl";
	const expected = createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);
	const ctx = { sessionManager: { getSessionFile: () => sessionFile } };
	assert.equal(deriveContextModeSessionId(ctx), expected);
});

test("deriveContextModeSessionId returns null when Pi session file is unavailable", () => {
	assert.equal(deriveContextModeSessionId({}), null);
	assert.equal(deriveContextModeSessionId({ sessionManager: { getSessionFile: () => 42 } }), null);
});

test("normalizeProjectPath normalizes separators and trailing slashes", () => {
	assert.equal(normalizeProjectPath("/tmp/project///"), "/tmp/project");
	assert.equal(normalizeProjectPath("C:\\tmp\\project\\"), "C:/tmp/project");
});

test("aggregateSessionRows returns exact current session and worktree totals", () => {
	const rows = [
		{ sessionId: "current", projectDir: "/repo/app", lastEventAt: "2026-06-29 10:00:00", savedBytes: 84_000, usedBytes: 16_000 },
		{ sessionId: "older", projectDir: "/repo/app/", lastEventAt: "2026-06-28 10:00:00", savedBytes: 40_000, usedBytes: 8_000 },
		{ sessionId: "other", projectDir: "/repo/other", lastEventAt: "2026-06-29 11:00:00", savedBytes: 999_000, usedBytes: 999_000 },
	];

	const result = aggregateSessionRows(rows, "/repo/app", "current");
	assert.equal(result.sessionRaw?.savedBytes, 84_000);
	assert.equal(result.sessionRaw?.usedBytes, 16_000);
	assert.equal(result.worktreeRaw?.savedBytes, 124_000);
	assert.equal(result.worktreeRaw?.usedBytes, 24_000);
	assert.equal(result.matchedSessions, 2);
	assert.equal(result.inferredSession, false);
});

test("aggregateSessionRows infers current session from latest worktree row when needed", () => {
	const rows = [
		{ sessionId: "older", projectDir: "/repo/app", lastEventAt: "2026-06-28 10:00:00", savedBytes: 40_000, usedBytes: 8_000 },
		{ sessionId: "newer", projectDir: "/repo/app", lastEventAt: "2026-06-29 10:00:00", savedBytes: 84_000, usedBytes: 16_000 },
	];

	const result = aggregateSessionRows(rows, "/repo/app", null);
	assert.equal(result.sessionRaw?.savedBytes, 84_000);
	assert.equal(result.sessionRaw?.usedBytes, 16_000);
	assert.equal(result.inferredSession, true);
});
```

- [ ] **Step 2: Run tests and verify the expected failure**

Run:

```bash
node --test --experimental-strip-types extensions/ctx-savings/core.test.ts
```

Expected: FAIL because `aggregateSessionRows`, `deriveContextModeSessionId`, and `normalizeProjectPath` are not exported yet.

- [ ] **Step 3: Add path/session helpers and pure row aggregation**

Add these exports to `extensions/ctx-savings/core.ts`:

```typescript
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type RawSavings = {
	savedBytes: number;
	usedBytes: number;
};

export type SessionSavingsRow = {
	sessionId: string;
	projectDir: string;
	lastEventAt: string | null;
	savedBytes: number;
	usedBytes: number;
};

export type ContextModeSavings = {
	sessionRaw: RawSavings | null;
	worktreeRaw: RawSavings | null;
	inferredSession: boolean;
	skippedDbs: number;
	matchedSessions: number;
};

export type CollectContextModeSavingsOptions = {
	cwd: string;
	sessionId: string | null;
	homeDir?: string;
};

export function normalizeProjectPath(projectPath: string): string {
	const normalized = String(projectPath || "").replace(/\\/g, "/").replace(/\/+$/g, "");
	return normalized || "/";
}

export function deriveContextModeSessionId(ctx: unknown): string | null {
	try {
		const sessionFile = (ctx as any)?.sessionManager?.getSessionFile?.();
		if (typeof sessionFile !== "string" || !sessionFile) return null;
		return createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);
	} catch {
		return null;
	}
}

function addRaw(a: RawSavings | null, b: RawSavings): RawSavings {
	return {
		savedBytes: (a?.savedBytes ?? 0) + finiteNonNegative(b.savedBytes),
		usedBytes: (a?.usedBytes ?? 0) + finiteNonNegative(b.usedBytes),
	};
}

export function aggregateSessionRows(rows: SessionSavingsRow[], cwd: string, sessionId: string | null): ContextModeSavings {
	const target = normalizeProjectPath(cwd);
	const matches = rows.filter((row) => normalizeProjectPath(row.projectDir) === target);
	let worktreeRaw: RawSavings | null = null;
	for (const row of matches) {
		worktreeRaw = addRaw(worktreeRaw, row);
	}

	let inferredSession = false;
	let selected = sessionId ? matches.find((row) => row.sessionId === sessionId) ?? null : null;
	if (!selected && matches.length > 0) {
		selected = [...matches].sort((a, b) => String(b.lastEventAt ?? "").localeCompare(String(a.lastEventAt ?? "")))[0] ?? null;
		inferredSession = true;
	}

	return {
		sessionRaw: selected ? { savedBytes: finiteNonNegative(selected.savedBytes), usedBytes: finiteNonNegative(selected.usedBytes) } : null,
		worktreeRaw,
		inferredSession,
		skippedDbs: 0,
		matchedSessions: matches.length,
	};
}
```

- [ ] **Step 4: Add read-only SQLite collection**

Add these functions below the pure aggregation code in `extensions/ctx-savings/core.ts`:

```typescript
type DatabaseCtor = new (filename: string, options?: { readonly?: boolean; fileMustExist?: boolean }) => any;

function resolveContextModePackageJson(homeDir: string): string | null {
	try {
		const requireHere = createRequire(import.meta.url);
		return requireHere.resolve("context-mode/package.json");
	} catch {
		// fall through to mcp.json discovery
	}

	try {
		const mcpPath = path.join(homeDir, ".pi", "agent", "mcp.json");
		const parsed = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
		const command = parsed?.mcpServers?.["context-mode"]?.command;
		if (typeof command !== "string" || !path.isAbsolute(command)) return null;
		const packageJson = path.join(path.dirname(path.dirname(command)), "lib", "node_modules", "context-mode", "package.json");
		return fs.existsSync(packageJson) ? packageJson : null;
	} catch {
		return null;
	}
}

function loadBetterSqlite3(homeDir: string): DatabaseCtor | null {
	try {
		const requireHere = createRequire(import.meta.url);
		return requireHere("better-sqlite3") as DatabaseCtor;
	} catch {
		// fall through to context-mode dependency discovery
	}

	const contextModePackageJson = resolveContextModePackageJson(homeDir);
	if (!contextModePackageJson) return null;
	try {
		return createRequire(contextModePackageJson)("better-sqlite3") as DatabaseCtor;
	} catch {
		return null;
	}
}

function listContextModeDbs(homeDir: string): string[] {
	const sessionsDir = path.join(homeDir, ".pi", "context-mode", "sessions");
	try {
		return fs
			.readdirSync(sessionsDir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".db"))
			.map((entry) => path.join(sessionsDir, entry.name));
	} catch {
		return [];
	}
}

function readRowsFromDb(db: any): SessionSavingsRow[] {
	const metaRows = db
		.prepare("select session_id as sessionId, project_dir as projectDir, last_event_at as lastEventAt from session_meta")
		.all() as Array<{ sessionId: string; projectDir: string; lastEventAt: string | null }>;

	return metaRows.map((row) => {
		const bytes = db
			.prepare(
				"select coalesce(sum(bytes_avoided), 0) as savedBytes, coalesce(sum(bytes_returned), 0) as usedBytes from session_events where session_id = ?",
			)
			.get(row.sessionId) as { savedBytes?: number; usedBytes?: number };
		return {
			sessionId: row.sessionId,
			projectDir: row.projectDir,
			lastEventAt: row.lastEventAt,
			savedBytes: Number(bytes.savedBytes ?? 0),
			usedBytes: Number(bytes.usedBytes ?? 0),
		};
	});
}

export async function collectContextModeSavings(options: CollectContextModeSavingsOptions): Promise<ContextModeSavings> {
	const homeDir = options.homeDir ?? os.homedir();
	const Database = loadBetterSqlite3(homeDir);
	if (!Database) {
		return { sessionRaw: null, worktreeRaw: null, inferredSession: false, skippedDbs: 0, matchedSessions: 0 };
	}

	const rows: SessionSavingsRow[] = [];
	let skippedDbs = 0;
	for (const dbPath of listContextModeDbs(homeDir)) {
		let db: any = null;
		try {
			db = new Database(dbPath, { readonly: true, fileMustExist: true });
			rows.push(...readRowsFromDb(db));
		} catch {
			skippedDbs += 1;
		} finally {
			try {
				db?.close?.();
			} catch {
				// ignore close failures for read-only best-effort reporting
			}
		}
	}

	return { ...aggregateSessionRows(rows, options.cwd, options.sessionId), skippedDbs };
}
```

- [ ] **Step 5: Run tests and verify they pass**

Run:

```bash
node --test --experimental-strip-types extensions/ctx-savings/core.test.ts
```

Expected: PASS for all tests in `ctx-savings/core.test.ts`.

- [ ] **Step 6: Run direct SQLite verification against local context-mode data**

Run:

```bash
node --experimental-strip-types --input-type=module <<'NODE'
import { collectContextModeSavings, deriveContextModeSessionId } from "./extensions/ctx-savings/core.ts";
const result = await collectContextModeSavings({ cwd: process.cwd(), sessionId: null });
console.log(JSON.stringify({
  matchedSessions: result.matchedSessions,
  skippedDbs: result.skippedDbs,
  hasWorktree: Boolean(result.worktreeRaw),
  worktreeSavedBytes: result.worktreeRaw?.savedBytes ?? 0,
}, null, 2));
NODE
```

Expected: command exits 0 and prints JSON. In this repo, `matchedSessions` should be greater than 0 if context-mode has recorded sessions for the worktree; `matchedSessions: 0` is acceptable on a fresh machine.

- [ ] **Step 7: Commit Task 2**

```bash
git add extensions/ctx-savings/core.ts extensions/ctx-savings/core.test.ts
git commit -m "feat(ctx-savings): read context-mode savings data"
```

---

### Task 3: Observed cost-rate extraction from Pi session usage

**Files:**
- Modify: `extensions/ctx-savings/core.ts`
- Modify: `extensions/ctx-savings/core.test.ts`

**Interfaces:**
- Consumes:
  - `projectCostSavings()` from Task 1.
- Produces:
  - `export type UsageTotals = { totalTokens: number; totalCost: number }`
  - `export function extractCostTotal(usage: unknown): number`
  - `export function extractTokensTotal(usage: unknown): number`
  - `export function collectCurrentSessionUsage(ctx: unknown): UsageTotals`
  - `export async function collectWorktreeUsageFromJsonl(cwd: string, homeDir?: string): Promise<UsageTotals>`
  - `export function projectedCostForSummary(summary: SavingsSummary, usage: UsageTotals): number | null`

- [ ] **Step 1: Add failing tests for usage parsing and JSONL worktree cost aggregation**

Append these imports to the existing import block in `extensions/ctx-savings/core.test.ts`:

```typescript
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
```

Append these functions to the existing named import from `./core.ts`:

```typescript
collectCurrentSessionUsage,
collectWorktreeUsageFromJsonl,
extractCostTotal,
extractTokensTotal,
projectedCostForSummary,
```

Append these tests:

```typescript
test("extractCostTotal accepts common Pi usage cost shapes", () => {
	assert.equal(extractCostTotal({ cost: 0.25 }), 0.25);
	assert.equal(extractCostTotal({ cost: "0.25" }), 0.25);
	assert.equal(extractCostTotal({ cost: { total: 0.25 } }), 0.25);
	assert.equal(extractCostTotal({ cost: { total: "0.25" } }), 0.25);
	assert.equal(extractCostTotal({}), 0);
});

test("extractTokensTotal accepts common Pi usage token shapes", () => {
	assert.equal(extractTokensTotal({ totalTokens: 12 }), 12);
	assert.equal(extractTokensTotal({ total_tokens: 13 }), 13);
	assert.equal(extractTokensTotal({ promptTokens: 10, completionTokens: 5 }), 15);
	assert.equal(extractTokensTotal({ inputTokens: 10, outputTokens: 5, cacheRead: 2, cacheWrite: 3 }), 20);
	assert.equal(extractTokensTotal({ tokens: { total: 17 } }), 17);
	assert.equal(extractTokensTotal({}), 0);
});

test("collectCurrentSessionUsage reads assistant message usage from Pi entries", () => {
	const ctx = {
		sessionManager: {
			getEntries: () => [
				{ type: "message", message: { role: "user", usage: { inputTokens: 999, cost: 9 } } },
				{ type: "message", message: { role: "assistant", usage: { inputTokens: 10, outputTokens: 5, cacheRead: 2, cacheWrite: 3, cost: { total: 0.01 } } } },
				{ type: "message", message: { role: "assistant", usage: { totalTokens: 8, cost: 0.02 } } },
			],
		},
	};

	assert.deepEqual(collectCurrentSessionUsage(ctx), { totalTokens: 28, totalCost: 0.03 });
});

test("projectedCostForSummary uses observed usage rate", () => {
	const summary = summarizeBytes(84_000, 16_000);
	assert.equal(projectedCostForSummary(summary, { totalTokens: 4_000, totalCost: 0.01 }), 0.0525);
	assert.equal(projectedCostForSummary(summary, { totalTokens: 0, totalCost: 0.01 }), null);
});

test("collectWorktreeUsageFromJsonl aggregates matching cwd sessions only", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-savings-"));
	const sessionsDir = path.join(home, ".pi", "agent", "sessions", "2026", "06");
	await fs.mkdir(sessionsDir, { recursive: true });

	await fs.writeFile(
		path.join(sessionsDir, "matching.jsonl"),
		[
			JSON.stringify({ type: "session_start", cwd: "/repo/app", timestamp: "2026-06-29T10:00:00Z" }),
			JSON.stringify({ type: "message", message: { role: "assistant", usage: { inputTokens: 10, outputTokens: 5, cost: 0.01 } } }),
			JSON.stringify({ type: "message", provider: "x", model: "y", usage: { totalTokens: 20, cost: { total: 0.02 } } }),
		].join("\n") + "\n",
	);
	await fs.writeFile(
		path.join(sessionsDir, "other.jsonl"),
		[
			JSON.stringify({ type: "session_start", cwd: "/repo/other", timestamp: "2026-06-29T10:00:00Z" }),
			JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 999, cost: 9 } } }),
		].join("\n") + "\n",
	);

	assert.deepEqual(await collectWorktreeUsageFromJsonl("/repo/app/", home), { totalTokens: 35, totalCost: 0.03 });
});
```

- [ ] **Step 2: Run tests and verify the expected failure**

Run:

```bash
node --test --experimental-strip-types extensions/ctx-savings/core.test.ts
```

Expected: FAIL because the usage extraction exports do not exist yet.

- [ ] **Step 3: Implement usage extraction helpers**

Add these functions to `extensions/ctx-savings/core.ts`, using the same usage-shape approach as `extensions/session-breakdown.ts`:

```typescript
import { createReadStream } from "node:fs";
import readline from "node:readline";

export type UsageTotals = {
	totalTokens: number;
	totalCost: number;
};

function readNum(value: unknown): number {
	if (typeof value === "number") return Number.isFinite(value) ? value : 0;
	if (typeof value === "string") {
		const n = Number(value);
		return Number.isFinite(n) ? n : 0;
	}
	return 0;
}

export function extractCostTotal(usage: unknown): number {
	const u = usage as any;
	if (!u) return 0;
	const direct = readNum(u.cost);
	if (direct > 0) return direct;
	return readNum(u.cost?.total);
}

export function extractTokensTotal(usage: unknown): number {
	const u = usage as any;
	if (!u) return 0;
	const direct = readNum(u.totalTokens) || readNum(u.total_tokens) || readNum(u.tokenCount) || readNum(u.token_count);
	if (direct > 0) return direct;
	const nested = readNum(u.tokens?.total) || readNum(u.tokens?.totalTokens) || readNum(u.tokens?.total_tokens);
	if (nested > 0) return nested;
	const promptCompletion = readNum(u.promptTokens) + readNum(u.completionTokens) + readNum(u.prompt_tokens) + readNum(u.completion_tokens);
	if (promptCompletion > 0) return promptCompletion;
	return readNum(u.inputTokens) + readNum(u.outputTokens) + readNum(u.input_tokens) + readNum(u.output_tokens) + readNum(u.cacheRead) + readNum(u.cacheWrite);
}

export function collectCurrentSessionUsage(ctx: unknown): UsageTotals {
	let totalTokens = 0;
	let totalCost = 0;
	const entries = (ctx as any)?.sessionManager?.getEntries?.() ?? [];
	for (const entry of entries) {
		if ((entry as any)?.type !== "message") continue;
		const message = (entry as any)?.message;
		if (message?.role !== "assistant") continue;
		const usage = message.usage;
		totalTokens += extractTokensTotal(usage);
		totalCost += extractCostTotal(usage);
	}
	return { totalTokens, totalCost };
}

export function projectedCostForSummary(summary: SavingsSummary, usage: UsageTotals): number | null {
	return projectCostSavings(summary.savedTokens, usage.totalCost, usage.totalTokens);
}
```

- [ ] **Step 4: Implement JSONL worktree usage scanning**

Add these functions to `extensions/ctx-savings/core.ts`:

```typescript
async function walkJsonlFiles(dir: string): Promise<string[]> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await walkJsonlFiles(fullPath)));
		if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
	}
	return files;
}

async function readSessionJsonlUsage(filePath: string): Promise<{ cwd: string | null; usage: UsageTotals } | null> {
	const stream = createReadStream(filePath, { encoding: "utf8" });
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
	let cwd: string | null = null;
	let totalTokens = 0;
	let totalCost = 0;

	try {
		for await (const line of rl) {
			if (!line.trim()) continue;
			let obj: any;
			try {
				obj = JSON.parse(line);
			} catch {
				continue;
			}

			if (obj?.type === "session_start" && typeof obj.cwd === "string") {
				cwd = obj.cwd;
				continue;
			}

			if (obj?.type !== "message") continue;
			const message = obj.message;
			const usage = obj.usage ?? message?.usage;
			const role = message?.role ?? obj.role;
			if (role && role !== "assistant") continue;
			totalTokens += extractTokensTotal(usage);
			totalCost += extractCostTotal(usage);
		}
	} finally {
		rl.close();
		stream.destroy();
	}

	return cwd ? { cwd, usage: { totalTokens, totalCost } } : null;
}

export async function collectWorktreeUsageFromJsonl(cwd: string, homeDir = os.homedir()): Promise<UsageTotals> {
	const target = normalizeProjectPath(cwd);
	const root = path.join(homeDir, ".pi", "agent", "sessions");
	let totalTokens = 0;
	let totalCost = 0;
	for (const filePath of await walkJsonlFiles(root)) {
		const session = await readSessionJsonlUsage(filePath);
		if (!session) continue;
		if (normalizeProjectPath(session.cwd) !== target) continue;
		totalTokens += session.usage.totalTokens;
		totalCost += session.usage.totalCost;
	}
	return { totalTokens, totalCost };
}
```

- [ ] **Step 5: Run tests and verify they pass**

Run:

```bash
node --test --experimental-strip-types extensions/ctx-savings/core.test.ts
```

Expected: PASS for all tests in `ctx-savings/core.test.ts`.

- [ ] **Step 6: Commit Task 3**

```bash
git add extensions/ctx-savings/core.ts extensions/ctx-savings/core.test.ts
git commit -m "feat(ctx-savings): project cost savings"
```

---

### Task 4: Pi command and compact status/footer integration

**Files:**
- Create: `extensions/ctx-savings/index.ts`
- Modify: `extensions/ctx-savings/core.ts`
- Modify: `extensions/ctx-savings/core.test.ts`

**Interfaces:**
- Consumes:
  - `collectContextModeSavings()` from Task 2.
  - `collectCurrentSessionUsage()` and `collectWorktreeUsageFromJsonl()` from Task 3.
  - render functions from Task 1.
- Produces:
  - Pi command `/ctx-savings`.
  - Footer status key `ctx-savings` with text like `ctx: 4k / 25k · saved 21k (~$0.0600) · 84%`.
  - `export async function buildSavingsReport(ctx: unknown, options?: { includeWorktree?: boolean }): Promise<{ text: string; status: string | null }>` for command/status wiring.

- [ ] **Step 1: Add failing tests for report assembly**

Append these imports to the existing named import from `./core.ts`:

```typescript
buildRenderedSavings,
```

Append this test to `extensions/ctx-savings/core.test.ts`:

```typescript
test("buildRenderedSavings combines DB savings and observed usage rates", () => {
	const rendered = buildRenderedSavings({
		contextMode: {
			sessionRaw: { savedBytes: 84_000, usedBytes: 16_000 },
			worktreeRaw: { savedBytes: 720_000, usedBytes: 124_000 },
			inferredSession: false,
			skippedDbs: 0,
			matchedSessions: 3,
		},
		currentUsage: { totalTokens: 4_000, totalCost: 0.01 },
		worktreeUsage: { totalTokens: 31_000, totalCost: 0.093 },
	});

	assert.equal(rendered.status, "ctx: 4k / 25k · saved 21k (~$0.0525) · 84%");
	assert.equal(
		rendered.text,
		"ctx saved ~21k tokens (~$0.0525) this session\n" +
			"4k used / 25k without · 84% reduction\n" +
			"\n" +
			"this worktree: ~180k saved (~$0.540)\n" +
			"31k used / 211k without · 85% reduction",
	);
});
```

- [ ] **Step 2: Run tests and verify the expected failure**

Run:

```bash
node --test --experimental-strip-types extensions/ctx-savings/core.test.ts
```

Expected: FAIL because `buildRenderedSavings` does not exist yet.

- [ ] **Step 3: Add report assembly helper**

Add this function to `extensions/ctx-savings/core.ts`:

```typescript
export type BuildRenderedSavingsInput = {
	contextMode: ContextModeSavings;
	currentUsage: UsageTotals;
	worktreeUsage: UsageTotals;
};

export function buildRenderedSavings(input: BuildRenderedSavingsInput): { text: string; status: string | null } {
	const sessionSummary = input.contextMode.sessionRaw
		? summarizeBytes(input.contextMode.sessionRaw.savedBytes, input.contextMode.sessionRaw.usedBytes)
		: null;
	const worktreeSummary = input.contextMode.worktreeRaw
		? summarizeBytes(input.contextMode.worktreeRaw.savedBytes, input.contextMode.worktreeRaw.usedBytes)
		: null;

	const session: RenderedScope | null = sessionSummary
		? {
				label: "this session",
				summary: sessionSummary,
				projectedCost: projectedCostForSummary(sessionSummary, input.currentUsage),
				inferred: input.contextMode.inferredSession,
			}
		: null;
	const worktree: RenderedScope | null = worktreeSummary
		? {
				label: "this worktree",
				summary: worktreeSummary,
				projectedCost: projectedCostForSummary(worktreeSummary, input.worktreeUsage),
				inferred: false,
			}
		: null;

	return {
		text: renderSavingsReport({ session, worktree, skippedDbs: input.contextMode.skippedDbs }),
		status: session ? renderSavingsStatus(session) : null,
	};
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
node --test --experimental-strip-types extensions/ctx-savings/core.test.ts
```

Expected: PASS for all tests in `ctx-savings/core.test.ts`.

- [ ] **Step 5: Create the Pi extension shell**

Create `extensions/ctx-savings/index.ts`:

```typescript
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
	buildRenderedSavings,
	collectContextModeSavings,
	collectCurrentSessionUsage,
	collectWorktreeUsageFromJsonl,
	deriveContextModeSessionId,
} from "./core.ts";

export async function buildSavingsReport(
	ctx: ExtensionCommandContext | ExtensionContext,
	options: { includeWorktree?: boolean } = {},
): Promise<{ text: string; status: string | null }> {
	const sessionId = deriveContextModeSessionId(ctx);
	const contextMode = await collectContextModeSavings({ cwd: ctx.cwd, sessionId });
	const currentUsage = collectCurrentSessionUsage(ctx);
	const worktreeUsage = options.includeWorktree === false ? { totalTokens: 0, totalCost: 0 } : await collectWorktreeUsageFromJsonl(ctx.cwd);
	return buildRenderedSavings({ contextMode, currentUsage, worktreeUsage });
}

async function refreshStatus(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	try {
		const report = await buildSavingsReport(ctx, { includeWorktree: false });
		ctx.ui.setStatus("ctx-savings", report.status ?? undefined);
	} catch {
		ctx.ui.setStatus("ctx-savings", undefined);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("ctx-savings", {
		description: "Show context-mode token and projected cost savings for this worktree",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const report = await buildSavingsReport(ctx, { includeWorktree: true });
			if (ctx.hasUI) {
				ctx.ui.setStatus("ctx-savings", report.status ?? undefined);
			}
			pi.sendMessage({ customType: "ctx-savings", content: report.text, display: true }, { triggerTurn: false });
		},
	});

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		await refreshStatus(ctx);
	});
	pi.on("session_switch", async (_event, ctx: ExtensionContext) => {
		await refreshStatus(ctx);
	});
	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		await refreshStatus(ctx);
	});
}
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test --experimental-strip-types extensions/ctx-savings/core.test.ts
```

Expected: PASS for all tests in `ctx-savings/core.test.ts`.

- [ ] **Step 7: Run syntax/load checks for both TypeScript files**

Run:

```bash
node --experimental-strip-types --input-type=module <<'NODE'
await import("./extensions/ctx-savings/core.ts");
await import("./extensions/ctx-savings/index.ts");
console.log("ctx-savings extension imports ok");
NODE
```

Expected: prints `ctx-savings extension imports ok` and exits 0.

- [ ] **Step 8: Commit Task 4**

```bash
git add extensions/ctx-savings/index.ts extensions/ctx-savings/core.ts extensions/ctx-savings/core.test.ts
git commit -m "feat(ctx-savings): add command and footer status"
```

---

### Task 5: Final verification and packaging check

**Files:**
- Modify only if verification exposes a specific issue:
  - `extensions/ctx-savings/index.ts`
  - `extensions/ctx-savings/core.ts`
  - `extensions/ctx-savings/core.test.ts`

**Interfaces:**
- Consumes: all previous task exports and extension registration.
- Produces: verified implementation ready for review.

- [ ] **Step 1: Run the focused unit test file**

Run:

```bash
node --test --experimental-strip-types extensions/ctx-savings/core.test.ts
```

Expected: PASS for all tests in `ctx-savings/core.test.ts`.

- [ ] **Step 2: Run existing nearby extension tests**

Run:

```bash
node --test --experimental-strip-types extensions/ctx-savings/core.test.ts extensions/review/review-profile.test.ts extensions/review/review-compare.test.ts extensions/answer/answer-parser.test.ts
```

Expected: PASS for all listed test files. Node may print the existing `MODULE_TYPELESS_PACKAGE_JSON` warning; that warning is acceptable.

- [ ] **Step 3: Build the Pi config package**

Run:

```bash
nix build .#pi-config
```

Expected: build exits 0 and updates/creates the local `result` symlink.

- [ ] **Step 4: Directly verify savings report against local data**

Run:

```bash
node --experimental-strip-types --input-type=module <<'NODE'
import {
  buildRenderedSavings,
  collectContextModeSavings,
  collectCurrentSessionUsage,
  collectWorktreeUsageFromJsonl,
} from "./extensions/ctx-savings/core.ts";
const contextMode = await collectContextModeSavings({ cwd: process.cwd(), sessionId: null });
const currentUsage = { totalTokens: 0, totalCost: 0 };
const worktreeUsage = await collectWorktreeUsageFromJsonl(process.cwd());
console.log(buildRenderedSavings({ contextMode, currentUsage, worktreeUsage }).text);
NODE
```

Expected: exits 0. On this worktree with context-mode history, output should include `this worktree:`. On a machine with no matching context-mode rows, output should be `No context-mode savings data found for this worktree yet.`

- [ ] **Step 5: Manual Pi verification**

Run Pi from this worktree, reload extensions, and invoke the command:

```text
/reload
/ctx-savings
```

Expected command output shape:

```text
ctx saved ~<n> tokens [optional projected cost] this session
<n> used / <n> without · <n>% reduction

this worktree: ~<n> saved [optional projected cost]
<n> used / <n> without · <n>% reduction
```

Expected footer/status shape after at least one turn:

```text
ctx: <used> / <without> · saved <saved> [optional projected cost] · <percent>%
```

- [ ] **Step 6: Inspect final diff**

Run:

```bash
git status --short
git diff --stat HEAD
git diff HEAD -- extensions/ctx-savings/index.ts extensions/ctx-savings/core.ts extensions/ctx-savings/core.test.ts
```

Expected: only ctx-savings implementation/test files are changed since the last task commit. Diff should not include generated `result` output.

- [ ] **Step 7: Commit final verification fixes if any were needed**

If Step 1 through Step 6 required edits, commit them:

```bash
git add extensions/ctx-savings/index.ts extensions/ctx-savings/core.ts extensions/ctx-savings/core.test.ts
git commit -m "fix(ctx-savings): polish savings reporting"
```

If Step 1 through Step 6 required no edits, skip this commit.

---

## Reviewer Checklist

Before requesting review, verify:

- `/ctx-savings` shows current-session and current-worktree sections.
- Worktree rows are scoped by normalized `ctx.cwd`.
- Current session id uses the context-mode Pi hash formula.
- Context-mode SQLite files are opened read-only only.
- Projected cost is omitted when observed usage cost is unavailable.
- Footer/status uses current-session data only and does not scan all JSONL files every turn.
- No hard-coded model pricing table was added.
- `node --test --experimental-strip-types extensions/ctx-savings/core.test.ts` passes.
- `nix build .#pi-config` passes.
