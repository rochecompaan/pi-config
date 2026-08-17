import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { classifyQuickfix, serializeQuickfixBranch } from "./classifier.ts";
import { finishQuickfixLifecycle, startQuickfixLifecycle } from "./lifecycle.ts";
import { buildQuickfixInitialPrompt, filterQuickfixSystemPrompt, QUICKFIX_CONTRACT } from "./prompt.ts";
import {
	getQuickfixProfile,
	parseQuickfixCommand,
	QUICKFIX_BLOCKED_TOOLS,
	QUICKFIX_PROFILE_OPTIONS,
	type QuickfixProfile,
	type QuickfixProfileId,
} from "./profiles.ts";

type QuickfixDependencies = {
	loadPiPromptModule: () => Promise<Pick<typeof import("@mariozechner/pi-coding-agent"), "formatSkillsForPrompt">>;
};

const defaultDependencies: QuickfixDependencies = {
	loadPiPromptModule: () => import("@mariozechner/pi-coding-agent"),
};

type QuickfixPhase = "classifying" | "entering" | "active" | "returning";
type ActiveQuickfix = {
	sessionId: string;
	originId: string;
	markerId?: string;
	profile: QuickfixProfileId;
	request: string;
	initialPrompt: string;
	summary?: string;
	phase: QuickfixPhase;
};

let activeQuickfix: ActiveQuickfix | undefined;
let quickfixStartInProgress = false;
let quickfixEndInProgress = false;

function notify(
	ctx: ExtensionContext | ExtensionCommandContext,
	message: string,
	level: "info" | "warning" | "error",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	}
}

function setQuickfixWidget(ctx: ExtensionContext, profile: QuickfixProfile): void {
	if (ctx.hasUI) {
		ctx.ui.setWidget("quickfix", [
			`Quick-fix active (${profile.label}). Return with /end-quickfix.`,
		]);
	}
}

function clearQuickfixState(ctx: ExtensionContext): void {
	activeQuickfix = undefined;
	if (ctx.hasUI) {
		ctx.ui.setWidget("quickfix", undefined);
	}
}

function findFirstUserMessage(entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>) {
	return entries.find((entry) => entry.type === "message" && entry.message.role === "user");
}

function hasActiveQuickfixOnBranch(
	entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
	markerId: string | undefined,
): boolean {
	return markerId !== undefined && entries.some((entry) => entry.id === markerId);
}

function isActiveQuickfixOnCurrentBranch(ctx: ExtensionContext): boolean {
	return activeQuickfix?.phase === "active"
		&& activeQuickfix.sessionId === ctx.sessionManager.getSessionId()
		&& hasActiveQuickfixOnBranch(ctx.sessionManager.getBranch(), activeQuickfix.markerId);
}

function isEnteringQuickfixSubmission(ctx: ExtensionContext, state: ActiveQuickfix): boolean {
	const leafId = ctx.sessionManager.getLeafId();
	if (!leafId) {
		return false;
	}
	const leaf = ctx.sessionManager.getBranch().find((entry) => entry.id === leafId);
	return leaf?.type === "message"
		&& leaf.message.role === "user"
		&& leaf.message.content === state.initialPrompt;
}

function syncQuickfixState(ctx: ExtensionContext): void {
	if (!isActiveQuickfixOnCurrentBranch(ctx)) {
		clearQuickfixState(ctx);
		return;
	}
	setQuickfixWidget(ctx, getQuickfixProfile(activeQuickfix!.profile));
}

async function selectQuickfixProfile(ctx: ExtensionCommandContext): Promise<QuickfixProfileId | undefined> {
	const labels = QUICKFIX_PROFILE_OPTIONS.map((profile) => profile.label);
	const selected = await ctx.ui.select("Select a quick-fix profile:", labels);
	return QUICKFIX_PROFILE_OPTIONS.find((profile) => profile.label === selected)?.id;
}

function findMissingSkills(ctx: ExtensionCommandContext, profile: QuickfixProfile): string[] {
	const available = new Set((ctx.getSystemPromptOptions().skills ?? []).map((skill) => skill.name));
	return profile.skills.filter((skill) => !available.has(skill));
}

