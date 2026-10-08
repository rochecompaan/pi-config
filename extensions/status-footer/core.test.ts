import test from "node:test";
import assert from "node:assert/strict";

import {
	buildFooterLines,
	extractSafeAccountLabel,
	parseWeeklyLimit,
} from "./core.ts";

function jwt(payload: Record<string, unknown>): string {
	const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `header.${encoded}.signature`;
}

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function terminalWidth(text: string): number {
	return [...text.replace(ANSI_ESCAPE, "")].reduce((width, character) =>
		width + (/^[\u2e80-\u9fff\uf900-\ufaff]$/u.test(character) ? 2 : 1), 0);
}

const nowMs = Date.UTC(2026, 8, 18, 9, 0, 0);
const resetAt = Math.floor((nowMs + ((6 * 24 + 21) * 60 * 60 * 1000)) / 1000);

function footerInput() {
	return {
		modelId: "gpt-5.4",
		thinkingLevel: "high",
		contextTokens: 132_000,
		contextWindow: 372_000,
		cost: 2.337,
		weeklyLimit: { usedPercent: 5, resetAt },
		gitBranch: "main",
		extensionStatuses: new Map<string, string>([
			["remote-pi:relay", "🟢 relay"],
			["voice", "MIC LOCAL"],
			["auth-scope", "\u001b[33mauth: LOCAL\u001b[0m"],
			["unrelated", "do not render"],
		]),
		accountLabel: null,
		nowMs,
	};
}

test("renders one bracketed line with dim middle dots and the git branch last", () => {
	assert.deepEqual(buildFooterLines(footerInput(), 160, terminalWidth), [
		"[gpt-5.4 · high] [ctx 35% · 132k/372k] [cache r/w · 0/0] [$2.337] [Week 95% rem · 6d21h] [● relay ○ voice ○ paging] [AUTH · LOCAL] [ main]",
	]);
});

test("shows whether context paging is on beside relay and voice", () => {
	const cases = [
		{ status: "paging on", part: "<connected>● paging</connected>" },
		{ status: "\u001b[32mpaging on\u001b[0m", part: "<connected>● paging</connected>" },
		{ status: "paging off", part: "<error>○ paging</error>" },
		{ status: undefined, part: "<error>○ paging</error>" },
	];
	for (const { status, part } of cases) {
		const input = footerInput();
		if (status !== undefined) input.extensionStatuses.set("context-paging", status);
		const [line] = buildFooterLines(
			input,
			240,
			terminalWidth,
			(tone, text) => `<${tone}>${text}</${tone}>`,
		);
		assert.ok(line.includes(`<error>○ voice</error><dim> </dim>${part}<dim>]</dim>`), line);
	}
});

test("shows compact cache read and write counts between context and cost", () => {
	const input = { ...footerInput(), cacheRead: 123_000, cacheWrite: 3_434_000 };
	const [line] = buildFooterLines(input, 240, terminalWidth);
	assert.match(line, /\[ctx 35% · 132k\/372k\] \[cache r\/w · 123k\/3434k\] \[\$2\.337\]/);
});

test("shows a named session after the branch and omits an empty name", () => {
	for (const sessionName of ["status bar", "界 session", "\u001b[31mstatus\u001b[0m\nbar"]) {
		const [line] = buildFooterLines({ ...footerInput(), sessionName }, 240, terminalWidth);
		assert.ok(line.endsWith(`[ main] [${sessionName === "界 session" ? sessionName : "status bar"}]`));
	}
	for (const sessionName of [undefined, "", " \n "]) {
		const [line] = buildFooterLines({ ...footerInput(), sessionName }, 240, terminalWidth);
		assert.ok(line.endsWith("[ main]"));
	}
});

test("removes terminal escapes and control characters from session names", () => {
	for (const sessionName of [
		"safe\u001b]2;PWNED\u0007name",
		"safe\u001b]2;PWNED\u001b\\name",
		"safe\u001b]8;;https://example.com\u001b\\name\u001b]8;;\u001b\\",
		"safe\u0000\u0007\u0008\u007f\u0080name",
	]) {
		const [line] = buildFooterLines({ ...footerInput(), sessionName }, 240, terminalWidth);
		assert.ok(line.endsWith("[ main] [safename]"));
		assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/);
	}
});

test("uses zero for missing or invalid cache counts", () => {
	for (const counters of [{}, { cacheRead: -1, cacheWrite: Number.NaN }, { cacheRead: Infinity, cacheWrite: -Infinity }]) {
		const [line] = buildFooterLines({ ...footerInput(), ...counters }, 240, terminalWidth);
		assert.match(line, /\[cache r\/w · 0\/0\]/);
	}
});

test("uses the agreed context and weekly quota color thresholds", () => {
	const cases = [
		{ rawContextPercent: 70, displayedContextPercent: 70, usedPercent: 75, contextTone: "context", quotaTone: "quota" },
		{ rawContextPercent: 70.1, displayedContextPercent: 70, usedPercent: 76, contextTone: "warning", quotaTone: "warning" },
		{ rawContextPercent: 90, displayedContextPercent: 90, usedPercent: 90, contextTone: "warning", quotaTone: "warning" },
		{ rawContextPercent: 90.1, displayedContextPercent: 90, usedPercent: 91, contextTone: "error", quotaTone: "error" },
	];

	for (const testCase of cases) {
		const input = footerInput();
		input.contextTokens = input.contextWindow * (testCase.rawContextPercent / 100);
		input.weeklyLimit = { usedPercent: testCase.usedPercent, resetAt };
		const [line] = buildFooterLines(
			input,
			240,
			terminalWidth,
			(tone, text) => `<${tone}>${text}</${tone}>`,
		);
		assert.match(line, new RegExp(`<${testCase.contextTone}>ctx ${testCase.displayedContextPercent}%`));
		assert.match(line, new RegExp(`<${testCase.quotaTone}>Week ${100 - testCase.usedPercent}% rem`));
	}
});

