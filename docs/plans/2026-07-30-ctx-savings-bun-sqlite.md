# ctx-savings Bun SQLite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the `ctx-savings` Pi footer and command by replacing production `better-sqlite3` discovery with Bun's native read-only SQLite API.

**Architecture:** Extract Context Mode database scanning behind a narrow injected database contract, then implement that contract with a dynamically imported `bun:sqlite` adapter. Keep calculations and rendering in `core.ts`; wire runtime-specific behavior only in `index.ts`; represent systemic database failure explicitly as `ctx: unavailable`.

**Tech Stack:** TypeScript Pi extensions, Bun 1.3 `bun:sqlite`, Node 24 `node:sqlite` test fixtures, `node:test`, Nix flake checks, pseudo-TTY runtime verification.

## Global Constraints

- Production database access is Bun-only; do not preserve `better-sqlite3` as a production fallback.
- Context Mode databases must be opened read-only and must never be created or modified.
- Do not add a `sqlite3` subprocess dependency or modify upstream Context Mode.
- Existing savings calculations, token approximations, projected pricing, and successful report wording must remain unchanged.
- No matching database files means no data; database files that all fail to open/query means SQLite unavailable.
- SQLite unavailable status is exactly `ctx: unavailable`.
- SQLite unavailable command text is exactly `ctx-savings unavailable: SQLite could not be initialized.`.
- Keep production modules focused: `core.ts` owns calculations/presentation, `context-mode-db.ts` owns Context Mode queries, and `bun-sqlite.ts` owns the Bun driver adapter.
- Follow red-green TDD for every production behavior change.

---

### Task 1: Extract the Context Mode database collector

**Files:**
- Create: `extensions/ctx-savings/context-mode-db.ts`
- Create: `extensions/ctx-savings/context-mode-db.test.ts`
- Read interfaces from: `extensions/ctx-savings/core.ts`

**Interfaces:**
- Consumes: `aggregateSessionRows(rows, cwd, sessionId)`, `CollectContextModeSavingsOptions`, `ContextModeSavings`, and `SessionSavingsRow` from `core.ts`.
- Produces:
  - `ContextModeDatabase`
  - `OpenContextModeDatabase`
  - `ContextModeDatabaseUnavailableError`
  - `collectContextModeSavings(options, openDatabase): Promise<ContextModeSavings>`

- [ ] **Step 1: Write the real-SQLite collector tests**

Create `extensions/ctx-savings/context-mode-db.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
	collectContextModeSavings,
	type ContextModeDatabase,
	type OpenContextModeDatabase,
} from "./context-mode-db.ts";

const openNodeDatabase: OpenContextModeDatabase = async (dbPath) => {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	return {
		all<T>(sql: string, ...params: unknown[]): T[] {
			return db.prepare(sql).all(...params) as T[];
		},
		get<T>(sql: string, ...params: unknown[]): T | undefined {
			return db.prepare(sql).get(...params) as T | undefined;
		},
		close(): void {
			db.close();
		},
	} satisfies ContextModeDatabase;
};

async function createContextModeDb(
	dbPath: string,
	rows: Array<{
		sessionId: string;
		projectDir: string;
		lastEventAt: string;
		savedBytes: number;
		usedBytes: number;
	}>,
): Promise<void> {
	await fs.mkdir(path.dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	try {
		db.exec(`
			create table session_meta (
				session_id text primary key,
				project_dir text not null,
				last_event_at text
			);
			create table session_events (
				session_id text not null,
				bytes_avoided integer not null,
				bytes_returned integer not null
			);
		`);
		const insertMeta = db.prepare(
			"insert into session_meta (session_id, project_dir, last_event_at) values (?, ?, ?)",
		);
		const insertEvent = db.prepare(
			"insert into session_events (session_id, bytes_avoided, bytes_returned) values (?, ?, ?)",
		);
		for (const row of rows) {
			insertMeta.run(row.sessionId, row.projectDir, row.lastEventAt);
			insertEvent.run(row.sessionId, row.savedBytes, row.usedBytes);
		}
	} finally {
		db.close();
	}
}

test("collectContextModeSavings aggregates real databases and skips unreadable files", async (t) => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-savings-db-"));
	t.after(() => fs.rm(home, { recursive: true, force: true }));
	const sessionsDir = path.join(home, ".pi", "context-mode", "sessions");

	await createContextModeDb(path.join(sessionsDir, "valid.db"), [
		{
			sessionId: "current",
			projectDir: "/repo/app",
			lastEventAt: "2026-07-30 10:00:00",
			savedBytes: 84_000,
			usedBytes: 16_000,
		},
		{
			sessionId: "older",
			projectDir: "/repo/app/",
			lastEventAt: "2026-07-29 10:00:00",
			savedBytes: 40_000,
			usedBytes: 8_000,
		},
	]);
	await fs.writeFile(path.join(sessionsDir, "broken.db"), "not a sqlite database");

	const result = await collectContextModeSavings(
		{ cwd: "/repo/app", sessionId: "current", homeDir: home },
		openNodeDatabase,
	);

	assert.deepEqual(result, {
		sessionRaw: { savedBytes: 84_000, usedBytes: 16_000 },
		worktreeRaw: { savedBytes: 124_000, usedBytes: 24_000 },
		inferredSession: false,
		skippedDbs: 1,
		matchedSessions: 2,
	});
});

test("collectContextModeSavings treats an absent database directory as no data", async (t) => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-savings-empty-"));
	t.after(() => fs.rm(home, { recursive: true, force: true }));

	const result = await collectContextModeSavings(
		{ cwd: "/repo/app", sessionId: null, homeDir: home },
		openNodeDatabase,
	);

	assert.deepEqual(result, {
		sessionRaw: null,
		worktreeRaw: null,
		inferredSession: false,
		skippedDbs: 0,
		matchedSessions: 0,
	});
});
```

