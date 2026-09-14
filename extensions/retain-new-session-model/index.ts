import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

export const HANDOFF_ENTRY_TYPE = "retain-new-session-model";

const HANDOFF_VERSION = 1 as const;
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

export type RuntimeChoiceHandoff = {
	version: typeof HANDOFF_VERSION;
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
};

export type HandoffSelection =
	| { kind: "missing" }
	| { kind: "invalid"; reason: "malformed" | "unsupported-version" }
	| { kind: "found"; choice: RuntimeChoiceHandoff };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string"
		&& (THINKING_LEVELS as readonly string[]).includes(value);
}

export function selectNewestHandoff(entries: readonly unknown[]): HandoffSelection {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecord(entry)
			|| entry.type !== "custom"
			|| entry.customType !== HANDOFF_ENTRY_TYPE) {
			continue;
		}

		const data = entry.data;
		if (!isRecord(data)) return { kind: "invalid", reason: "malformed" };
		if (typeof data.version === "number" && data.version !== HANDOFF_VERSION) {
			return { kind: "invalid", reason: "unsupported-version" };
		}
		if (data.version !== HANDOFF_VERSION
			|| typeof data.provider !== "string"
			|| data.provider.length === 0
			|| typeof data.modelId !== "string"
			|| data.modelId.length === 0
			|| !isThinkingLevel(data.thinkingLevel)) {
			return { kind: "invalid", reason: "malformed" };
		}

		return {
			kind: "found",
			choice: {
				version: HANDOFF_VERSION,
				provider: data.provider,
				modelId: data.modelId,
				thinkingLevel: data.thinkingLevel,
			},
		};
	}

	return { kind: "missing" };
}

export type SessionEntriesReader = (
	sessionFile: string,
) => Promise<readonly unknown[]> | readonly unknown[];

export interface RetainNewSessionModelDependencies {
	readSessionEntries: SessionEntriesReader;
}

const defaultDependencies: RetainNewSessionModelDependencies = {
	async readSessionEntries(sessionFile) {
		const { SessionManager } = await import("@mariozechner/pi-coding-agent");
		return SessionManager.open(sessionFile).getEntries();
	},
};

type RestoreWarning =
	| "malformed"
	| "unsupported-version"
	| "read-error"
	| "unavailable-model"
	| "authentication"
	| "model-activation";

const WARNING_MESSAGES: Record<RestoreWarning, string> = {
	malformed: "Ignored malformed /new runtime handoff; using replacement-session defaults.",
	"unsupported-version": "Ignored unsupported /new runtime handoff version; using replacement-session defaults.",
	"read-error": "Could not read the previous session; using replacement-session defaults.",
	"unavailable-model": "The retained model is unavailable; using replacement-session defaults.",
	authentication: "Pi could not authenticate the retained model; using replacement-session defaults.",
	"model-activation": "Pi could not restore the retained model; using replacement-session defaults.",
};

function warn(ctx: ExtensionContext, reason: RestoreWarning): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(`[retain-new-session-model] ${WARNING_MESSAGES[reason]}`, "warning");
}

export default function retainNewSessionModel(
	pi: ExtensionAPI,
	dependencies: RetainNewSessionModelDependencies = defaultDependencies,
): void {
	pi.on("session_before_switch", (event, ctx) => {
		if (event.reason !== "new" || !ctx.model || !ctx.thinkingLevel) return;

		pi.appendEntry<RuntimeChoiceHandoff>(HANDOFF_ENTRY_TYPE, {
			version: HANDOFF_VERSION,
			provider: ctx.model.provider,
			modelId: ctx.model.id,
			thinkingLevel: ctx.thinkingLevel,
		});
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "new" || !event.previousSessionFile) return;

		let entries: readonly unknown[];
		try {
			entries = await dependencies.readSessionEntries(event.previousSessionFile);
		} catch {
			warn(ctx, "read-error");
			return;
		}
		const selection = selectNewestHandoff(entries);
		if (selection.kind === "missing") return;
		if (selection.kind === "invalid") {
			warn(ctx, selection.reason);
			return;
		}

		let model: ReturnType<ExtensionContext["modelRegistry"]["find"]>;
		try {
			model = ctx.modelRegistry.find(selection.choice.provider, selection.choice.modelId);
		} catch {
			warn(ctx, "model-activation");
			return;
		}
		if (!model) {
			warn(ctx, "unavailable-model");
			return;
		}

		let restored: boolean;
		try {
			restored = await pi.setModel(model);
		} catch {
			warn(ctx, "model-activation");
			return;
		}
		if (!restored) {
			warn(ctx, "authentication");
			return;
		}

		pi.setThinkingLevel(selection.choice.thinkingLevel);
	});
}
