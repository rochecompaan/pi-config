import test from "node:test";
import assert from "node:assert/strict";

import { registerStatusFooter } from "./extension.ts";

type Hook = (event: any, ctx: any) => unknown;

function jwt(payload: Record<string, unknown>): string {
	return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE, "");
}

function terminalWidth(text: string): number {
	return [...stripAnsi(text)].length;
}

function rgb(red: number, green: number, blue: number, text: string): string {
	return `\u001b[38;2;${red};${green};${blue}m${text}\u001b[39m`;
}

function createHarness() {
	const hooks = new Map<string, Hook>();
	const pi = {
		on(name: string, handler: Hook) {
			hooks.set(name, handler);
		},
	};
	return { hooks, pi };
}

function createContext(mode: "tui" | "print" = "tui", accountEmail: string | null = "work@example.com") {
	const footerCalls: unknown[] = [];
	let authReads = 0;
	const ctx = {
		mode,
		hasUI: mode === "tui",
		model: { id: "gpt-5.4", provider: "openai-codex", contextWindow: 372_000 },
		thinkingLevel: "high",
		getContextUsage: () => ({ tokens: 132_000, contextWindow: 372_000, percent: 35.48 }),
		sessionManager: {
			getBranch: () => [
				{ type: "message", message: { role: "assistant", usage: { cost: { total: 1.2 } } } },
				{ type: "message", message: { role: "assistant", usage: { cost: { total: 1.137 } } } },
			],
		},
		modelRegistry: {
			async getProviderAuth(provider: string) {
				authReads++;
				return {
					auth: {
						apiKey: provider === "openai-codex"
							? jwt(accountEmail ? { "https://api.openai.com/profile": { email: accountEmail } } : {})
							: "not-a-jwt",
					},
					source: provider === "openai-codex" ? "OAuth" : "ANTHROPIC_API_KEY",
				};
			},
		},
		ui: {
			setFooter(value: unknown) {
				footerCalls.push(value);
			},
		},
	};
	return { ctx, footerCalls, getAuthReads: () => authReads };
}

const nowMs = Date.UTC(2026, 8, 18, 9, 0, 0);
const resetAt = Math.floor((nowMs + ((6 * 24 + 21) * 60 * 60 * 1000)) / 1000);

test("installs a live wrapping footer and refreshes it from Codex rate-limit headers", async () => {
	const harness = createHarness();
	const { ctx, footerCalls, getAuthReads } = createContext();
	registerStatusFooter(harness.pi as any, { now: () => nowMs, visibleWidth: terminalWidth });

	await harness.hooks.get("session_start")?.({}, ctx);

	assert.equal(getAuthReads(), 1);
	assert.equal(footerCalls.length, 1);
	const factory = footerCalls[0] as (tui: any, theme: any, footerData: any) => any;
	let renders = 0;
	let unsubscribed = false;
	let branchListener: (() => void) | undefined;
	const component = factory(
		{ requestRender: () => renders++ },
		{ fg: (_color: string, text: string) => text },
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map([
				["remote-pi:relay", "🟢 relay"],
				["voice", "MIC LOCAL"],
				["auth-scope", "auth: LOCAL"],
			]),
			onBranchChange(listener: () => void) {
				branchListener = listener;
				return () => { unsubscribed = true; };
			},
		},
	);

	assert.deepEqual(component.render(120).map(stripAnsi), [
		"[gpt-5.4 · high] [ctx 35% · 132k/372k] [$2.337] [● relay ○ voice] [AUTH work@example.com] [ main]",
	]);

	await harness.hooks.get("after_provider_response")?.({
		headers: {
			"x-codex-secondary-used-percent": "5",
			"x-codex-secondary-window-minutes": "10080",
			"x-codex-secondary-reset-at": String(resetAt),
		},
	}, ctx);
	assert.equal(renders, 1);
	assert.deepEqual(component.render(120).map(stripAnsi), [
		"[gpt-5.4 · high] [ctx 35% · 132k/372k] [$2.337] [Week 95% rem · 6d21h] [● relay ○ voice] [AUTH work@example.com]",
		"[ main]",
	]);

	branchListener?.();
	assert.equal(renders, 2);
	component.dispose();
	assert.equal(unsubscribed, true);

	await harness.hooks.get("session_shutdown")?.({}, ctx);
	assert.equal(footerCalls.at(-1), undefined);
});