- [ ] **Step 2: Run the collector tests and verify RED**

Run:

```sh
node --test --experimental-strip-types extensions/ctx-savings/context-mode-db.test.ts
```

Expected: FAIL because `./context-mode-db.ts` does not exist.

- [ ] **Step 3: Implement the database contract and successful/no-data collection**

Create `extensions/ctx-savings/context-mode-db.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	aggregateSessionRows,
	type CollectContextModeSavingsOptions,
	type ContextModeSavings,
	type SessionSavingsRow,
} from "./core.ts";

export interface ContextModeDatabase {
	all<T>(sql: string, ...params: unknown[]): T[];
	get<T>(sql: string, ...params: unknown[]): T | undefined;
	close(): void;
}

export type OpenContextModeDatabase = (dbPath: string) => Promise<ContextModeDatabase>;

export class ContextModeDatabaseUnavailableError extends Error {
	override name = "ContextModeDatabaseUnavailableError";
}

const META_QUERY =
	"select session_id as sessionId, project_dir as projectDir, last_event_at as lastEventAt from session_meta";
const BYTES_QUERY =
	"select coalesce(sum(bytes_avoided), 0) as savedBytes, coalesce(sum(bytes_returned), 0) as usedBytes from session_events where session_id = ?";

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

function readRowsFromDb(db: ContextModeDatabase): SessionSavingsRow[] {
	const metaRows = db.all<{
		sessionId: string;
		projectDir: string;
		lastEventAt: string | null;
	}>(META_QUERY);

	return metaRows.map((row) => {
		const bytes = db.get<{ savedBytes?: number; usedBytes?: number }>(BYTES_QUERY, row.sessionId);
		return {
			sessionId: row.sessionId,
			projectDir: row.projectDir,
			lastEventAt: row.lastEventAt,
			savedBytes: Number(bytes?.savedBytes ?? 0),
			usedBytes: Number(bytes?.usedBytes ?? 0),
		};
	});
}

export async function collectContextModeSavings(
	options: CollectContextModeSavingsOptions,
	openDatabase: OpenContextModeDatabase,
): Promise<ContextModeSavings> {
	const homeDir = options.homeDir ?? os.homedir();
	const dbPaths = listContextModeDbs(homeDir);
	const rows: SessionSavingsRow[] = [];
	let skippedDbs = 0;

	for (const dbPath of dbPaths) {
		let db: ContextModeDatabase | null = null;
		try {
			db = await openDatabase(dbPath);
			rows.push(...readRowsFromDb(db));
		} catch {
			skippedDbs += 1;
		} finally {
			try {
				db?.close();
			} catch {
				// A failed close must not hide savings read from other databases.
			}
		}
	}

	return {
		...aggregateSessionRows(rows, options.cwd, options.sessionId),
		skippedDbs,
	};
}
```

- [ ] **Step 4: Run the collector tests and verify GREEN**

Run:

```sh
node --test --experimental-strip-types extensions/ctx-savings/context-mode-db.test.ts
```

Expected: PASS, 2 tests and 0 failures.

- [ ] **Step 5: Add the all-databases-unreadable regression test**

Add this import to `extensions/ctx-savings/context-mode-db.test.ts`:

```ts
import {
	collectContextModeSavings,
	type ContextModeDatabase,
	ContextModeDatabaseUnavailableError,
	type OpenContextModeDatabase,
} from "./context-mode-db.ts";
```

Append:

```ts
test("collectContextModeSavings reports unavailable when every database is unreadable", async (t) => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-savings-unavailable-"));
	t.after(() => fs.rm(home, { recursive: true, force: true }));
	const sessionsDir = path.join(home, ".pi", "context-mode", "sessions");
	await fs.mkdir(sessionsDir, { recursive: true });
	await fs.writeFile(path.join(sessionsDir, "broken.db"), "not a sqlite database");

	await assert.rejects(
		() =>
			collectContextModeSavings(
				{ cwd: "/repo/app", sessionId: null, homeDir: home },
				openNodeDatabase,
			),
		ContextModeDatabaseUnavailableError,
	);
});
```

- [ ] **Step 6: Run the new regression test and verify RED**

Run:

```sh
node --test --experimental-strip-types extensions/ctx-savings/context-mode-db.test.ts
```

Expected: FAIL with `Missing expected rejection` because the collector currently returns no data after every database fails.

- [ ] **Step 7: Implement systemic unavailability detection**

