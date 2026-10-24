import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import registerAutoNameSession from "./index.ts";

type Handler = (event: any, ctx: any) => unknown;

function response(text = "auto name session", stopReason = "stop") {
	return {
		role: "assistant", content: [{ type: "text", text }], stopReason,
		api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-luna",
		usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		timestamp: 1,
	};
}

function setup(initialName?: string, persisted: any[] = []) {
	let name = initialName;
	let session = "session-a";
	let leaf = "reply-1";
	const entries = [
		...persisted,
		{ id: "user-1", type: "message", message: { role: "user", content: "name sessions automatically" } },
		{ id: leaf, type: "message", message: response() },
	];
	const calls: Array<{ model: unknown; context: any; options: any }> = [];
	const names: string[] = [];
	const handlers = new Map<string, Handler[]>();
	let complete = async (_options: any): Promise<any> => response();
	const model = { provider: "openai-codex", id: "gpt-6-luna" };
	const ctx = {
		mode: "tui", hasUI: true,
		model: { provider: "other-provider", id: "expensive-chat-model" },
		sessionManager: {
			getSessionId: () => session, getLeafId: () => leaf,
			getEntries: () => entries, getBranch: () => entries,
		},
		modelRegistry: {
			find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
			complete: async (selected: unknown, context: any, options: any) => {
				calls.push({ model: selected, context, options });
				return complete(options);
			},
		},
		ui: { notify: () => assert.fail("naming should stay quiet") },
	};
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, [...handlers.get(event) ?? [], handler]),
		getSessionName: () => name,
		setSessionName: (value: string) => { name = value; names.push(value); },
		appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data } as any); },
	};
	registerAutoNameSession(pi as any);
	const emit = async (event: string, payload: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	return {
		ctx, pi, calls, names, entries, emit,
		get name() { return name; },
		setName: (value: string) => { name = value; },
		setSession: (value: string) => { session = value; },
		nextReply: () => { leaf = "reply-2"; },
		setComplete: (fn: (options: any) => Promise<any>) => { complete = fn; },
		finish: () => emit("agent_end", { messages: [response()] }),
	};
}

const flush = async () => { for (let i = 0; i < 5; i++) await setImmediate(); };

test("names after completed replies with the dedicated low-thinking model, never per tool turn", async () => {
	const h = setup();
	await h.emit("session_start");
	await h.emit("turn_end", { message: response() });
	assert.equal(h.calls.length, 0);
	await h.finish();
	await flush();
	assert.equal(h.name, "auto name session");
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.calls[0].model, { provider: "openai-codex", id: "gpt-6-luna" });
	assert.equal(h.calls[0].options.reasoningEffort, "low");
	assert.ok(h.calls[0].options.maxTokens <= 512);
	assert.deepEqual(h.calls[0].context.tools, []);
	assert.ok(h.calls[0].context.messages[0].content[0].text.length <= 4_000);
	assert.equal(h.ctx.model.id, "expensive-chat-model");
});

test("KEEP leaves the exact existing automatic name without another metadata write", async () => {
	const h = setup();
	await h.emit("session_start");
	await h.finish();
	await flush();
	const entryCount = h.entries.length;
	h.setComplete(async () => response("KEEP"));
	h.nextReply();
	await h.finish();
	await flush();
	assert.equal(h.calls.length, 2);
	assert.deepEqual(h.names, ["auto name session"]);
	assert.equal(h.entries.length, entryCount);
});

test("renames on a new topic and remembers ownership across extension reloads", async () => {
	const h = setup();
	await h.emit("session_start");
	await h.finish();
	await flush();
	const resumed = setup(h.name, h.entries.filter(e => e.type === "custom"));
	await resumed.emit("session_start");
	resumed.setComplete(async () => response("fix login bug"));
	await resumed.finish();
	await flush();
	assert.equal(resumed.name, "fix login bug");
	assert.equal(resumed.calls.length, 1);
});

test("does not call a model for an existing manual name or after a manual rename", async () => {
	const manual = setup("my hand-picked name");
	await manual.emit("session_start");
	await manual.finish();
	await flush();
	assert.equal(manual.calls.length, 0);
	const h = setup();
	await h.emit("session_start");
	await h.finish();
	await flush();
	h.setName("my custom name");
	await h.finish();
	await flush();
	assert.equal(h.calls.length, 1);
	assert.equal(h.name, "my custom name");
});

