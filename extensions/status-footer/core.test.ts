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
		"[gpt-5.4 · high] [ctx 35% · 132k/372k] [$2.337] [Week 95% rem · 6d21h] [● relay ○ voice] [AUTH · LOCAL] [ main]",
	]);
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
		"[$2.337] [Week 95% rem · 6d21h]",
		"[● relay ○ voice] [AUTH · LOCAL]",
		"[ main]",
	]);
	assert.equal(terminalWidth(lines[0]), 38);
});

test("keeps a component wider than the terminal intact on its own line", () => {
	const input = footerInput();
	input.gitBranch = "界".repeat(20);
	const lines = buildFooterLines(input, 24, terminalWidth);
	assert.equal(lines.at(-1), `[ ${"界".repeat(20)}]`);
	assert.ok(terminalWidth(lines.at(-1) ?? "") > 24);
	assert.doesNotMatch(lines.join("\n"), /…/);
});
