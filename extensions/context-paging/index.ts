import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	DEFAULT_CONTEXT_TOKEN_BUDGET,
	residentTokenEstimate,
	selectContext,
	type ResidentToolDefinition,
} from "./context-policy.ts";
import { ContextUsageTracker } from "./context-usage.ts";
import { isPagingToolTurn, projectActiveBranch, type HistoryItem } from "./history.ts";
import { HistoryNavigator } from "./navigator.ts";
import { registerContextPagingTools, type HistorySnapshot } from "./tools.ts";

export type ContextPagingSettingsSources = {
	globalSettings: unknown;
	projectSettings?: unknown;
	projectTrusted: boolean;
};

export type ResolvedContextPagingSettings = {
	enabled: boolean;
	tokenBudget: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEnabledSetting(settings: unknown): boolean | undefined {
	if (!isRecord(settings) || !isRecord(settings.contextPaging)) return undefined;
	return typeof settings.contextPaging.enabled === "boolean"
		? settings.contextPaging.enabled
		: undefined;
}

function readTokenBudgetSetting(settings: unknown): number | undefined {
	if (!isRecord(settings) || !isRecord(settings.contextPaging)) return undefined;
	const value = settings.contextPaging.tokenBudget;
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
}

/** Resolves trusted-project context-paging settings over global settings. */
export function resolveContextPagingSettings(
	sources: ContextPagingSettingsSources,
): ResolvedContextPagingSettings {
	const projectSettings = sources.projectTrusted ? sources.projectSettings : undefined;
	return {
		enabled: readEnabledSetting(projectSettings)
			?? readEnabledSetting(sources.globalSettings)
			?? true,
		tokenBudget: readTokenBudgetSetting(projectSettings)
			?? readTokenBudgetSetting(sources.globalSettings)
			?? DEFAULT_CONTEXT_TOKEN_BUDGET,
	};
}

async function readJsonSettings(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") return undefined;
		throw error;
	}
}

