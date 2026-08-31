/**
 * Handoff extension - transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), handoff extracts what matters
 * for your next task and creates a new session with a generated prompt.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *   /handoff check other places that need this fix
 *
 * Manual handoffs stage an editable draft; automatic handoffs submit and continue.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	AUTO_HANDOFF_COUNTDOWN_SECONDS,
	AUTO_HANDOFF_GOAL,
	DEFAULT_AUTO_THRESHOLD_TOKENS,
	parseHandoffCommand,
	resolveAutoThresholdTokens,
	shouldTriggerAutoHandoff,
	transitionAutoHandoffState,
	type AutoHandoffState,
	type HandoffSettingsSources,
} from "./handoff-auto.ts";

export type HandoffDependencies = {
	generatePrompt: (input: {
		ctx: ExtensionCommandContext;
		messages: AgentMessage[];
		goal: string;
	}) => Promise<string | null>;
	loadSettings: (ctx: ExtensionContext) => Promise<HandoffSettingsSources>;
	showAutoCountdown: (ctx: ExtensionCommandContext) => Promise<boolean>;
};

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

function getHandoffMessages(branch: SessionEntry[]): AgentMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) {
		return branch.map(entryToMessage).filter((message) => message !== undefined);
	}

	const compaction = branch[compactionIndex];
	const firstKeptIndex =
		compaction.type === "compaction" ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
	const compactedBranch = [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
	return compactedBranch.map(entryToMessage).filter((message) => message !== undefined);
}

async function readJsonSettings(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

async function loadHandoffSettings(ctx: ExtensionContext): Promise<HandoffSettingsSources> {
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

async function showAutoCountdown(ctx: ExtensionCommandContext): Promise<boolean> {
	const { Key, matchesKey, truncateToWidth } = await import("@earendil-works/pi-tui");
	return ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
		let remaining = AUTO_HANDOFF_COUNTDOWN_SECONDS;
		let finished = false;
		let timer: ReturnType<typeof setInterval>;
		const finish = (result: boolean) => {
			if (finished) return;
			finished = true;
			clearInterval(timer);
			done(result);
		};
		timer = setInterval(() => {
			remaining -= 1;
			if (remaining <= 0) {
				finish(true);
				return;
			}
			tui.requestRender();
		}, 1000);
		return {
			render: (width: number) => [
				truncateToWidth(
					theme.fg("warning", `Automatic handoff starts in ${remaining}s. Press Esc to cancel.`),
					width,
				),
			],
			handleInput: (data: string) => {
				if (matchesKey(data, Key.escape)) finish(false);
			},
			invalidate: () => {},
		};
	});
}

const defaultDependencies: HandoffDependencies = {
	loadSettings: loadHandoffSettings,
	showAutoCountdown,
	generatePrompt: async (input) => {
		const { generateHandoffPrompt } = await import("./handoff-generation.ts");
		return generateHandoffPrompt(input);
	},
};

export function registerHandoffExtension(
	pi: ExtensionAPI,
	dependencies: HandoffDependencies = defaultDependencies,
): void {
	let autoState: AutoHandoffState = "armed";
	let autoThresholdTokens = DEFAULT_AUTO_THRESHOLD_TOKENS;
	const disableAutomatic = (
		ctx: ExtensionCommandContext,
		message: string,
		level: "info" | "error" = "error",
	): void => {
		autoState = transitionAutoHandoffState(autoState, { type: "attempt-failed" });
		ctx.ui.notify(`${message} Run /handoff auto on to re-enable it.`, level);
	};

	const performHandoff = async (
		goal: string,
		automatic: boolean,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		if (!ctx.model) {
			if (automatic) disableAutomatic(ctx, "No model selected.");
			else ctx.ui.notify("No model selected", "error");
			return;
		}
		const messages = getHandoffMessages(ctx.sessionManager.getBranch());
		if (messages.length === 0) {
			if (automatic) disableAutomatic(ctx, "No conversation to hand off.");
			else ctx.ui.notify("No conversation to hand off", "error");
			return;
		}
		const currentSessionFile = ctx.sessionManager.getSessionFile();
		let generatedPrompt: string | null;
		try {
			generatedPrompt = await dependencies.generatePrompt({ ctx, messages, goal });
		} catch (error) {
			if (automatic) {
				disableAutomatic(
					ctx,
					`Handoff generation failed: ${error instanceof Error ? error.message : String(error)}.`,
				);
				return;
			}
			throw error;
		}
		if (generatedPrompt === null) {
			if (automatic) disableAutomatic(ctx, "Handoff generation cancelled.", "info");
			else ctx.ui.notify("Cancelled", "info");
			return;
		}
		if (automatic && generatedPrompt.trim().length === 0) {
			disableAutomatic(ctx, "Handoff generation returned an empty prompt.");
			return;
		}
		const editedPrompt = automatic
			? generatedPrompt
			: await ctx.ui.editor("Edit handoff prompt", generatedPrompt);
		if (editedPrompt === undefined) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}
		const stagedPrompt = automatic ? generatedPrompt : editedPrompt;
		const parentSession = currentSessionFile;
		let newSessionResult: Awaited<ReturnType<typeof ctx.newSession>>;
		try {
			newSessionResult = await ctx.newSession({
				parentSession,
				withSession: async (replacementCtx) => {
					if (automatic) {
						try {
							await replacementCtx.sendUserMessage(stagedPrompt);
						} catch (error) {
							replacementCtx.ui.setEditorText(stagedPrompt);
							replacementCtx.ui.notify(
								`Automatic handoff submission failed: ${error instanceof Error ? error.message : String(error)}. Prompt staged; submit when ready.`,
								"error",
							);
						}
						return;
					}
					replacementCtx.ui.setEditorText(stagedPrompt);
					replacementCtx.ui.notify("Handoff ready. Submit when ready.", "info");
				},
			});
		} catch (error) {
			if (automatic) {
				disableAutomatic(
					ctx,
					`New session failed: ${error instanceof Error ? error.message : String(error)}.`,
				);
			} else {
				ctx.ui.notify("New session failed", "error");
			}
			return;
		}
		if (newSessionResult.cancelled) {
			if (automatic) disableAutomatic(ctx, "New session cancelled.", "info");
			else ctx.ui.notify("New session cancelled", "info");
		}
	};

	const dispatchAutomaticHandoff = (ctx: ExtensionContext): void => {
		try {
			pi.sendUserMessage("/handoff --auto", { expandPromptTemplates: true });
		} catch (error) {
			autoState = transitionAutoHandoffState(autoState, { type: "attempt-failed" });
			if (ctx.mode === "tui") {
				ctx.ui.notify(
					`Automatic handoff failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		autoState = transitionAutoHandoffState(autoState, { type: "session-start" });
		autoThresholdTokens = DEFAULT_AUTO_THRESHOLD_TOKENS;
		try {
			const settings = await dependencies.loadSettings(ctx);
			autoThresholdTokens = resolveAutoThresholdTokens(settings);
		} catch {
			// Keep the documented default and armed state.
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!shouldTriggerAutoHandoff({
			mode: ctx.mode,
			idle: ctx.isIdle(),
			state: autoState,
			usageTokens: usage?.tokens ?? undefined,
			thresholdTokens: autoThresholdTokens,
		})) return;

		autoState = transitionAutoHandoffState(autoState, { type: "threshold-reached" });
		dispatchAutomaticHandoff(ctx);
	});

	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}
			const command = parseHandoffCommand(args);
			if (command.kind === "auto-control") {
				if (command.action === "off") {
					autoState = transitionAutoHandoffState(autoState, { type: "auto-off" });
					ctx.ui.notify("Automatic handoff is disabled.", "info");
					return;
				}
				if (command.action === "status") {
					ctx.ui.notify(
						`Automatic handoff is ${autoState}. Threshold: ${autoThresholdTokens} tokens.`,
						"info",
					);
					return;
				}
				const usage = ctx.getContextUsage();
				autoState = transitionAutoHandoffState(autoState, {
					type: "auto-on",
					usageTokens: usage?.tokens ?? undefined,
					thresholdTokens: autoThresholdTokens,
				});
				ctx.ui.notify(`Automatic handoff is ${autoState}.`, "info");
				if (autoState === "running") dispatchAutomaticHandoff(ctx);
				return;
			}
			if (command.kind === "internal-auto") {
				if (autoState !== "running") return;
				let continueHandoff: boolean;
				try {
					continueHandoff = await dependencies.showAutoCountdown(ctx);
				} catch (error) {
					disableAutomatic(
						ctx,
						`Automatic handoff countdown failed: ${error instanceof Error ? error.message : String(error)}.`,
					);
					return;
				}
				if (!continueHandoff) {
					autoState = transitionAutoHandoffState(autoState, { type: "attempt-failed" });
					ctx.ui.notify("Automatic handoff cancelled. Run /handoff auto on to re-enable it.", "info");
					return;
				}
				await performHandoff(AUTO_HANDOFF_GOAL, true, ctx);
				return;
			}
			if (command.kind === "missing-goal") {
				ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
				return;
			}
			await performHandoff(command.goal, false, ctx);
		},
	});
}

export default registerHandoffExtension;
