import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
	buildRenderedSavings,
	collectContextModeSavings,
	collectCurrentSessionUsage,
	collectWorktreeUsageFromJsonl,
	deriveContextModeSessionId,
} from "./core.ts";

export async function buildSavingsReport(
	ctx: ExtensionCommandContext | ExtensionContext,
	options: { includeWorktree?: boolean } = {},
): Promise<{ text: string; status: string | null }> {
	const sessionId = deriveContextModeSessionId(ctx);
	const contextMode = await collectContextModeSavings({ cwd: ctx.cwd, sessionId });
	const currentUsage = collectCurrentSessionUsage(ctx);
	const worktreeUsage = options.includeWorktree === false ? { totalTokens: 0, totalCost: 0 } : await collectWorktreeUsageFromJsonl(ctx.cwd);
	return buildRenderedSavings({ contextMode, currentUsage, worktreeUsage });
}

async function refreshStatus(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	try {
		const report = await buildSavingsReport(ctx, { includeWorktree: false });
		ctx.ui.setStatus("ctx-savings", report.status ?? undefined);
	} catch {
		ctx.ui.setStatus("ctx-savings", undefined);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("ctx-savings", {
		description: "Show context-mode token and projected cost savings for this worktree",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const report = await buildSavingsReport(ctx, { includeWorktree: true });
			if (ctx.hasUI) {
				ctx.ui.setStatus("ctx-savings", report.status ?? undefined);
			}
			pi.sendMessage({ customType: "ctx-savings", content: report.text, display: true }, { triggerTurn: false });
		},
	});

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		await refreshStatus(ctx);
	});
	pi.on("session_switch", async (_event, ctx: ExtensionContext) => {
		await refreshStatus(ctx);
	});
	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		await refreshStatus(ctx);
	});
}