async function loadSettings(ctx: ExtensionContext): Promise<ContextPagingSettingsSources> {
	const codingAgent = await import("@earendil-works/pi-coding-agent") as {
		CONFIG_DIR_NAME?: string;
		getAgentDir?: () => string;
	};
	const projectTrusted = ctx.isProjectTrusted();
	const configDirectory = codingAgent.CONFIG_DIR_NAME ?? ".pi";
	const agentDirectory = codingAgent.getAgentDir?.() ?? join(process.env.HOME ?? "", ".pi", "agent");
	return {
		globalSettings: await readJsonSettings(join(agentDirectory, "settings.json")),
		projectSettings: projectTrusted
			? await readJsonSettings(join(ctx.cwd, configDirectory, "settings.json"))
			: undefined,
		projectTrusted,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function activeResidentTools(pi: ExtensionAPI): ResidentToolDefinition[] {
	const activeNames = new Set(pi.getActiveTools());
	return pi.getAllTools()
		.filter((tool) => activeNames.has(tool.name))
		.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function persistentSessionMessages(ctx: ExtensionContext): AgentMessage[] {
	return ctx.sessionManager.buildSessionProjection().messages;
}

/** Registers context paging lifecycle hooks and the four recovery tools. */
export default function contextPagingExtension(
	pi: ExtensionAPI,
	settingsSources?: ContextPagingSettingsSources,
): void {
	let resolvedSettings: ResolvedContextPagingSettings = settingsSources
		? resolveContextPagingSettings(settingsSources)
		: { enabled: false, tokenBudget: DEFAULT_CONTEXT_TOKEN_BUDGET };
	let allItems: HistoryItem[] = [];
	const navigator = new HistoryNavigator();
	const usageTracker = new ContextUsageTracker();
	let visibleHistoryIds: string[] = [];
	let invalidatingBranchEntries = new Set<string>();
	let canonicalSessionMessages: AgentMessage[] | undefined;
	const refresh = (ctx: ExtensionContext): HistoryItem[] => {
		const branch = ctx.sessionManager.getBranch();
		const currentInvalidatingEntries = new Set(branch
			.filter((entry) => entry.type === "context_edit" || entry.type === "compaction")
			.map((entry) => entry.id));
		if ([...currentInvalidatingEntries].some((id) => !invalidatingBranchEntries.has(id))) usageTracker.clear();
		invalidatingBranchEntries = currentInvalidatingEntries;
		const projected = projectActiveBranch(branch);
		canonicalSessionMessages = persistentSessionMessages(ctx);
		allItems = projected;
		return projected;
	};
	const visibleHistoryChanged = (items: readonly HistoryItem[]): boolean => {
		let index = 0;
		for (const item of items) {
			if (isPagingToolTurn(item)) continue;
			if (item.id !== visibleHistoryIds[index++]) return true;
		}
		return index !== visibleHistoryIds.length;
	};
	const snapshot = (ctx: ExtensionContext): HistorySnapshot => {
		const projected = refresh(ctx);
		if (visibleHistoryChanged(projected)) {
			navigator.rebuild(projected);
			visibleHistoryIds = projected.filter((item) => !isPagingToolTurn(item)).map((item) => item.id);
		}
		return { allItems, navigator };
	};
	const refreshSafely = (ctx: ExtensionContext) => {
		try {
			refresh(ctx);
		} catch (error) {
			usageTracker.clear();
			canonicalSessionMessages = undefined;
			ctx.ui.notify(`Context paging navigation is unavailable: ${errorMessage(error)}`, "error");
		}
	};

	registerContextPagingTools(pi, {
		isEnabled: () => resolvedSettings.enabled,
		snapshot,
	});

	pi.on("session_start", async (_event, ctx) => {
		usageTracker.clear();
		invalidatingBranchEntries = new Set();
		if (!settingsSources) {
			resolvedSettings = { ...resolvedSettings, enabled: false };
			resolvedSettings = resolveContextPagingSettings(await loadSettings(ctx));
		}
		refreshSafely(ctx);
	});
	pi.on("turn_end", (event, ctx) => {
		usageTracker.recordResponse(event.message);
		refreshSafely(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		usageTracker.clear();
		invalidatingBranchEntries = new Set();
		refreshSafely(ctx);
	});
	pi.on("model_select", () => {
		usageTracker.clear();
	});
	pi.on("session_compact", () => {
		usageTracker.clear();
	});
	pi.on("context", (event, ctx) => {
		if (!resolvedSettings.enabled) return;

		let rawHistoryItems: readonly HistoryItem[] | undefined;
		try {
			rawHistoryItems = refresh(ctx);
		} catch (error) {
			usageTracker.clear();
			canonicalSessionMessages = undefined;
			ctx.ui.notify(`Context paging history is unavailable: ${errorMessage(error)}`, "error");
		}

		try {
			const systemPrompt = ctx.getSystemPrompt();
			const activeTools = activeResidentTools(pi);
			const residentTokens = residentTokenEstimate({ systemPrompt, activeTools });
			const outgoingOnly = canonicalSessionMessages
				? usageTracker.outgoingOnly(event.messages, canonicalSessionMessages)
				: undefined;
			const contextTokens = canonicalSessionMessages
				? usageTracker.prepare(event.messages, residentTokens, ctx.getContextUsage()?.tokens, canonicalSessionMessages)
				: undefined;
			const selection = selectContext({
				messages: event.messages,
				systemPrompt,
				activeTools,
				modelContextWindow: ctx.model?.contextWindow,
				tokenBudget: resolvedSettings.tokenBudget,
				contextTokens,
				outgoingOnly,
				rawHistoryItems,
			});
			if (canonicalSessionMessages) usageTracker.recordSelection(selection.messages, residentTokens, canonicalSessionMessages);
			return { messages: selection.messages };
		} catch (error) {
			ctx.abort();
			ctx.ui.notify(`Context paging aborted this provider call: ${errorMessage(error)}`, "error");
			return { messages: event.messages };
		}
	});
	pi.on("session_before_compact", async (event) => {
		if (!resolvedSettings.enabled) return;
		if (event.reason === "threshold" || event.reason === "overflow") return { cancel: true };
		usageTracker.clear();
	});
}