test("includes only a safe email account label decoded from the active OAuth token", () => {
	const accessToken = jwt({
		"https://api.openai.com/profile": { email: "work@example.com" },
	});
	assert.equal(extractSafeAccountLabel(accessToken), "work@example.com");

	for (const unsafe of [
		jwt({ email: "not an email" }),
		jwt({ email: "work@example.com\u001b[31m" }),
		"not-a-jwt",
		undefined,
	]) {
		assert.equal(extractSafeAccountLabel(unsafe), null);
	}

	const input = footerInput();
	input.accountLabel = "work@example.com";
	const [line] = buildFooterLines(input, 160, terminalWidth);
	assert.match(line, /\[AUTH work@example\.com\]/);
	assert.doesNotMatch(line, /\b(?:GLOBAL|LOCAL)\b/);
});

test("selects the weekly Codex response-header window and derives remaining quota", () => {
	assert.deepEqual(parseWeeklyLimit({
		"x-codex-primary-used-percent": "30",
		"x-codex-primary-window-minutes": "300",
		"x-codex-primary-reset-at": "1700000000",
		"x-codex-secondary-used-percent": "5",
		"x-codex-secondary-window-minutes": "10080",
		"x-codex-secondary-reset-at": String(resetAt),
	}), { usedPercent: 5, resetAt });

	assert.equal(parseWeeklyLimit({
		"x-codex-secondary-used-percent": "invalid",
		"x-codex-secondary-window-minutes": "10080",
	}), null);
});

test("wraps complete ANSI-styled components at an exact-fit boundary", () => {
	const lines = buildFooterLines(
		footerInput(),
		38,
		terminalWidth,
		(tone, text) => `\u001b[38;5;1m${text}\u001b[39m`,
	);
	assert.deepEqual(lines.map((line) => line.replace(ANSI_ESCAPE, "")), [
		"[gpt-5.4 · high] [ctx 35% · 132k/372k]",
		"[cache r/w · 0/0] [$2.337]",
		"[Week 95% rem · 6d21h]",
		"[● relay ○ voice ○ paging]",
		"[AUTH · LOCAL] [ main]",
	]);
	assert.equal(terminalWidth(lines[0]), 38);
});

test("wraps oversized Unicode components without losing their text", () => {
	const input = footerInput();
	input.gitBranch = "界".repeat(20);
	const lines = buildFooterLines(input, 24, terminalWidth);
	assert.ok(lines.every((line) => terminalWidth(line) <= 24));
	assert.deepEqual(lines.slice(-2), [
		`[ ${"界".repeat(10)}`,
		`${"界".repeat(10)}]`,
	]);
});

test("fits every footer block within the 25-column startup width", () => {
	const input = {
		...footerInput(),
		modelId: "gpt-5.6-sol",
		thinkingLevel: "xhigh",
		cacheRead: 2_575_700,
		accountLabel: "person@upfrontsoftware.co.za",
		gitBranch: "fix/a-long-branch-name-that-needs-wrapping",
		sessionName: "a long session name that also needs wrapping",
	};
	input.extensionStatuses.set("context-paging", "paging on");
	const lines = buildFooterLines(input, 25, terminalWidth);
	assert.ok(lines.every((line) => terminalWidth(line) <= 25), lines.join("\n"));
	const joined = lines.join("");
	for (const block of [
		"[● relay ○ voice ● paging]",
		"[AUTH person@upfrontsoftware.co.za]",
		"[ fix/a-long-branch-name-that-needs-wrapping]",
		"[a long session name that also needs wrapping]",
	]) assert.ok(joined.includes(block), block);
});

test("reapplies a component's color on its continuation lines", () => {
	const input = { ...footerInput(), gitBranch: "界".repeat(20) };
	const lines = buildFooterLines(input, 24, terminalWidth,
		(_tone, text) => `\u001b[31m${text}\u001b[39m`);
	assert.ok(lines.every((line) => terminalWidth(line) <= 24));
	assert.ok(lines.at(-1)?.startsWith(`\u001b[31m${"界".repeat(10)}\u001b[39m`));
	assert.equal(lines.slice(-2).join("").replace(ANSI_ESCAPE, ""), `[ ${"界".repeat(20)}]`);
});

test("keeps combining marks and emoji sequences on the same continuation line", () => {
	const name = "界e\u0301👩‍💻".repeat(8);
	const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	const knownWidths = new Map([["界", 2], ["e\u0301", 1], ["👩‍💻", 2]]);
	const measure = (text: string) => [...graphemes.segment(text.replace(ANSI_ESCAPE, ""))]
		.reduce((total, { segment }) => total + (knownWidths.get(segment) ?? 1), 0);
	const lines = buildFooterLines({ ...footerInput(), sessionName: name }, 10, measure);
	assert.ok(lines.every((line) => measure(line) <= 10));
	assert.ok(lines.join("").endsWith(`[${name}]`));
	for (const line of lines) {
		assert.doesNotMatch(line, /^[\u0301\u200d]/u);
		assert.ok(!line.endsWith("👩") && !line.endsWith("\u200d"));
	}
});

test("renders nothing when there is no usable terminal width", () => {
	for (const width of [0, 1, -1]) {
		assert.deepEqual(buildFooterLines(footerInput(), width, terminalWidth), []);
	}
});
