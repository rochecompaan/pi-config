import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
	buildFooterLines,
	extractSafeAccountLabel,
	parseWeeklyLimit,
	type FooterTone,
	type VisibleWidth,
	type WeeklyLimit,
} from "./core.ts";

const CODEX_PROVIDER = "openai-codex";

export interface StatusFooterDependencies {
	now(): number;
	visibleWidth: VisibleWidth;
}

const GRUVBOX_RGB: Record<FooterTone, readonly [number, number, number]> = {
	model: [131, 165, 152],
	thinking: [211, 134, 155],
	context: [142, 192, 124],
	quota: [250, 189, 47],
	connected: [184, 187, 38],
	branch: [214, 93, 14],
	account: [235, 219, 178],
	warning: [254, 128, 25],
	error: [251, 73, 52],
	cost: [254, 128, 25],
	dim: [102, 92, 84],
};

function styleGruvboxText(tone: FooterTone, text: string): string {
	const [red, green, blue] = GRUVBOX_RGB[tone];
	return `\u001b[38;2;${red};${green};${blue}m${text}\u001b[39m`;
}

function collectSessionCost(ctx: ExtensionContext): number {
	let total = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const cost = entry.message.usage?.cost?.total;
		if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) total += cost;
	}
	return total;
}

export function registerStatusFooter(
	pi: ExtensionAPI,
	dependencies: StatusFooterDependencies,
): void {
	let weeklyLimit: WeeklyLimit | null = null;
	let accountLabel: string | null = null;
	let requestRender: (() => void) | undefined;

	async function refreshAccountLabel(ctx: ExtensionContext): Promise<void> {
		const provider = ctx.model?.provider;
		if (!provider) {
			accountLabel = null;
			return;
		}
		try {
			const auth = await ctx.modelRegistry.getProviderAuth(provider);
			if (ctx.model?.provider !== provider) return;
			accountLabel = auth?.source === "OAuth"
				? extractSafeAccountLabel(auth.auth.apiKey)
				: null;
		} catch {
			accountLabel = null;
		}
		requestRender?.();
	}

	pi.on("session_start", async (_event, ctx) => {
		weeklyLimit = null;
		accountLabel = null;
		requestRender = undefined;
		if (ctx.mode !== "tui") return;

		await refreshAccountLabel(ctx);
		ctx.ui.setFooter((tui, _theme, footerData) => {
			const render = () => tui.requestRender();
			requestRender = render;
			const unsubscribeBranch = footerData.onBranchChange(render);

			return {
				render(width: number): string[] {
					const usage = ctx.getContextUsage();
					return buildFooterLines({
						modelId: ctx.model?.id ?? "no-model",
						thinkingLevel: ctx.thinkingLevel,
						contextTokens: usage?.tokens ?? 0,
						contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
						cost: collectSessionCost(ctx),
						weeklyLimit,
						gitBranch: footerData.getGitBranch(),
						extensionStatuses: footerData.getExtensionStatuses(),
						accountLabel,
						nowMs: dependencies.now(),
					}, width, dependencies.visibleWidth, styleGruvboxText);
				},
				invalidate() {},
				dispose() {
					unsubscribeBranch();
					if (requestRender === render) requestRender = undefined;
				},
			};
		});
	});

	pi.on("model_select", async (_event, ctx) => {
		if (ctx.model?.provider !== CODEX_PROVIDER) weeklyLimit = null;
		if (ctx.mode !== "tui") return;
		await refreshAccountLabel(ctx);
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.model?.provider !== CODEX_PROVIDER) return;
		const next = parseWeeklyLimit(event.headers);
		if (!next) return;
		weeklyLimit = next;
		requestRender?.();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
		requestRender = undefined;
		weeklyLimit = null;
		accountLabel = null;
	});
}
