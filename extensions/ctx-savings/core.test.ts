import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
	aggregateSessionRows,
	buildRenderedSavings,
	bytesToTokens,
	collectCurrentSessionUsage,
	collectWorktreeUsageFromJsonl,
	deriveContextModeSessionId,
	extractCostTotal,
	extractTokensTotal,
	formatShortNumber,
	formatUsd,
	normalizeProjectPath,
	projectCostSavings,
	projectedCostForSummary,
	renderSavingsReport,
	renderSavingsStatus,
	summarizeBytes,
} from "./core.ts";

test("bytesToTokens approximates one token per four bytes", () => {
	assert.equal(bytesToTokens(0), 0);
	assert.equal(bytesToTokens(4), 1);
	assert.equal(bytesToTokens(42), 11);
	assert.equal(bytesToTokens(-100), 0);
});

test("formatShortNumber uses readable token units", () => {
	assert.equal(formatShortNumber(0), "0");
	assert.equal(formatShortNumber(999), "999");
	assert.equal(formatShortNumber(4_000), "4k");
	assert.equal(formatShortNumber(21_000), "21k");
	assert.equal(formatShortNumber(695_000), "695k");
	assert.equal(formatShortNumber(5_800_000), "5.8M");
});

test("formatUsd mirrors session-breakdown display precision", () => {
	assert.equal(formatUsd(null), null);
	assert.equal(formatUsd(Number.NaN), null);
	assert.equal(formatUsd(2), "$2.00");
	assert.equal(formatUsd(0.54), "$0.540");
	assert.equal(formatUsd(0.06), "$0.0600");
});

test("summarizeBytes reports used, without, saved, and reduction", () => {
	const summary = summarizeBytes(84_000, 16_000);
	assert.equal(summary.savedTokens, 21_000);
	assert.equal(summary.usedTokens, 4_000);
	assert.equal(summary.withoutTokens, 25_000);
	assert.equal(summary.reductionPercent, 84);
});

test("summarizeBytes handles zero totals", () => {
	const summary = summarizeBytes(0, 0);
	assert.equal(summary.savedTokens, 0);
	assert.equal(summary.usedTokens, 0);
	assert.equal(summary.withoutTokens, 0);
	assert.equal(summary.reductionPercent, 0);
});

test("projectCostSavings uses observed dollars per token", () => {
	assert.equal(projectCostSavings(21_000, 0.01, 4_000), 0.0525);
	assert.equal(projectCostSavings(21_000, 0, 4_000), null);
	assert.equal(projectCostSavings(21_000, 0.01, 0), null);
});

test("renderSavingsReport shows comparative command output with costs", () => {
	const report = renderSavingsReport({
		session: {
			label: "this session",
			summary: summarizeBytes(84_000, 16_000),
			projectedCost: 0.06,
			inferred: false,
		},
		worktree: {
			label: "this worktree",
			summary: summarizeBytes(720_000, 124_000),
			projectedCost: 0.54,
			inferred: false,
		},
		skippedDbs: 0,
	});

	assert.equal(
		report,
		"ctx saved ~21k tokens (~$0.0600) this session\n" +
			"4k used / 25k without · 84% reduction\n" +
			"\n" +
			"this worktree: ~180k saved (~$0.540)\n" +
			"31k used / 211k without · 85% reduction",
	);
});

test("renderSavingsReport omits costs when usage cost data is unavailable", () => {
	const report = renderSavingsReport({
		session: {
			label: "this session",
			summary: summarizeBytes(84_000, 16_000),
			projectedCost: null,
			inferred: false,
		},
		worktree: {
			label: "this worktree",
			summary: summarizeBytes(720_000, 124_000),
			projectedCost: null,
			inferred: false,
		},
		skippedDbs: 0,
	});

	assert.equal(
		report,
		"ctx saved ~21k tokens this session\n" +
			"4k used / 25k without · 84% reduction\n" +
			"\n" +
			"this worktree: ~180k saved\n" +
			"31k used / 211k without · 85% reduction",
	);
});

test("renderSavingsStatus is compact enough for Pi footer status", () => {
	const status = renderSavingsStatus({
		label: "this session",
		summary: summarizeBytes(84_000, 16_000),
		projectedCost: 0.06,
		inferred: false,
	});
	assert.equal(status, "ctx: 4k / 25k · saved 21k (~$0.0600) · 84%");
});

