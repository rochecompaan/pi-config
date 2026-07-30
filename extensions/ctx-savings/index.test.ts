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
