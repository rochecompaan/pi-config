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
