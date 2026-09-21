import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectContext, type ResidentToolDefinition } from "./context-policy.ts";
import { projectActiveBranch, type HistoryItem } from "./history.ts";
import { HistoryNavigator } from "./navigator.ts";
import { registerContextPagingTools, type HistorySnapshot } from "./tools.ts";

const DEFAULT_CONTEXT_PAGING_ENABLED = true;

export type ContextPagingSettingsSources = {
	globalSettings: unknown;
	projectSettings?: unknown;
	projectTrusted: boolean;
};

function readEnabledSetting(settings: unknown): boolean | undefined {
	if (typeof settings !== "object" || settings === null) return undefined;
	const contextPaging = (settings as { contextPaging?: unknown }).contextPaging;
	if (typeof contextPaging !== "object" || contextPaging === null) return undefined;
	const enabled = (contextPaging as { enabled?: unknown }).enabled;
	return typeof enabled === "boolean" ? enabled : undefined;
}

export function resolveContextPagingEnabled(sources: ContextPagingSettingsSources): boolean {
	const globalValue = readEnabledSetting(sources.globalSettings);
	const projectValue = sources.projectTrusted
		? readEnabledSetting(sources.projectSettings)
		: undefined;
	return projectValue ?? globalValue ?? DEFAULT_CONTEXT_PAGING_ENABLED;
}

async function readJsonSettings(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

async function loadSettings(ctx: ExtensionContext): Promise<ContextPagingSettingsSources> {
	const { CONFIG_DIR_NAME, getAgentDir } = await import("@earendil-works/pi-coding-agent");
	const projectTrusted = ctx.isProjectTrusted();
	return {
		globalSettings: await readJsonSettings(join(getAgentDir(), "settings.json")),
		projectSettings: projectTrusted
			? await readJsonSettings(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"))
			: undefined,
		projectTrusted,
	};
}

function activeResidentTools(pi: ExtensionAPI): ResidentToolDefinition[] {
	const activeNames = new Set(pi.getActiveTools());
	return pi.getAllTools()
		.filter((tool) => activeNames.has(tool.name))
		.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function contextPagingExtension(pi: ExtensionAPI): void {
	let enabled = DEFAULT_CONTEXT_PAGING_ENABLED;
	let allItems: readonly HistoryItem[] = [];
	const navigator = new HistoryNavigator();

	const rebuild = (ctx: ExtensionContext): HistorySnapshot => {
		allItems = projectActiveBranch(ctx.sessionManager.getBranch());
		navigator.rebuild(allItems);
		return { allItems, navigator };
	};
	const rebuildWithNotice = (ctx: ExtensionContext): void => {
		try {
			rebuild(ctx);
		} catch (error) {
			ctx.ui.notify(`Context paging could not rebuild history: ${errorMessage(error)}`, "error");
		}
	};

	registerContextPagingTools(pi, {
		isEnabled: () => enabled,
		snapshot: rebuild,
	});

	pi.on("session_start", async (_event, ctx) => {
		enabled = resolveContextPagingEnabled(await loadSettings(ctx));
		rebuild(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		rebuildWithNotice(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		rebuildWithNotice(ctx);
	});

	pi.on("context", (event, ctx) => {
		if (!enabled) return;
		try {
			const snapshot = rebuild(ctx);
			const selection = selectContext({
				items: snapshot.allItems,
				systemPrompt: ctx.getSystemPrompt(),
				activeTools: activeResidentTools(pi),
				contextWindow: ctx.model?.contextWindow,
			});
			return { messages: selection.messages };
		} catch (error) {
			ctx.abort();
			ctx.ui.notify(
				`Context paging aborted this provider turn: ${errorMessage(error)}`,
				"error",
			);
			return { messages: event.messages };
		}
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		if (!enabled) return;
		ctx.ui.notify("Context paging kept raw history and cancelled compaction.", "warning");
		return { cancel: true };
	});
}