In `collectContextModeSavings()`, add `queriedDbs` and increment it only after `readRowsFromDb()` succeeds:

```ts
	const rows: SessionSavingsRow[] = [];
	let queriedDbs = 0;
	let skippedDbs = 0;

	for (const dbPath of dbPaths) {
		let db: ContextModeDatabase | null = null;
		try {
			db = await openDatabase(dbPath);
			rows.push(...readRowsFromDb(db));
			queriedDbs += 1;
		} catch {
			skippedDbs += 1;
		} finally {
			try {
				db?.close();
			} catch {
				// A failed close must not hide savings read from other databases.
			}
		}
	}

	if (dbPaths.length > 0 && queriedDbs === 0) {
		throw new ContextModeDatabaseUnavailableError("SQLite could not be initialized.");
	}
```

Keep the existing aggregated return immediately after this block.

- [ ] **Step 8: Run Task 1 tests and verify GREEN**

Run:

```sh
node --test --experimental-strip-types \
  extensions/ctx-savings/core.test.ts \
  extensions/ctx-savings/context-mode-db.test.ts
```

Expected: PASS, 26 tests and 0 failures.

- [ ] **Step 9: Commit the collector boundary**

```sh
git add extensions/ctx-savings/context-mode-db.ts extensions/ctx-savings/context-mode-db.test.ts
git commit -m "refactor(ctx-savings): add database collector boundary"
```

---

### Task 2: Add the Bun SQLite adapter

**Files:**
- Create: `extensions/ctx-savings/bun-sqlite.ts`
- Create: `extensions/ctx-savings/bun-sqlite.test.ts`

**Interfaces:**
- Consumes: `ContextModeDatabase` and `OpenContextModeDatabase` from `context-mode-db.ts`.
- Produces:
  - `createBunSqliteOpener(importBunSqlite): OpenContextModeDatabase`
  - `openBunSqliteDatabase: OpenContextModeDatabase`

- [ ] **Step 1: Write the Bun adapter regression test**

Create `extensions/ctx-savings/bun-sqlite.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";

import { createBunSqliteOpener } from "./bun-sqlite.ts";


test("createBunSqliteOpener maps Bun query APIs and opens read-only", async () => {
	const constructed: Array<{ filename: string; options: unknown }> = [];
	const queries: Array<{ method: "all" | "get"; sql: string; params: unknown[] }> = [];
	const closeArgs: boolean[] = [];
	let importCalls = 0;

	class FakeDatabase {
		constructor(filename: string, options: unknown) {
			constructed.push({ filename, options });
		}

		query(sql: string) {
			return {
				all: (...params: unknown[]) => {
					queries.push({ method: "all", sql, params });
					return [{ value: "all-result" }];
				},
				get: (...params: unknown[]) => {
					queries.push({ method: "get", sql, params });
					return { value: "get-result" };
				},
			};
		}

		close(throwOnError = false): void {
			closeArgs.push(throwOnError);
		}
	}

	const openDatabase = createBunSqliteOpener(async () => {
		importCalls += 1;
		return { Database: FakeDatabase };
	});

	const first = await openDatabase("/tmp/first.db");
	assert.deepEqual(first.all<{ value: string }>("select value from demo where id = ?", 1), [
		{ value: "all-result" },
	]);
	assert.deepEqual(first.get<{ value: string }>("select value from demo where id = ?", 2), {
		value: "get-result",
	});
	first.close();
	await openDatabase("/tmp/second.db");

	assert.equal(importCalls, 1);
	assert.deepEqual(constructed, [
		{ filename: "/tmp/first.db", options: { readonly: true, create: false } },
		{ filename: "/tmp/second.db", options: { readonly: true, create: false } },
	]);
	assert.deepEqual(queries, [
		{ method: "all", sql: "select value from demo where id = ?", params: [1] },
		{ method: "get", sql: "select value from demo where id = ?", params: [2] },
	]);
	assert.deepEqual(closeArgs, [false]);
});
```

- [ ] **Step 2: Run the Bun adapter test and verify RED**

Run:

```sh
node --test --experimental-strip-types extensions/ctx-savings/bun-sqlite.test.ts
```

Expected: FAIL because `./bun-sqlite.ts` does not exist.

- [ ] **Step 3: Implement the Bun adapter with an injectable importer**

Create `extensions/ctx-savings/bun-sqlite.ts`:

```ts
import type {
	ContextModeDatabase,
	OpenContextModeDatabase,
} from "./context-mode-db.ts";

interface BunStatement {
	all(...params: unknown[]): unknown[];
	get(...params: unknown[]): unknown;
}

interface BunDatabaseInstance {
	query(sql: string): BunStatement;
	close(throwOnError?: boolean): void;
}

interface BunDatabaseConstructor {
	new (
		filename: string,
		options: { readonly: boolean; create: boolean },
	): BunDatabaseInstance;
}

export type BunSqliteModule = {
	Database: BunDatabaseConstructor;
};

export function createBunSqliteOpener(
	importBunSqlite: () => Promise<BunSqliteModule>,
): OpenContextModeDatabase {
	let modulePromise: Promise<BunSqliteModule> | null = null;

	return async (dbPath: string): Promise<ContextModeDatabase> => {
		modulePromise ??= importBunSqlite();
		const { Database } = await modulePromise;
		const db = new Database(dbPath, { readonly: true, create: false });

		return {
			all<T>(sql: string, ...params: unknown[]): T[] {
				return db.query(sql).all(...params) as T[];
			},
			get<T>(sql: string, ...params: unknown[]): T | undefined {
				return db.query(sql).get(...params) as T | undefined;
			},
			close(): void {
				db.close(false);
			},
		};
	};
}

export const openBunSqliteDatabase = createBunSqliteOpener(
	() => import("bun:sqlite") as Promise<BunSqliteModule>,
);
```

