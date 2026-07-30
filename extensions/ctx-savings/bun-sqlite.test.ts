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
