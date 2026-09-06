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

const { registerSnipActions } = await import("./index.ts");
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
			assert.equal(name, "snip");
			command = definition.handler;
		},
	};
	registerSnipActions(pi as never, {
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
	assert.deepEqual(fixture.notifications, [["/snip requires interactive mode.", "warning"]]);
	assert.equal(fixture.pickCalls.length, 0);
});
