import test from "node:test";
import assert from "node:assert/strict";

import { registerStatusFooter } from "./extension.ts";

type Hook = (event: any, ctx: any) => unknown;

function jwt(payload: Record<string, unknown>): string {
	return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function truncateForTest(text: string): string {
	return text;
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

function createContext(mode: "tui" | "print" = "tui") {
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
							? jwt({ "https://api.openai.com/profile": { email: "work@example.com" } })
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

test("installs a live two-line footer and refreshes it from Codex rate-limit headers", async () => {
	const harness = createHarness();
	const { ctx, footerCalls, getAuthReads } = createContext();
	registerStatusFooter(harness.pi as any, { now: () => nowMs, truncateToWidth: truncateForTest });

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

	assert.deepEqual(component.render(120), [
		"gpt-5.4 high │ ctx 35% 132k/372k │ $2.337",
		" main │ ● relay ○ voice │ AUTH work@example.com · LOCAL",
	]);

	await harness.hooks.get("after_provider_response")?.({
		headers: {
			"x-codex-secondary-used-percent": "5",
			"x-codex-secondary-window-minutes": "10080",
			"x-codex-secondary-reset-at": String(resetAt),
		},
	}, ctx);
	assert.equal(renders, 1);
	assert.match(component.render(120)[0], /Week 95% rem · 6d21h$/);

	branchListener?.();
	assert.equal(renders, 2);
	component.dispose();
	assert.equal(unsubscribed, true);

	await harness.hooks.get("session_shutdown")?.({}, ctx);
	assert.equal(footerCalls.at(-1), undefined);
});

test("does not carry Codex weekly quota across providers", async () => {
	const harness = createHarness();
	const { ctx, footerCalls } = createContext();
	registerStatusFooter(harness.pi as any, { now: () => nowMs, truncateToWidth: truncateForTest });
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
	registerStatusFooter(harness.pi as any, { now: () => nowMs, truncateToWidth: truncateForTest });

	assert.ok(harness.hooks.has("session_start"));
	await harness.hooks.get("session_start")?.({}, ctx);

	assert.equal(getAuthReads(), 0);
	assert.deepEqual(footerCalls, []);
});