- [ ] **Step 4: Run Task 2 tests and verify GREEN**

Run:

```sh
node --test --experimental-strip-types \
  extensions/ctx-savings/context-mode-db.test.ts \
  extensions/ctx-savings/bun-sqlite.test.ts
```

Expected: PASS, 4 tests and 0 failures.

- [ ] **Step 5: Verify the modules import under Node without resolving `bun:sqlite`**

Run:

```sh
node --experimental-strip-types --input-type=module <<'NODE'
await import("./extensions/ctx-savings/context-mode-db.ts");
await import("./extensions/ctx-savings/bun-sqlite.ts");
console.log("ctx-savings database adapters import under Node");
NODE
```

Expected: prints `ctx-savings database adapters import under Node` and exits 0. The dynamic `bun:sqlite` import must remain unevaluated until the production opener is called.

- [ ] **Step 6: Commit the Bun adapter**

```sh
git add extensions/ctx-savings/bun-sqlite.ts extensions/ctx-savings/bun-sqlite.test.ts
git commit -m "feat(ctx-savings): add Bun SQLite adapter"
```

---

### Task 3: Wire Bun SQLite into the Pi extension and expose failures

**Files:**
- Create: `extensions/ctx-savings/index.test.ts`
- Modify: `extensions/ctx-savings/index.ts`
- Modify: `extensions/ctx-savings/core.ts:1-280`

**Interfaces:**
- Consumes:
  - `collectContextModeSavings(options, openDatabase)` from `context-mode-db.ts`
  - `openBunSqliteDatabase` from `bun-sqlite.ts`
  - `ContextModeDatabaseUnavailableError` from `context-mode-db.ts`
- Produces:
  - `SavingsReport`
  - `SavingsReportBuilder`
  - `registerCtxSavings(pi, reportBuilder?)` as the default extension export
  - Runtime status `ctx: unavailable` and exact unavailable command text

- [ ] **Step 1: Write the failing lifecycle unavailable-status test**

Create `extensions/ctx-savings/index.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";

import { ContextModeDatabaseUnavailableError } from "./context-mode-db.ts";
import registerCtxSavings from "./index.ts";

function createHarness() {
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const hooks = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
	const messages: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, command);
		},
		on(name: string, handler: (event: unknown, ctx: any) => Promise<void>) {
			hooks.set(name, handler);
		},
		sendMessage(message: unknown, options: unknown) {
			messages.push({ message, options });
		},
	};
	return { commands, hooks, messages, pi };
}

function createContext() {
	const statusCalls: Array<[string, string | undefined]> = [];
	return {
		ctx: {
			hasUI: true,
			cwd: "/repo/app",
			sessionManager: {
				getSessionFile: () => "/tmp/pi-session.jsonl",
				getEntries: () => [],
			},
			ui: {
				setStatus(key: string, value: string | undefined) {
					statusCalls.push([key, value]);
				},
			},
		},
		statusCalls,
	};
}

const unavailableBuilder = async () => {
	throw new ContextModeDatabaseUnavailableError("SQLite could not be initialized.");
};

test("session refresh shows ctx unavailable when SQLite cannot initialize", async () => {
	const harness = createHarness();
	const { ctx, statusCalls } = createContext();
	registerCtxSavings(harness.pi as any, unavailableBuilder);

	await harness.hooks.get("session_start")?.({}, ctx);

	assert.deepEqual(statusCalls, [["ctx-savings", "ctx: unavailable"]]);
});
```

- [ ] **Step 2: Run the lifecycle test and verify RED**

Run:

```sh
node --test --experimental-strip-types extensions/ctx-savings/index.test.ts
```

Expected: FAIL because the current extension ignores the injected builder and clears the status instead of rendering `ctx: unavailable`.

- [ ] **Step 3: Add report-builder injection and unavailable refresh behavior**

Replace `extensions/ctx-savings/index.ts` with this intermediate implementation. It deliberately leaves command failure propagation unchanged for the next red-green cycle:

```ts
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { ContextModeDatabaseUnavailableError } from "./context-mode-db.ts";
import {
	buildRenderedSavings,
	collectContextModeSavings,
	collectCurrentSessionUsage,
	collectWorktreeUsageFromJsonl,
	deriveContextModeSessionId,
} from "./core.ts";

export type SavingsReport = { text: string; status: string | null };
export type SavingsReportBuilder = (
	ctx: ExtensionCommandContext | ExtensionContext,
	options?: { includeWorktree?: boolean },
) => Promise<SavingsReport>;

export async function buildSavingsReport(
	ctx: ExtensionCommandContext | ExtensionContext,
	options: { includeWorktree?: boolean } = {},
): Promise<SavingsReport> {
	const sessionId = deriveContextModeSessionId(ctx);
	const contextMode = await collectContextModeSavings({ cwd: ctx.cwd, sessionId });
	const currentUsage = collectCurrentSessionUsage(ctx);
	const worktreeUsage = options.includeWorktree === false
		? { totalTokens: 0, totalCost: 0 }
		: await collectWorktreeUsageFromJsonl(ctx.cwd);
	return buildRenderedSavings({ contextMode, currentUsage, worktreeUsage });
}

async function refreshStatus(
	ctx: ExtensionContext,
	reportBuilder: SavingsReportBuilder,
): Promise<void> {
	if (!ctx.hasUI) return;
	try {
		const report = await reportBuilder(ctx, { includeWorktree: false });
		ctx.ui.setStatus("ctx-savings", report.status ?? undefined);
	} catch (error) {
		ctx.ui.setStatus(
			"ctx-savings",
			error instanceof ContextModeDatabaseUnavailableError ? "ctx: unavailable" : undefined,
		);
	}
}

export default function registerCtxSavings(
	pi: ExtensionAPI,
	reportBuilder: SavingsReportBuilder = buildSavingsReport,
) {
	pi.registerCommand("ctx-savings", {
		description: "Show context-mode token and projected cost savings for this worktree",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const report = await reportBuilder(ctx, { includeWorktree: true });
			if (ctx.hasUI) {
				ctx.ui.setStatus("ctx-savings", report.status ?? undefined);
			}
			pi.sendMessage(
				{ customType: "ctx-savings", content: report.text, display: true },
				{ triggerTurn: false },
			);
		},
	});

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		await refreshStatus(ctx, reportBuilder);
	});
	pi.on("session_switch", async (_event, ctx: ExtensionContext) => {
		await refreshStatus(ctx, reportBuilder);
	});
	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		await refreshStatus(ctx, reportBuilder);
	});
}
```

- [ ] **Step 4: Run the lifecycle test and verify GREEN**

Run:

```sh
node --test --experimental-strip-types extensions/ctx-savings/index.test.ts
```

Expected: PASS, 1 test and 0 failures.

- [ ] **Step 5: Add the failing unavailable-command test**

Append to `extensions/ctx-savings/index.test.ts`:

```ts
test("ctx-savings command reports SQLite unavailable without throwing", async () => {
	const harness = createHarness();
	const { ctx, statusCalls } = createContext();
	registerCtxSavings(harness.pi as any, unavailableBuilder);

	await harness.commands.get("ctx-savings")?.handler("", ctx);

	assert.deepEqual(statusCalls, [["ctx-savings", "ctx: unavailable"]]);
	assert.deepEqual(harness.messages, [
		{
			message: {
				customType: "ctx-savings",
				content: "ctx-savings unavailable: SQLite could not be initialized.",
				display: true,
			},
			options: { triggerTurn: false },
		},
	]);
});
```

- [ ] **Step 6: Run the command test and verify RED**

Run:

```sh
node --test --experimental-strip-types extensions/ctx-savings/index.test.ts
```

Expected: FAIL because the command handler currently propagates `ContextModeDatabaseUnavailableError`.

- [ ] **Step 7: Implement the exact unavailable command report**

Add this constant after the report-builder types in `extensions/ctx-savings/index.ts`:

```ts
const SQLITE_UNAVAILABLE_REPORT: SavingsReport = {
	text: "ctx-savings unavailable: SQLite could not be initialized.",
	status: "ctx: unavailable",
};
```

Replace the command handler with:

```ts
		handler: async (_args, ctx: ExtensionCommandContext) => {
			let report: SavingsReport;
			try {
				report = await reportBuilder(ctx, { includeWorktree: true });
			} catch (error) {
				if (!(error instanceof ContextModeDatabaseUnavailableError)) throw error;
				report = SQLITE_UNAVAILABLE_REPORT;
			}
			if (ctx.hasUI) {
				ctx.ui.setStatus("ctx-savings", report.status ?? undefined);
			}
			pi.sendMessage(
				{ customType: "ctx-savings", content: report.text, display: true },
				{ triggerTurn: false },
			);
		},
```

- [ ] **Step 8: Run the extension-shell tests and verify GREEN**

Run:

```sh
node --test --experimental-strip-types extensions/ctx-savings/index.test.ts
```

Expected: PASS, 2 tests and 0 failures.

- [ ] **Step 9: Reproduce the missing footer in a fresh Pi TUI before production wiring**

Run this from the task worktree:

```sh
real_home=$HOME
worktree=$(pwd -P)
tmp_home=$(mktemp -d)
capture=$(mktemp)
mkdir -p "$tmp_home/.pi/agent" "$tmp_home/.pi/context-mode/sessions"
ln -s "$real_home/.pi/agent/AGENTS.md" "$tmp_home/.pi/agent/AGENTS.md"
ln -s "$real_home/.pi/agent/settings.json" "$tmp_home/.pi/agent/settings.json"
ln -s "$real_home/.pi/agent/mcp.json" "$tmp_home/.pi/agent/mcp.json"
ln -s "$worktree/extensions" "$tmp_home/.pi/agent/extensions"
ln -s "$real_home/.pi/agent/agents" "$tmp_home/.pi/agent/agents"
ln -s "$real_home/.pi/agent/multi-model-planning-teams" "$tmp_home/.pi/agent/multi-model-planning-teams"
ln -s "$real_home/.pi/agent/skills" "$tmp_home/.pi/agent/skills"
ln -s "$real_home/.pi/agent/themes" "$tmp_home/.pi/agent/themes"
ln -s "$real_home/.pi/agent/node_modules" "$tmp_home/.pi/agent/node_modules"
HOME="$tmp_home" PROJECT_DIR="$worktree" node --input-type=module <<'NODE'
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
const db = new DatabaseSync(path.join(process.env.HOME, ".pi", "context-mode", "sessions", "fixture.db"));
db.exec(`
  create table session_meta (session_id text primary key, project_dir text not null, last_event_at text);
  create table session_events (session_id text not null, bytes_avoided integer not null, bytes_returned integer not null);
`);
db.prepare("insert into session_meta values (?, ?, ?)").run("fixture", process.env.PROJECT_DIR, "2026-07-30 12:00:00");
db.prepare("insert into session_events values (?, ?, ?)").run("fixture", 84_000, 16_000);
db.close();
NODE
set +e
sleep 15 | HOME="$tmp_home" PI_CONFIG_DIR="$tmp_home/.pi" timeout 10s script -q -c 'env COLUMNS=120 LINES=40 pi' "$capture" >/dev/null 2>&1
script_status=$?
set -e
if [ "$script_status" -ne 0 ] && [ "$script_status" -ne 124 ]; then
  echo "unexpected script exit: $script_status"
  rm -rf "$tmp_home" "$capture"
  exit 1
fi
CAPTURE="$capture" python3 - <<'PY'
import os, re
text = open(os.environ["CAPTURE"], "rb").read().decode("utf-8", "replace")
text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)
if re.search(r"ctx:\s+\d", text):
    raise SystemExit("unexpectedly found ctx-savings footer before Bun wiring")
print("RED: ctx-savings footer is absent before Bun wiring")
PY
rm -rf "$tmp_home" "$capture"
```

Expected: prints `RED: ctx-savings footer is absent before Bun wiring`.

- [ ] **Step 10: Wire the collector and remove `better-sqlite3` production code**

In `extensions/ctx-savings/core.ts`, remove:

```ts
import { createRequire } from "node:module";
```

Delete the complete production database block beginning with:

```ts
type DatabaseCtor = new (filename: string, options?: { readonly?: boolean; fileMustExist?: boolean }) => any;
```

and ending with the closing brace of:

```ts
export async function collectContextModeSavings(options: CollectContextModeSavingsOptions): Promise<ContextModeSavings>
```

Keep `RawSavings`, `SessionSavingsRow`, `ContextModeSavings`, `CollectContextModeSavingsOptions`, `normalizeProjectPath()`, and `aggregateSessionRows()` in `core.ts` because they are runtime-independent domain types and logic.

Replace `extensions/ctx-savings/index.ts` with the final implementation:

```ts
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { openBunSqliteDatabase } from "./bun-sqlite.ts";
import {
	collectContextModeSavings,
	ContextModeDatabaseUnavailableError,
} from "./context-mode-db.ts";
import {
	buildRenderedSavings,
	collectCurrentSessionUsage,
	collectWorktreeUsageFromJsonl,
	deriveContextModeSessionId,
} from "./core.ts";

export type SavingsReport = { text: string; status: string | null };
export type SavingsReportBuilder = (
	ctx: ExtensionCommandContext | ExtensionContext,
	options?: { includeWorktree?: boolean },
) => Promise<SavingsReport>;

const SQLITE_UNAVAILABLE_REPORT: SavingsReport = {
	text: "ctx-savings unavailable: SQLite could not be initialized.",
	status: "ctx: unavailable",
};

export async function buildSavingsReport(
	ctx: ExtensionCommandContext | ExtensionContext,
	options: { includeWorktree?: boolean } = {},
): Promise<SavingsReport> {
	const sessionId = deriveContextModeSessionId(ctx);
	const contextMode = await collectContextModeSavings(
		{ cwd: ctx.cwd, sessionId },
		openBunSqliteDatabase,
	);
	const currentUsage = collectCurrentSessionUsage(ctx);
	const worktreeUsage = options.includeWorktree === false
		? { totalTokens: 0, totalCost: 0 }
		: await collectWorktreeUsageFromJsonl(ctx.cwd);
	return buildRenderedSavings({ contextMode, currentUsage, worktreeUsage });
}

async function refreshStatus(
	ctx: ExtensionContext,
	reportBuilder: SavingsReportBuilder,
): Promise<void> {
	if (!ctx.hasUI) return;
	try {
		const report = await reportBuilder(ctx, { includeWorktree: false });
		ctx.ui.setStatus("ctx-savings", report.status ?? undefined);
	} catch (error) {
		ctx.ui.setStatus(
			"ctx-savings",
			error instanceof ContextModeDatabaseUnavailableError ? "ctx: unavailable" : undefined,
		);
	}
}

export default function registerCtxSavings(
	pi: ExtensionAPI,
	reportBuilder: SavingsReportBuilder = buildSavingsReport,
) {
	pi.registerCommand("ctx-savings", {
		description: "Show context-mode token and projected cost savings for this worktree",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			let report: SavingsReport;
			try {
				report = await reportBuilder(ctx, { includeWorktree: true });
			} catch (error) {
				if (!(error instanceof ContextModeDatabaseUnavailableError)) throw error;
				report = SQLITE_UNAVAILABLE_REPORT;
			}
			if (ctx.hasUI) {
				ctx.ui.setStatus("ctx-savings", report.status ?? undefined);
			}
			pi.sendMessage(
				{ customType: "ctx-savings", content: report.text, display: true },
				{ triggerTurn: false },
			);
		},
	});

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		await refreshStatus(ctx, reportBuilder);
	});
	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		await refreshStatus(ctx, reportBuilder);
	});
}
```

