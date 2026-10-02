import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { ContextUsageTracker } from "./context-usage.ts";

const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 });
const assistant = (content: string, usage?: object, stopReason = "stop") => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text: content }],
	timestamp: 0,
	usage,
	stopReason,
});
const result = (content: string) => ({
	role: "toolResult" as const,
	toolCallId: "call",
	toolName: "read",
	content: [{ type: "text" as const, text: content }],
	isError: false,
	timestamp: 0,
});
const tokens = (messages: readonly object[]) => messages.reduce((total, message) => total + estimateTokens(message as any), 0);

test("calibrates restored raw history from the selected request snapshot", () => {
	const tracker = new ContextUsageTracker();
	const old = user("old raw history ".repeat(500));
	const active = user("active request");
	const response = assistant("tool call", { totalTokens: 10_000 });
	const toolResult = result("new tool output");
	tracker.recordSelection([active] as any, 400);
	tracker.recordResponse(response as any);

	const current = [old, active, response, toolResult];
	const measured = 10_000 + tokens([toolResult]);
	const estimate = tracker.prepare(current as any, 400, measured);

	assert.equal(estimate, measured + tokens([old]));
	assert.equal(tracker.prepare(current as any, 400, measured), estimate, "repeated events do not rebase");
});

test("accepts cached successful usage and reconstructed duplicate messages", () => {
	const tracker = new ContextUsageTracker();
	const duplicate = user("duplicate");
	const active = user("duplicate");
	const response = assistant("answer", { input: 100, output: 20, cacheRead: 300, cacheWrite: 4 });
	tracker.recordSelection([active] as any, 25);
	tracker.recordResponse(structuredClone(response) as any);

	const current = [duplicate, structuredClone(active), structuredClone(response)];
	assert.equal(tracker.prepare(current as any, 25, 424), 424 + tokens([duplicate]));
});

test("falls back until a tracked successful response establishes an anchor", () => {
	const tracker = new ContextUsageTracker();
	const request = user("request");
	const aborted = assistant("aborted", { totalTokens: 400 }, "aborted");
	tracker.recordSelection([request] as any, 10);
	tracker.recordResponse(aborted as any);
	assert.equal(tracker.prepare([request, aborted] as any, 10, 400), undefined);
	assert.equal(tracker.prepare([request] as any, 10, Number.NaN), undefined);

	const response = assistant("answer", { totalTokens: 400 });
	tracker.recordSelection([request] as any, 10);
	tracker.recordResponse(response as any);
	assert.equal(tracker.prepare([request, response] as any, 10, 400), 400);
});

test("rejects a status total whose latest successful response is not the anchor", () => {
	const tracker = new ContextUsageTracker();
	const request = user("request");
	const response = assistant("answer", { totalTokens: 400 });
	tracker.recordSelection([request] as any, 10);
	tracker.recordResponse(response as any);
	const laterResponse = assistant("later answer", { totalTokens: 900 });

	assert.equal(tracker.prepare([request, response, laterResponse] as any, 10, 900), undefined);
});

test("clears pending and measured state for incompatible lifecycle changes", () => {
	const tracker = new ContextUsageTracker();
	const request = user("request");
	const response = assistant("answer", { totalTokens: 400 });
	tracker.recordSelection([request] as any, 10, [request] as any);
	tracker.recordResponse(response as any);
	tracker.clear();
	assert.equal(tracker.prepare([request, response] as any, 10, 400, [request, response] as any), undefined);
});

test("removes known outgoing-only instructions but not persistent anchor messages", () => {
	const tracker = new ContextUsageTracker();
	const actual = user("actual request");
	const injected = user("extension instruction");
	const response = assistant("answer", { totalTokens: 51 });
	const next = user("next request");
	tracker.recordSelection([actual, injected] as any, 0, [actual] as any);
	tracker.recordResponse(response as any);

	assert.equal(
		tracker.prepare([actual, response, next] as any, 0, 51 + tokens([next]), [actual, response, next] as any),
		51 + tokens([next]) - tokens([injected]),
	);
	assert.equal(
		tracker.prepare([response, next] as any, 0, 51, [response, next] as any),
		undefined,
		"a missing persistent request cannot be replaced by an outgoing instruction",
	);
});