test("deriveContextModeSessionId matches context-mode Pi hashing", () => {
	const sessionFile = "/home/roche/.pi/agent/sessions/demo.jsonl";
	const expected = createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);
	const ctx = { sessionManager: { getSessionFile: () => sessionFile } };
	assert.equal(deriveContextModeSessionId(ctx), expected);
});

test("deriveContextModeSessionId returns null when Pi session file is unavailable", () => {
	assert.equal(deriveContextModeSessionId({}), null);
	assert.equal(deriveContextModeSessionId({ sessionManager: { getSessionFile: () => 42 } }), null);
});

test("normalizeProjectPath normalizes separators and trailing slashes", () => {
	assert.equal(normalizeProjectPath("/tmp/project///"), "/tmp/project");
	assert.equal(normalizeProjectPath("C:\\tmp\\project\\"), "C:/tmp/project");
});

test("aggregateSessionRows returns exact current session and worktree totals", () => {
	const rows = [
		{ sessionId: "current", projectDir: "/repo/app", lastEventAt: "2026-06-29 10:00:00", savedBytes: 84_000, usedBytes: 16_000 },
		{ sessionId: "older", projectDir: "/repo/app/", lastEventAt: "2026-06-28 10:00:00", savedBytes: 40_000, usedBytes: 8_000 },
		{ sessionId: "other", projectDir: "/repo/other", lastEventAt: "2026-06-29 11:00:00", savedBytes: 999_000, usedBytes: 999_000 },
	];

	const result = aggregateSessionRows(rows, "/repo/app", "current");
	assert.equal(result.sessionRaw?.savedBytes, 84_000);
	assert.equal(result.sessionRaw?.usedBytes, 16_000);
	assert.equal(result.worktreeRaw?.savedBytes, 124_000);
	assert.equal(result.worktreeRaw?.usedBytes, 24_000);
	assert.equal(result.matchedSessions, 2);
	assert.equal(result.inferredSession, false);
});

test("aggregateSessionRows infers current session from latest worktree row when needed", () => {
	const rows = [
		{ sessionId: "older", projectDir: "/repo/app", lastEventAt: "2026-06-28 10:00:00", savedBytes: 40_000, usedBytes: 8_000 },
		{ sessionId: "newer", projectDir: "/repo/app", lastEventAt: "2026-06-29 10:00:00", savedBytes: 84_000, usedBytes: 16_000 },
	];

	const result = aggregateSessionRows(rows, "/repo/app", null);
	assert.equal(result.sessionRaw?.savedBytes, 84_000);
	assert.equal(result.sessionRaw?.usedBytes, 16_000);
	assert.equal(result.inferredSession, true);
});

test("extractCostTotal accepts common Pi usage cost shapes", () => {
	assert.equal(extractCostTotal({ cost: 0.25 }), 0.25);
	assert.equal(extractCostTotal({ cost: "0.25" }), 0.25);
	assert.equal(extractCostTotal({ cost: { total: 0.25 } }), 0.25);
	assert.equal(extractCostTotal({ cost: { total: "0.25" } }), 0.25);
	assert.equal(extractCostTotal({}), 0);
});

test("extractTokensTotal accepts common Pi usage token shapes", () => {
	assert.equal(extractTokensTotal({ totalTokens: 12 }), 12);
	assert.equal(extractTokensTotal({ total_tokens: 13 }), 13);
	assert.equal(extractTokensTotal({ promptTokens: 10, completionTokens: 5 }), 15);
	assert.equal(extractTokensTotal({ inputTokens: 10, outputTokens: 5, cacheRead: 2, cacheWrite: 3 }), 20);
	assert.equal(extractTokensTotal({ tokens: { total: 17 } }), 17);
	assert.equal(extractTokensTotal({}), 0);
});

test("collectCurrentSessionUsage reads assistant message usage from Pi entries", () => {
	const ctx = {
		sessionManager: {
			getEntries: () => [
				{ type: "message", message: { role: "user", usage: { inputTokens: 999, cost: 9 } } },
				{ type: "message", message: { role: "assistant", usage: { inputTokens: 10, outputTokens: 5, cacheRead: 2, cacheWrite: 3, cost: { total: 0.01 } } } },
				{ type: "message", message: { role: "assistant", usage: { totalTokens: 8, cost: 0.02 } } },
			],
		},
	};

	assert.deepEqual(collectCurrentSessionUsage(ctx), { totalTokens: 28, totalCost: 0.03 });
});

