# ctx-savings Bun SQLite design

## Status

Approved for implementation.

## Problem

The `ctx-savings` Pi extension stopped rendering its footer status even though Context Mode data is present and healthy.

The extension currently loads Context Mode's nested `better-sqlite3` dependency with `createRequire()`. The current Pi executable runs under Bun 1.3.13. Inside that runtime, package-relative resolution fails first for `better-sqlite3` and then for its transitive `bindings` package. `loadBetterSqlite3()` catches the failure and returns `null`; the collector reports no sessions; and `refreshStatus()` clears the `ctx-savings` status.

The same installed code succeeds under Node, finds matching Context Mode sessions, and renders a status. Existing Node tests therefore do not reproduce the production failure.

## Goal

Restore the `ctx-savings` footer and command inside the current Bun-based Pi runtime by reading Context Mode SQLite databases through Bun's native SQLite API.

## Non-goals

- Preserve `better-sqlite3` as a production fallback.
- Support non-Bun Pi runtimes in the production adapter.
- Change Context Mode's database schema or write to its databases.
- Change savings calculations, token approximations, projected pricing, or report wording except for explicit unavailable-state handling.
- Add an external `sqlite3` process dependency.
- Modify upstream Context Mode.

## Architecture

Use a domain adapter boundary between Context Mode database collection and savings calculations.

### `extensions/ctx-savings/core.ts`

Retain runtime-independent behavior:

- session ID derivation
- path normalization
- session/worktree row aggregation
- byte-to-token approximation
- projected cost calculation
- report and status rendering
- Pi session usage collection
- JSONL worktree usage collection

Remove Context Mode SQLite driver discovery and SQL execution. This reduces a module already above the project's 400-line split-pressure guideline and leaves it with one primary responsibility: savings calculation and presentation.

### `extensions/ctx-savings/context-mode-db.ts`

Own Context Mode database discovery and read-only query behavior.

Expose a narrow database contract:

```ts
interface ContextModeDatabase {
  all<T>(sql: string, ...params: unknown[]): T[];
  get<T>(sql: string, ...params: unknown[]): T | undefined;
  close(): void;
}

type OpenContextModeDatabase = (
  dbPath: string,
) => Promise<ContextModeDatabase>;
```

The collector accepts an opener through dependency injection, scans `~/.pi/context-mode/sessions/*.db`, reads `session_meta` and `session_events`, and passes normalized rows to `aggregateSessionRows()` from `core.ts`.

Database files remain read-only. A failure in one database increments `skippedDbs` and does not prevent usable databases from contributing.

### `extensions/ctx-savings/bun-sqlite.ts`

Implement `OpenContextModeDatabase` with a dynamic `import("bun:sqlite")`.

The adapter:

- caches the Bun module import
- opens each database read-only without creating missing files
- maps `Database.query(sql).all(...params)` and `.get(...params)` to the narrow database contract
- closes database handles deterministically
- does not use `createRequire()`, `better-sqlite3`, or package-path discovery

The importer is injectable so Node tests can verify adapter behavior with a fake Bun module without resolving `bun:sqlite`.

### `extensions/ctx-savings/index.ts`

Wire the Bun opener into `buildSavingsReport()` and preserve the existing command and lifecycle hooks.

The obsolete `session_switch` hook will be replaced by current Pi lifecycle behavior: `session_start` covers startup, reload, new, resume, and fork transitions; `turn_end` refreshes accumulated usage after each turn.

## Data flow

1. Pi emits `session_start` or `turn_end`.
2. `refreshStatus()` calls `buildSavingsReport()`.
3. `buildSavingsReport()` derives the current Context Mode session ID and invokes the Context Mode database collector with the Bun opener.
4. The collector scans matching database files read-only and produces `SessionSavingsRow` values.
5. `core.ts` aggregates current-session and worktree totals and renders the compact status.
6. The extension writes the result through `ctx.ui.setStatus("ctx-savings", ...)`.

The `/ctx-savings` command uses the same data path and additionally scans Pi JSONL sessions for worktree cost projection, as it does today.

## Failure handling

Three states are distinct:

1. **Data available:** render the normal `ctx: ...` status.
2. **No matching Context Mode data:** clear the status and retain the existing no-data command report.
3. **SQLite adapter or collection unavailable:** render `ctx: unavailable` instead of silently disappearing. The command returns `ctx-savings unavailable: SQLite could not be initialized.` rather than an unhandled stack trace.

Per-database read/schema failures remain best-effort and are represented by `skippedDbs`. Adapter initialization failure is unavailable. If database files exist but every file fails to open or query, collection is also unavailable. If no database files exist, the result is no data rather than unavailable.

## Testing strategy

### Automated regression tests

Follow red-green TDD.

1. Add a failing Bun adapter test with an injected fake `bun:sqlite` importer. Verify the adapter constructs a read-only database and executes queries through Bun's `query().all()` and `query().get()` APIs. This prevents reintroduction of `createRequire()` dependency resolution.
2. Add a database collector test using a real temporary SQLite fixture and a Node test adapter. Verify current-session/worktree aggregation, read-only query behavior, and skipped-database accounting against actual SQL tables.
3. Add extension-shell tests for unavailable-state status behavior where practical without restating implementation details.
4. Run all existing `ctx-savings` and nearby extension tests.

### Direct runtime verification

Automated Node tests cannot prove that Pi's embedded Bun runtime loads `bun:sqlite`. Run a fresh pseudo-TTY Pi session using the built package and assert that the rendered footer contains `ctx:` when matching Context Mode data exists.

Also run the required package checks:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

No new test will assert Nix configuration text or dependency versions; those are verified through builds and the runtime extension-load check.

## Acceptance criteria

- A fresh current Pi TUI renders a `ctx:` footer status when Context Mode contains matching worktree data.
- `/ctx-savings` still renders session and worktree savings.
- A systemic SQLite initialization failure displays `ctx: unavailable` rather than removing the status silently.
- Missing matching data still produces the existing no-data behavior.
- Context Mode databases are opened read-only and never created or modified.
- Production `ctx-savings` code no longer resolves or loads `better-sqlite3`.
- Existing savings calculations and report formatting remain unchanged.
- Focused tests, nearby extension tests, the Pi extension-load check, and the full flake check pass.