test("keeps the persistent cursor after a leading outgoing paging notice", () => {
	const tracker = new ContextUsageTracker();
	const notice = user("Context paging notice");
	const actual = user("actual request");
	const response = assistant("answer", { totalTokens: 86 });
	const next = user("next request");
	tracker.recordSelection([notice, actual] as any, 0, [actual] as any);
	tracker.recordResponse(response as any);

	assert.equal(
		tracker.prepare([response, next] as any, 0, 86, [response, next] as any),
		undefined,
		"a missing persistent request cannot be hidden behind a leading paging notice",
	);
});

test("retains current outgoing-only additions outside Pi's persistent status total", () => {
	const tracker = new ContextUsageTracker();
	const actual = user("actual request");
	const oldInstruction = user("outgoing instruction");
	const response = assistant("answer", { totalTokens: 101 });
	const next = user("next request");
	const newInstruction = user("outgoing instruction");
	tracker.recordSelection([actual, oldInstruction] as any, 0, [actual] as any);
	tracker.recordResponse(response as any);

	assert.equal(
		tracker.prepare(
			[actual, response, next, newInstruction] as any,
			0,
			101 + tokens([next]),
			[actual, response, next] as any,
		),
		101 + tokens([next]),
		"the old and new outgoing instructions offset instead of cancelling the new instruction",
	);
});

test("subtracts the full persistent status suffix before resident changes, with or without outgoing system metadata", () => {
	for (const includeSystem of [false, true]) {
		const tracker = new ContextUsageTracker();
		const actual = user("ask");
		const response = assistant("answer", { totalTokens: 100 });
		const update = { role: "system", content: "s".repeat(24), toolsAdded: [{ name: "t" }] };
		const next = user("next");
		assert.equal(tokens([update]), 10);
		assert.equal(tokens([next]), 1);
		const oldSystem = { role: "system", content: "old resident prompt", toolsAdded: [] };
		const anchored = includeSystem ? [oldSystem, actual] : [actual];
		tracker.recordSelection(anchored as any, 20, [oldSystem, actual] as any);
		tracker.recordResponse(response as any);
		const persistent = [oldSystem, actual, response, update, next];
		const outgoing = includeSystem ? persistent : [actual, response, next];
		const status = 100 + tokens([update, next]);
		assert.equal(status, 111);
		assert.equal(tracker.prepare(outgoing as any, 30, status, persistent as any), 111,
			`resident update is counted once (outgoing system metadata: ${includeSystem})`);
	}
});

test("uses Pi's totalTokens choice before rejecting malformed usage", () => {
	for (const [label, usage, accepted] of [
		["negative", { totalTokens: -1, input: 50, output: 49, cacheRead: 0, cacheWrite: 0 }, false],
		["NaN", { totalTokens: Number.NaN, input: 50, output: 49, cacheRead: 0, cacheWrite: 0 }, true],
		["Infinity", { totalTokens: Number.POSITIVE_INFINITY, input: 50, output: 49, cacheRead: 0, cacheWrite: 0 }, false],
		["zero", { totalTokens: 0, input: 50, output: 49, cacheRead: 0, cacheWrite: 0 }, true],
		["absent", { input: 50, output: 49, cacheRead: 0, cacheWrite: 0 }, true],
	] as const) {
		const tracker = new ContextUsageTracker();
		const request = user(label);
		const response = assistant("answer", usage);
		tracker.recordSelection([request] as any, 0, [request] as any);
		tracker.recordResponse(response as any);
		assert.equal(tracker.prepare([request, response] as any, 0, 99, [request, response] as any), accepted ? 99 : undefined, label);
	}
});

test("does not repeatedly serialize a large selected message while matching raw history", () => {
	const tracker = new ContextUsageTracker();
	const selected = user("x".repeat(400_000));
	const response = assistant("answer", { totalTokens: 1_000 });
	const raw = Array.from({ length: 10_000 }, (_, index) => user(`raw-${index}`));
	tracker.recordSelection([selected] as any, 0, [selected] as any);
	tracker.recordResponse(response as any);
	const current = [...raw, selected, response];
	const started = performance.now();
	assert.ok(tracker.prepare(current as any, 0, 1_000, current as any) !== undefined);
	assert.ok(performance.now() - started < 1_500, "matching should cache the selected fingerprint");
});
