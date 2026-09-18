import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { openBunSqliteDatabase } from "./bun-sqlite.ts";
import {
	collectContextModeSavings,
	ContextModeDatabaseUnavailableError,
} from "./context-mode-db.ts";
import {
	buildRenderedSavings,
	collectCurrentSessionUsage,
	collectWorktreeUsageFromJsonl,
	deriveContextModeSessionId,
} from "./core.ts";

export type SavingsReport = { text: string; status: string | null };
export type SavingsReportBuilder = (
	ctx: ExtensionCommandContext | ExtensionContext,
	options?: { includeWorktree?: boolean },
) => Promise<SavingsReport>;

const SQLITE_UNAVAILABLE_REPORT: SavingsReport = {
	text: "ctx-savings unavailable: SQLite could not be initialized.",
	status: "ctx: unavailable",
};

export async function buildSavingsReport(
	ctx: ExtensionCommandContext | ExtensionContext,
	options: { includeWorktree?: boolean } = {},
): Promise<SavingsReport> {
	const sessionId = deriveContextModeSessionId(ctx);
	const contextMode = await collectContextModeSavings(
		{
			cwd: ctx.cwd,
			sessionId,
			databaseScope: options.includeWorktree === false ? "project" : "all",
		},
		openBunSqliteDatabase,
	);
	const currentUsage = collectCurrentSessionUsage(ctx);
	const worktreeUsage = options.includeWorktree === false
		? { totalTokens: 0, totalCost: 0 }
		: await collectWorktreeUsageFromJsonl(ctx.cwd);
	return buildRenderedSavings({ contextMode, currentUsage, worktreeUsage });
}

export default function registerCtxSavings(
	pi: ExtensionAPI,
	reportBuilder: SavingsReportBuilder = buildSavingsReport,
) {
	pi.registerCommand("ctx-savings", {
		description: "Show context-mode token and projected cost savings for this worktree",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			let report: SavingsReport;
			try {
				report = await reportBuilder(ctx, { includeWorktree: true });
			} catch (error) {
				if (!(error instanceof ContextModeDatabaseUnavailableError)) throw error;
				report = SQLITE_UNAVAILABLE_REPORT;
			}
			pi.sendMessage(
				{ customType: "ctx-savings", content: report.text, display: true },
				{ triggerTurn: false },
			);
		},
	});
}