test("renders footer components with the approved Gruvbox colors", async () => {
	const harness = createHarness();
	const { ctx, footerCalls } = createContext();
	registerStatusFooter(harness.pi as any, { now: () => nowMs, visibleWidth: terminalWidth });
	await harness.hooks.get("session_start")?.({}, ctx);
	await harness.hooks.get("after_provider_response")?.({
		headers: {
			"x-codex-secondary-used-percent": "5",
			"x-codex-secondary-window-minutes": "10080",
			"x-codex-secondary-reset-at": String(resetAt),
		},
	}, ctx);

	const factory = footerCalls[0] as (tui: any, theme: any, footerData: any) => any;
	const component = factory(
		{ requestRender() {} },
		{ fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map([
				["remote-pi:relay", "🟢 relay"],
				["voice", "MIC LOCAL"],
				["auth-scope", "auth: LOCAL"],
			]),
			onBranchChange: () => () => {},
		},
	);

	const [line] = component.render(240);
	assert.ok(line);
	assert.ok(line.includes(rgb(131, 165, 152, "gpt-5.4")));
	assert.ok(line.includes(rgb(211, 134, 155, "high")));
	assert.ok(line.includes(rgb(142, 192, 124, "ctx 35%")));
	assert.ok(line.includes(rgb(254, 128, 25, "$2.337")));
	assert.ok(line.includes(rgb(250, 189, 47, "Week 95% rem")));
	assert.ok(line.includes(rgb(184, 187, 38, "● relay")));
	assert.ok(line.includes(rgb(235, 219, 178, " work@example.com")));
	assert.ok(line.includes(rgb(214, 93, 14, " main")));
	assert.ok(line.includes(rgb(251, 73, 52, "○ voice")));
	assert.ok(line.includes(rgb(102, 92, 84, "[")));
	assert.equal(stripAnsi(line), "[gpt-5.4 · high] [ctx 35% · 132k/372k] [$2.337] [Week 95% rem · 6d21h] [● relay ○ voice] [AUTH work@example.com] [ main]");
});

test("renders the auth scope fallback with a dim separator and cream scope", async () => {
	const harness = createHarness();
	const { ctx, footerCalls } = createContext("tui", null);
	registerStatusFooter(harness.pi as any, { now: () => nowMs, visibleWidth: terminalWidth });
	await harness.hooks.get("session_start")?.({}, ctx);

	const factory = footerCalls[0] as (tui: any, theme: any, footerData: any) => any;
	const component = factory(
		{ requestRender() {} },
		{ fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map([["auth-scope", "auth: LOCAL"]]),
			onBranchChange: () => () => {},
		},
	);

	const [line] = component.render(240);
	assert.ok(line);
	assert.ok(line.includes(rgb(102, 92, 84, " · ")));
	assert.ok(line.includes(rgb(235, 219, 178, "LOCAL")));
	assert.match(stripAnsi(line), /\[AUTH · LOCAL\]/);
});

test("does not carry Codex weekly quota across providers", async () => {
	const harness = createHarness();
	const { ctx, footerCalls } = createContext();
	registerStatusFooter(harness.pi as any, { now: () => nowMs, visibleWidth: terminalWidth });
	await harness.hooks.get("session_start")?.({}, ctx);

	const factory = footerCalls[0] as (tui: any, theme: any, footerData: any) => any;
	const component = factory(
		{ requestRender() {} },
		{ fg: (_color: string, text: string) => text },
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map([["auth-scope", "auth: LOCAL"]]),
			onBranchChange: () => () => {},
		},
	);
	const response = {
		headers: {
			"x-codex-secondary-used-percent": "5",
			"x-codex-secondary-window-minutes": "10080",
			"x-codex-secondary-reset-at": String(resetAt),
		},
	};
	await harness.hooks.get("after_provider_response")?.(response, ctx);
	assert.match(component.render(120)[0], /Week 95% rem/);

	ctx.model = { id: "claude-opus-4.1", provider: "anthropic", contextWindow: 200_000 };
	await harness.hooks.get("model_select")?.({ model: ctx.model }, ctx);
	assert.doesNotMatch(component.render(120)[0], /Week/);

	await harness.hooks.get("after_provider_response")?.(response, ctx);
	assert.doesNotMatch(component.render(120)[0], /Week/);
});

test("does not resolve auth or install a footer outside TUI mode", async () => {
	const harness = createHarness();
	const { ctx, footerCalls, getAuthReads } = createContext("print");
	registerStatusFooter(harness.pi as any, { now: () => nowMs, visibleWidth: terminalWidth });

	assert.ok(harness.hooks.has("session_start"));
	await harness.hooks.get("session_start")?.({}, ctx);

	assert.equal(getAuthReads(), 0);
	assert.deepEqual(footerCalls, []);
});