- [ ] **Step 11: Run focused tests and verify GREEN**

Run:

```sh
node --test --experimental-strip-types \
  extensions/ctx-savings/core.test.ts \
  extensions/ctx-savings/context-mode-db.test.ts \
  extensions/ctx-savings/bun-sqlite.test.ts \
  extensions/ctx-savings/index.test.ts
```

Expected: PASS, 29 tests and 0 failures.

- [ ] **Step 12: Verify the footer appears in a fresh Pi TUI**

Run this from the task worktree:

```sh
real_home=$HOME
worktree=$(pwd -P)
tmp_home=$(mktemp -d)
capture=$(mktemp)
mkdir -p "$tmp_home/.pi/agent" "$tmp_home/.pi/context-mode/sessions"
ln -s "$real_home/.pi/agent/AGENTS.md" "$tmp_home/.pi/agent/AGENTS.md"
ln -s "$real_home/.pi/agent/settings.json" "$tmp_home/.pi/agent/settings.json"
ln -s "$real_home/.pi/agent/mcp.json" "$tmp_home/.pi/agent/mcp.json"
ln -s "$worktree/extensions" "$tmp_home/.pi/agent/extensions"
ln -s "$real_home/.pi/agent/agents" "$tmp_home/.pi/agent/agents"
ln -s "$real_home/.pi/agent/multi-model-planning-teams" "$tmp_home/.pi/agent/multi-model-planning-teams"
ln -s "$real_home/.pi/agent/skills" "$tmp_home/.pi/agent/skills"
ln -s "$real_home/.pi/agent/themes" "$tmp_home/.pi/agent/themes"
ln -s "$real_home/.pi/agent/node_modules" "$tmp_home/.pi/agent/node_modules"
HOME="$tmp_home" PROJECT_DIR="$worktree" node --input-type=module <<'NODE'
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
const db = new DatabaseSync(path.join(process.env.HOME, ".pi", "context-mode", "sessions", "fixture.db"));
db.exec(`
  create table session_meta (session_id text primary key, project_dir text not null, last_event_at text);
  create table session_events (session_id text not null, bytes_avoided integer not null, bytes_returned integer not null);
`);
db.prepare("insert into session_meta values (?, ?, ?)").run("fixture", process.env.PROJECT_DIR, "2026-07-30 12:00:00");
db.prepare("insert into session_events values (?, ?, ?)").run("fixture", 84_000, 16_000);
db.close();
NODE
set +e
sleep 15 | HOME="$tmp_home" PI_CONFIG_DIR="$tmp_home/.pi" timeout 10s script -q -c 'env COLUMNS=120 LINES=40 pi' "$capture" >/dev/null 2>&1
script_status=$?
set -e
if [ "$script_status" -ne 0 ] && [ "$script_status" -ne 124 ]; then
  echo "unexpected script exit: $script_status"
  rm -rf "$tmp_home" "$capture"
  exit 1
fi
CAPTURE="$capture" python3 - <<'PY'
import os, re
text = open(os.environ["CAPTURE"], "rb").read().decode("utf-8", "replace")
text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)
match = re.search(r"ctx:\s+\d[^\r\n]*", text)
if not match:
    raise SystemExit("ctx-savings footer not found")
print(match.group(0))
PY
rm -rf "$tmp_home" "$capture"
```

Expected: prints a footer beginning with `ctx:` and exits 0.

- [ ] **Step 13: Commit the production fix**

```sh
git add \
  extensions/ctx-savings/core.ts \
  extensions/ctx-savings/index.ts \
  extensions/ctx-savings/index.test.ts
git commit -m "fix(ctx-savings): restore Bun footer status"
```

---

### Task 4: Complete package and runtime verification

**Files:**
- Verify only; modify implementation files only if a verification command exposes a specific defect.

**Interfaces:**
- Consumes: the complete ctx-savings implementation from Tasks 1-3.
- Produces: fresh evidence for focused behavior, extension loading, full flake integrity, and the original footer symptom.