const SAFE_CLASSIFIER_FAILURE_MESSAGES = new Map([
	["No active model for quick-fix classification", "Quick-fix classification needs an active model. Select a profile to continue."],
	["Quick-fix classification aborted", "Quick-fix classification was cancelled. Select a profile to continue."],
	["Quick-fix classification error", "Quick-fix classification failed. Select a profile to continue."],
	["Quick-fix classifier returned no text", "Quick-fix classifier returned no result. Select a profile to continue."],
	["Invalid quick-fix classifier markers", "Quick-fix classifier returned an invalid result. Select a profile to continue."],
	["Quick-fix classifier summary is empty", "Quick-fix classifier returned an invalid result. Select a profile to continue."],
	["Duplicate quick-fix classifier markers", "Quick-fix classifier returned an invalid result. Select a profile to continue."],
]);

function classifierErrorForUser(error: string): string {
	return SAFE_CLASSIFIER_FAILURE_MESSAGES.get(error)
		?? "Quick-fix classification failed. Select a profile to continue.";
}

export default function registerQuickfix(
	pi: ExtensionAPI,
	dependencies: QuickfixDependencies = defaultDependencies,
): void {
	pi.on("before_agent_start", async (event, ctx) => {
		if (!activeQuickfix) {
			return undefined;
		}

		if (activeQuickfix.phase === "entering") {
			const markerId = ctx.sessionManager.getLeafId();
			if (!markerId) {
				clearQuickfixState(ctx);
				return undefined;
			}
			activeQuickfix = { ...activeQuickfix, markerId, phase: "active" };
		} else if (!isActiveQuickfixOnCurrentBranch(ctx)) {
			clearQuickfixState(ctx);
			return undefined;
		}

		const state = activeQuickfix;
		if (!state || state.phase !== "active") {
			return undefined;
		}

		try {
			const { formatSkillsForPrompt } = await dependencies.loadPiPromptModule();
			const result = filterQuickfixSystemPrompt({
				systemPrompt: event.systemPrompt,
				options: event.systemPromptOptions,
				profile: getQuickfixProfile(state.profile),
				formatSkillsForPrompt,
			});
			if (result.ok) {
				return { systemPrompt: result.systemPrompt };
			}
			notify(ctx, result.error, "error");
		} catch {
			notify(ctx, "Quick-fix prompt filtering failed.", "error");
		}

		return {
			systemPrompt: [
				QUICKFIX_CONTRACT,
				"Quick-fix prompt filtering failed. Do not edit files. Report the configuration error and ask the user to run /end-quickfix.",
			].join("\n\n"),
		};
	});

	pi.on("tool_call", (event, ctx) => {
		if (!isActiveQuickfixOnCurrentBranch(ctx) || !QUICKFIX_BLOCKED_TOOLS.has(event.toolName)) {
			return undefined;
		}
		return {
			block: true,
			reason: "Quick-fix mode does not permit nested orchestration. Complete the bounded fix directly or report NEEDS_NORMAL_WORKFLOW.",
		};
	});

	pi.on("session_tree", (_event, ctx) => {
		if (activeQuickfix?.phase === "entering") {
			if (!quickfixStartInProgress && !isEnteringQuickfixSubmission(ctx, activeQuickfix)) {
				clearQuickfixState(ctx);
			}
			return;
		}
		if (activeQuickfix?.phase === "active" && !isActiveQuickfixOnCurrentBranch(ctx)) {
			clearQuickfixState(ctx);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearQuickfixState(ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		syncQuickfixState(ctx);
	});

	pi.registerCommand("quickfix", {
		description: "Start an interactive bounded quick-fix branch.",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				notify(ctx, "/quickfix requires interactive mode.", "error");
				return;
			}
			if (activeQuickfix || quickfixStartInProgress) {
				notify(ctx, "A quick-fix lifecycle is already active.", "warning");
				return;
			}

			const parsed = parseQuickfixCommand(args);
			if (parsed.error) {
				notify(ctx, parsed.error, "error");
				return;
			}

			let request = parsed.request;
			if (!request) {
				const input = await ctx.ui.input("Describe the bounded quick fix:");
				request = input?.trim() ?? "";
				if (!request) {
					return;
				}
			}

			const sessionId = ctx.sessionManager.getSessionId();
			const originId = ctx.sessionManager.getLeafId();
			const branch = ctx.sessionManager.getBranch();
			const firstUserMessage = findFirstUserMessage(branch);
			const classifierContext = serializeQuickfixBranch(ctx.sessionManager.buildContextEntries());
			if (!originId || !firstUserMessage) {
				notify(ctx, "Quick-fix branch entry is unavailable for an empty session.", "error");
				return;
			}

			quickfixStartInProgress = true;
			let profileId = parsed.profile;
			let summary: string | undefined;
			try {
				const classification = await classifyQuickfix(ctx, request, classifierContext);
				if (classification.ok) {
					summary = classification.value.summary;
					if (!profileId && classification.value.confidence === "high" && classification.value.profile !== "ambiguous") {
						profileId = classification.value.profile;
					}
				} else if (!profileId) {
					notify(ctx, classifierErrorForUser(classification.error), "warning");
				}

				if (!profileId) {
					if (classification.ok) {
						notify(ctx, "Quick-fix classification needs profile selection.", "info");
					}
					profileId = await selectQuickfixProfile(ctx);
					if (!profileId) {
						return;
					}
				}

				const profile = getQuickfixProfile(profileId);
				const missingSkills = findMissingSkills(ctx, profile);
				if (missingSkills.length > 0) {
					notify(ctx, `Missing quick-fix skills: ${missingSkills.join(", ")}`, "error");
					return;
				}

				const initialPrompt = buildQuickfixInitialPrompt({ request, summary, profile });
				const lifecycleResult = await startQuickfixLifecycle({
					navigateToBranch: async () => {
						try {
							const result = await ctx.navigateTree(firstUserMessage.id, {
								summarize: false,
								label: `quickfix:${profile.id}`,
							});
							return result.cancelled
								? { ok: false as const, error: "Quick-fix navigation was cancelled.", cancelled: true }
								: { ok: true as const };
						} catch (error) {
							return {
								ok: false as const,
								error: `Failed to start quick-fix: ${error instanceof Error ? error.message : String(error)}`,
							};
						}
					},
					activateEntering: () => {
						activeQuickfix = {
							sessionId,
							originId,
							profile: profile.id,
							request,
							initialPrompt,
							...(summary ? { summary } : {}),
							phase: "entering",
						};
						setQuickfixWidget(ctx, profile);
					},
					dispatchInitialPrompt: async () => {
						pi.sendUserMessage(initialPrompt);
					},
					recoverEditor: () => {
						ctx.ui.setEditorText(initialPrompt);
					},
				});
				if (!lifecycleResult.ok) {
					notify(ctx, lifecycleResult.error, "error");
				}
			} finally {
				quickfixStartInProgress = false;
			}
		},
	});

	pi.registerCommand("end-quickfix", {
		description: "Return from the active quick-fix branch.",
		handler: async (_args, ctx) => {
			if (quickfixEndInProgress) {
				notify(ctx, "A quick-fix return is already in progress.", "warning");
				return;
			}

			const lockedState = activeQuickfix;
			if (!lockedState || (lockedState.phase !== "active" && lockedState.phase !== "entering")) {
				notify(ctx, "No active quick-fix branch to end.", "info");
				return;
			}

			quickfixEndInProgress = true;
			try {
				const result = await finishQuickfixLifecycle({
					waitForIdle: async () => {
						await ctx.waitForIdle();
						if (activeQuickfix !== lockedState || (lockedState.phase === "active" && !isActiveQuickfixOnCurrentBranch(ctx))) {
							throw new Error("Quick-fix state changed while waiting to return.");
						}
					},
					markReturning: () => {
						activeQuickfix = { ...lockedState, phase: "returning" };
					},
					navigateToOrigin: async () => {
						try {
							const navigation = await ctx.navigateTree(lockedState.originId, { summarize: false });
							return navigation.cancelled
								? { ok: false as const, error: "Navigation cancelled. Use /end-quickfix to try again.", cancelled: true }
								: { ok: true as const };
						} catch (error) {
							return {
								ok: false as const,
								error: `Failed to return: ${error instanceof Error ? error.message : String(error)}`,
							};
						}
					},
					restoreActive: () => {
						activeQuickfix = lockedState;
						setQuickfixWidget(ctx, getQuickfixProfile(lockedState.profile));
					},
					clearActive: () => clearQuickfixState(ctx),
				});
				if (!result.ok) {
					notify(ctx, result.error, result.cancelled ? "info" : "error");
					return;
				}
				notify(ctx, "Quick-fix complete! Returned to original position.", "info");
			} finally {
				quickfixEndInProgress = false;
			}
		},
	});
}