test("projectedCostForSummary uses observed usage rate", () => {
	const summary = summarizeBytes(84_000, 16_000);
	assert.equal(projectedCostForSummary(summary, { totalTokens: 4_000, totalCost: 0.01 }), 0.0525);
	assert.equal(projectedCostForSummary(summary, { totalTokens: 0, totalCost: 0.01 }), null);
});

test("collectWorktreeUsageFromJsonl aggregates matching cwd sessions only", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-savings-"));
	const sessionsDir = path.join(home, ".pi", "agent", "sessions", "2026", "06");
	await fs.mkdir(sessionsDir, { recursive: true });

	await fs.writeFile(
		path.join(sessionsDir, "matching.jsonl"),
		[
			JSON.stringify({ type: "session_start", cwd: "/repo/app", timestamp: "2026-06-29T10:00:00Z" }),
			JSON.stringify({ type: "message", message: { role: "assistant", usage: { inputTokens: 10, outputTokens: 5, cost: 0.01 } } }),
			JSON.stringify({ type: "message", provider: "x", model: "y", usage: { totalTokens: 20, cost: { total: 0.02 } } }),
		].join("\n") + "\n",
	);
	await fs.writeFile(
		path.join(sessionsDir, "other.jsonl"),
		[
			JSON.stringify({ type: "session_start", cwd: "/repo/other", timestamp: "2026-06-29T10:00:00Z" }),
			JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 999, cost: 9 } } }),
		].join("\n") + "\n",
	);

	assert.deepEqual(await collectWorktreeUsageFromJsonl("/repo/app/", home), { totalTokens: 35, totalCost: 0.03 });
});

test("buildRenderedSavings combines DB savings and observed usage rates", () => {
	const rendered = buildRenderedSavings({
		contextMode: {
			sessionRaw: { savedBytes: 84_000, usedBytes: 16_000 },
			worktreeRaw: { savedBytes: 720_000, usedBytes: 124_000 },
			inferredSession: false,
			skippedDbs: 0,
			matchedSessions: 3,
		},
		currentUsage: { totalTokens: 4_000, totalCost: 0.01 },
		worktreeUsage: { totalTokens: 31_000, totalCost: 0.093 },
	});

	assert.equal(rendered.status, "ctx: 4k / 25k · saved 21k (~$0.0525) · 84%");
	assert.equal(
		rendered.text,
		"ctx saved ~21k tokens (~$0.0525) this session\n" +
			"4k used / 25k without · 84% reduction\n" +
			"\n" +
			"this worktree: ~180k saved (~$0.540)\n" +
			"31k used / 211k without · 85% reduction",
	);
});

test("collectWorktreeUsageFromJsonl accepts real Pi session headers", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-savings-session-"));
	const sessionsDir = path.join(home, ".pi", "agent", "sessions", "2026", "06");
	await fs.mkdir(sessionsDir, { recursive: true });

	await fs.writeFile(
		path.join(sessionsDir, "real-pi.jsonl"),
		[
			JSON.stringify({ type: "session", cwd: "/repo/app", timestamp: "2026-06-29T10:00:00Z" }),
			JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 20, cost: 0.02 } } }),
		].join("\n") + "\n",
	);

	assert.deepEqual(await collectWorktreeUsageFromJsonl("/repo/app", home), { totalTokens: 20, totalCost: 0.02 });
});

test("collectWorktreeUsageFromJsonl fails loudly on malformed JSONL", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-savings-bad-json-"));
	const sessionsDir = path.join(home, ".pi", "agent", "sessions", "2026", "06");
	await fs.mkdir(sessionsDir, { recursive: true });
	await fs.writeFile(path.join(sessionsDir, "bad.jsonl"), "{not-json}\n");

	await assert.rejects(
		() => collectWorktreeUsageFromJsonl("/repo/app", home),
		/Failed to parse Pi session JSONL/,
	);
});

test("collectWorktreeUsageFromJsonl ignores malformed lines after a non-matching session header", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-savings-other-bad-json-"));
	const sessionsDir = path.join(home, ".pi", "agent", "sessions", "2026", "06");
	await fs.mkdir(sessionsDir, { recursive: true });
	await fs.writeFile(
		path.join(sessionsDir, "other-bad.jsonl"),
		[
			JSON.stringify({ type: "session", cwd: "/repo/other", timestamp: "2026-06-29T10:00:00Z" }),
			"{not-json}",
		].join("\n") + "\n",
	);

	assert.deepEqual(await collectWorktreeUsageFromJsonl("/repo/app", home), { totalTokens: 0, totalCost: 0 });
});