test("quietly keeps the name for unavailable models, errors, aborted replies, and invalid output", async () => {
	const unavailable = setup();
	unavailable.ctx.modelRegistry.find = () => undefined;
	await unavailable.emit("session_start");
	await unavailable.finish();
	assert.equal(unavailable.calls.length, 0);
	for (const result of [response("", "error"), response("", "aborted"), response("bad\noutput"), response("cut off", "length")]) {
		const h = setup();
		h.setComplete(async () => result);
		await h.emit("session_start");
		await h.finish();
		await flush();
		assert.equal(h.name, undefined);
	}
	const failing = setup();
	failing.setComplete(async () => { throw new Error("secret auth information"); });
	await failing.emit("session_start");
	await failing.finish();
	await flush();
	assert.equal(failing.name, undefined);
	const aborted = setup();
	await aborted.emit("session_start");
	await aborted.emit("agent_end", { messages: [response("", "aborted")] });
	assert.equal(aborted.calls.length, 0);
});

test("finishing a reply does not wait for the naming request", async () => {
	const h = setup();
	let resolve!: (value: any) => void;
	h.setComplete(() => new Promise(done => { resolve = done; }));
	await h.emit("session_start");
	await h.finish();
	await flush();
	assert.equal(h.calls.length, 1);
	assert.equal(h.name, undefined);
	resolve(response());
	await flush();
	assert.equal(h.name, "auto name session");
});

test("discards results after manual renames, session replacement, and branch changes", async () => {
	for (const change of ["manual", "session", "branch"]) {
		const h = setup();
		let resolve!: (value: any) => void;
		h.setComplete(() => new Promise(done => { resolve = done; }));
		await h.emit("session_start");
		await h.finish();
		await flush();
		assert.equal(h.calls.length, 1);
		if (change === "manual") h.setName("manual name");
		if (change === "session") h.setSession("session-b");
		if (change === "branch") h.nextReply();
		resolve(response());
		await flush();
		assert.deepEqual(h.names, []);
	}
});

test("cancels old work when a new prompt starts and serializes naming requests", async () => {
	const h = setup();
	let resolve!: (value: any) => void;
	h.setComplete(() => new Promise(done => { resolve = done; }));
	await h.emit("session_start");
	await h.finish();
	await flush();
	const firstSignal = h.calls[0].options.signal;
	await h.emit("before_agent_start");
	assert.equal(firstSignal.aborted, true);
	h.nextReply();
	await h.finish();
	await flush();
	assert.equal(h.calls.length, 1, "must not overlap a request that has not finished cancelling");
	h.setComplete(async () => response("fix login bug"));
	resolve(response("stale old topic"));
	await flush();
	assert.equal(h.calls.length, 2);
	assert.deepEqual(h.names, ["fix login bug"]);
	assert.notEqual(h.calls[0].options.sessionId, h.calls[1].options.sessionId);
});

test("cancels naming on shutdown", async () => {
	const h = setup();
	let resolve!: (value: any) => void;
	h.setComplete(() => new Promise(done => { resolve = done; }));
	await h.emit("session_start");
	await h.finish();
	await flush();
	await h.emit("session_shutdown");
	assert.equal(h.calls[0].options.signal.aborted, true);
	resolve(response());
	await flush();
	assert.deepEqual(h.names, []);
});

test("aborts a slow naming request after ten seconds and can check the next reply", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = setup();
	h.setComplete(({ signal }) => new Promise(done => {
		signal.addEventListener("abort", () => done(response("", "aborted")), { once: true });
	}));
	await h.emit("session_start");
	await h.finish();
	await flush();
	t.mock.timers.tick(10_000);
	await flush();
	assert.equal(h.calls[0].options.signal.aborted, true);
	assert.equal(h.name, undefined);
	h.setComplete(async () => response());
	h.nextReply();
	await h.finish();
	await flush();
	assert.equal(h.calls.length, 2);
	assert.equal(h.name, "auto name session");
});

test("awaits naming in non-interactive print mode so the session is saved before exit", async () => {
	const h = setup();
	h.ctx.mode = "print";
	await h.emit("session_start");
	await h.finish();
	assert.equal(h.name, "auto name session");
});
