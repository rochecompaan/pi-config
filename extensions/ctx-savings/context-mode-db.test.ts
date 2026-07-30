import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
	collectContextModeSavings,
	type ContextModeDatabase,
	ContextModeDatabaseUnavailableError,
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

test("collectContextModeSavings reports unavailable when the sessions path cannot be listed", async (t) => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-savings-list-error-"));
	t.after(() => fs.rm(home, { recursive: true, force: true }));
	const sessionsPath = path.join(home, ".pi", "context-mode", "sessions");
	await fs.mkdir(path.dirname(sessionsPath), { recursive: true });
	await fs.writeFile(sessionsPath, "not a directory");

	await assert.rejects(
		() =>
			collectContextModeSavings(
				{ cwd: "/repo/app", sessionId: null, homeDir: home },
				openNodeDatabase,
			),
		ContextModeDatabaseUnavailableError,
	);
});

test("project-scoped collection queries only canonical project databases", async (t) => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-savings-project-scope-"));
	t.after(() => fs.rm(home, { recursive: true, force: true }));
	const sessionsDir = path.join(home, ".pi", "context-mode", "sessions");
	const projectHash = createHash("sha256").update("/repo/app").digest("hex").slice(0, 16);

	await createContextModeDb(path.join(sessionsDir, `${projectHash}__deadbeef.db`), [
		{
			sessionId: "current",
			projectDir: "/repo/app",
			lastEventAt: "2026-07-30 10:00:00",
			savedBytes: 84_000,
			usedBytes: 16_000,
		},
	]);
	await createContextModeDb(path.join(sessionsDir, "0000000000000000.db"), [
		{
			sessionId: "legacy",
			projectDir: "/repo/app",
			lastEventAt: "2026-07-29 10:00:00",
			savedBytes: 40_000,
			usedBytes: 8_000,
		},
	]);

	const result = await collectContextModeSavings(
		{ cwd: "/repo/app", sessionId: "current", homeDir: home, databaseScope: "project" },
		openNodeDatabase,
	);

	assert.deepEqual(result, {
		sessionRaw: { savedBytes: 84_000, usedBytes: 16_000 },
		worktreeRaw: { savedBytes: 84_000, usedBytes: 16_000 },
		inferredSession: false,
		skippedDbs: 0,
		matchedSessions: 1,
	});
});

test("project-scoped collection falls back to legacy databases when no canonical file exists", async (t) => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-savings-project-legacy-"));
	t.after(() => fs.rm(home, { recursive: true, force: true }));
	const sessionsDir = path.join(home, ".pi", "context-mode", "sessions");

	await createContextModeDb(path.join(sessionsDir, "context-mode.db"), [
		{
			sessionId: "legacy",
			projectDir: "/repo/app",
			lastEventAt: "2026-07-29 10:00:00",
			savedBytes: 40_000,
			usedBytes: 8_000,
		},
	]);

	const result = await collectContextModeSavings(
		{ cwd: "/repo/app", sessionId: "legacy", homeDir: home, databaseScope: "project" },
		openNodeDatabase,
	);

	assert.deepEqual(result, {
		sessionRaw: { savedBytes: 40_000, usedBytes: 8_000 },
		worktreeRaw: { savedBytes: 40_000, usedBytes: 8_000 },
		inferredSession: false,
		skippedDbs: 0,
		matchedSessions: 1,
	});
});
