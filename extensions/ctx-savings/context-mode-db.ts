import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	aggregateSessionRows,
	type CollectContextModeSavingsOptions,
	type ContextModeSavings,
	normalizeProjectPath,
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

function projectDatabasePrefix(projectDir: string): string {
	const normalized = normalizeProjectPath(projectDir);
	const canonical = process.platform === "darwin" || process.platform === "win32"
		? normalized.toLowerCase()
		: normalized;
	return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function listContextModeDbs(
	homeDir: string,
	projectDir: string,
	databaseScope: "all" | "project",
): string[] {
	const sessionsDir = path.join(homeDir, ".pi", "context-mode", "sessions");
	try {
		const dbPaths = fs
			.readdirSync(sessionsDir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".db"))
			.map((entry) => path.join(sessionsDir, entry.name));
		if (databaseScope === "all") return dbPaths;

		const prefix = projectDatabasePrefix(projectDir);
		const projectPaths = dbPaths.filter((dbPath) => {
			const filename = path.basename(dbPath);
			return filename === `${prefix}.db` || filename.startsWith(`${prefix}__`);
		});
		return projectPaths.length > 0 ? projectPaths : dbPaths;
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return [];
		throw new ContextModeDatabaseUnavailableError("SQLite could not be initialized.");
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
	const dbPaths = listContextModeDbs(
		homeDir,
		options.cwd,
		options.databaseScope ?? "all",
	);
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

	return {
		...aggregateSessionRows(rows, options.cwd, options.sessionId),
		skippedDbs,
	};
}