- [ ] **Step 1: Run all focused and nearby extension tests**

Run:

```sh
node --test --experimental-strip-types \
  extensions/ctx-savings/core.test.ts \
  extensions/ctx-savings/context-mode-db.test.ts \
  extensions/ctx-savings/bun-sqlite.test.ts \
  extensions/ctx-savings/index.test.ts \
  extensions/review/review-profile.test.ts \
  extensions/review/review-compare.test.ts \
  extensions/answer/answer-parser.test.ts
```

Expected: PASS, 50 tests and 0 failures.

- [ ] **Step 2: Run syntax and lazy-import checks**

Run:

```sh
node --experimental-strip-types --input-type=module <<'NODE'
await import("./extensions/ctx-savings/core.ts");
await import("./extensions/ctx-savings/context-mode-db.ts");
await import("./extensions/ctx-savings/bun-sqlite.ts");
await import("./extensions/ctx-savings/index.ts");
console.log("ctx-savings extension imports ok");
NODE
```

Expected: prints `ctx-savings extension imports ok` and exits 0.

- [ ] **Step 3: Verify production code contains no old driver path**

Run:

```sh
if rg -n 'better-sqlite3|createRequire' extensions/ctx-savings --glob '!*.test.ts'; then
  echo "old SQLite driver path remains"
  exit 1
fi
echo "no better-sqlite3 production path"
```

Expected: prints `no better-sqlite3 production path` and exits 0.

- [ ] **Step 4: Run the required Pi runtime extension-load check**

Run:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: exits 0 with no `Failed to load extension`, `No such built-in module`, or missing-package error.

- [ ] **Step 5: Run the full flake check**

Run:

```sh
nix flake check --accept-flake-config --print-build-logs
```

Expected: exits 0 with all checks passing.

- [ ] **Step 6: Repeat the fixture-backed Pi TUI proof**

Run this from the task worktree:

```sh
real_home=$HOME
worktree=$(pwd -P)
tmp_home=$(mktemp -d)
capture=$(mktemp)
mkdir -p "$tmp_home/.pi/agent" "$tmp_home/.pi/context-mode/sessions"
ln -s "$real_home/.pi/agent/AGENTS.md" "$tmp_home/.pi/agent/AGENTS.md"
ln -s "$real_home/.pi/agent/settings.json" "$tmp_home/.pi/agent/settings.json"
ln -s "$real_home/.pi/agent/mcp.json" "$tmp_home/.pi/agent/mcp.json"
ln -s "$worktree/extensions" "$tmp_home/.pi/agent/extensions"
ln -s "$real_home/.pi/agent/agents" "$tmp_home/.pi/agent/agents"
ln -s "$real_home/.pi/agent/multi-model-planning-teams" "$tmp_home/.pi/agent/multi-model-planning-teams"
ln -s "$real_home/.pi/agent/skills" "$tmp_home/.pi/agent/skills"
ln -s "$real_home/.pi/agent/themes" "$tmp_home/.pi/agent/themes"
ln -s "$real_home/.pi/agent/node_modules" "$tmp_home/.pi/agent/node_modules"
HOME="$tmp_home" PROJECT_DIR="$worktree" node --input-type=module <<'NODE'
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
const db = new DatabaseSync(path.join(process.env.HOME, ".pi", "context-mode", "sessions", "fixture.db"));
db.exec(`
  create table session_meta (session_id text primary key, project_dir text not null, last_event_at text);
  create table session_events (session_id text not null, bytes_avoided integer not null, bytes_returned integer not null);
`);
db.prepare("insert into session_meta values (?, ?, ?)").run("fixture", process.env.PROJECT_DIR, "2026-07-30 12:00:00");
db.prepare("insert into session_events values (?, ?, ?)").run("fixture", 84_000, 16_000);
db.close();
NODE
set +e
sleep 15 | HOME="$tmp_home" PI_CONFIG_DIR="$tmp_home/.pi" timeout 10s script -q -c 'env COLUMNS=120 LINES=40 pi' "$capture" >/dev/null 2>&1
script_status=$?
set -e
if [ "$script_status" -ne 0 ] && [ "$script_status" -ne 124 ]; then
  echo "unexpected script exit: $script_status"
  rm -rf "$tmp_home" "$capture"
  exit 1
fi
CAPTURE="$capture" python3 - <<'PY'
import os, re
text = open(os.environ["CAPTURE"], "rb").read().decode("utf-8", "replace")
text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)
match = re.search(r"ctx:\s+\d[^\r\n]*", text)
if not match:
    raise SystemExit("ctx-savings footer not found")
print(match.group(0))
PY
rm -rf "$tmp_home" "$capture"
```

Expected: prints a footer beginning with `ctx:` and exits 0.

- [ ] **Step 7: Inspect final branch state**

Run:

```sh
git status --short
git log --oneline --decorate -5
git diff main...HEAD --stat
```

Expected: clean status; commits for the approved spec, collector boundary, Bun adapter, and production fix; diff limited to ctx-savings implementation/tests plus the spec and this plan.
