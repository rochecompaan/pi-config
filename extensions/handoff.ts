/**
 * Handoff extension - transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), handoff extracts what matters
 * and creates a new session with a generated checkpoint.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *   /handoff check other places that need this fix
 *
 * Manual handoffs stage an editable draft. Automatic handoffs preserve detailed context before rollover.
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
	DEFAULT_AUTO_THRESHOLD_TOKENS,
	parseHandoffCommand,
	resolveAutoThresholdTokens,
	shouldTriggerAutoHandoff,
	transitionAutoHandoffState,
	type AutoHandoffState,
	type HandoffSettingsSources,
} from "./handoff-auto.ts";
import {
	generateHandoffPrompt,
	type GeneratedHandoff,
	type HandoffIntent,
} from "./handoff-generation.ts";
import { getLastAnswerCandidate } from "./handoff-answer.ts";

export type HandoffDependencies = {
	generatePrompt: (input: {
		ctx: ExtensionCommandContext;
		messages: AgentMessage[];
		preparationMessages?: AgentMessage[];
		intent: HandoffIntent;
	}) => Promise<GeneratedHandoff | null>;
	loadSettings: (ctx: ExtensionContext) => Promise<HandoffSettingsSources>;
	showAutoCountdown: (ctx: ExtensionCommandContext) => Promise<boolean>;
};

type AutomaticHandoffPreparation = {
	sourceMessages: AgentMessage[];
	preparationBoundaryEntryId: string;
	parentSession: string | undefined;
};

type PreparedAutomaticHandoff = {
	sourceMessages: AgentMessage[];
	preparationMessages: AgentMessage[];
	parentSession: string | undefined;
};

const AUTOMATIC_HANDOFF_PREPARATION_MESSAGE = `Prepare this session for automatic handoff. Do not continue implementation work and do not craft the final handoff prompt.

1. Review the objective, detailed requirements, acceptance criteria, decisions, constraints, progress, relevant files, blockers, and next steps.
2. Decide whether a concise handoff could safely preserve that information.
3. Use the todo tool now to inspect relevant existing todos when needed and create, update, or append detailed continuity todos when durable storage is warranted.
4. Do not create placeholder, duplicate, speculative, or unnecessary todos.
5. Finish with a short report listing every created or updated todo ID, or state that no continuity todo was warranted.`;

function isGeneratedHandoff(value: unknown): value is GeneratedHandoff {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<GeneratedHandoff>;
	return (
		candidate.action === "continue" ||
		candidate.action === "offer" ||
		candidate.action === "wait"
	) && typeof candidate.prompt === "string" &&
		(candidate.replayLastAnswer === undefined || typeof candidate.replayLastAnswer === "boolean");
}

function entryToMessage(entry: SessionEntry, includeCustomMessages: boolean): AgentMessage | undefined {
	if (includeCustomMessages && entry.type === "custom_message") {
		return {
			role: "custom",
			customType: entry.customType,
			content: entry.content,
			display: entry.display,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
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

function getEntriesAfterBoundary(
	branch: SessionEntry[],
	boundaryEntryId: string,
): SessionEntry[] | undefined {
	const boundaryIndex = branch.findIndex((entry) => entry.id === boundaryEntryId);
	return boundaryIndex >= 0 ? branch.slice(boundaryIndex + 1) : undefined;
}

function hasMessageRole(entries: SessionEntry[], role: "user"): boolean {
	return entries.some((entry) => entry.type === "message" && entry.message.role === role);
}

function getPreparationAssistantStatus(
	entries: SessionEntry[],
): "missing" | "failed" | "completed" {
	let lastStopReason: string | undefined;
	let found = false;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		found = true;
		lastStopReason = entry.message.stopReason;
	}
	if (!found) return "missing";
	return lastStopReason === "aborted" || lastStopReason === "error" || lastStopReason === "length"
		? "failed"
		: "completed";
}

function getHandoffMessages(branch: SessionEntry[], includeCustomMessages = false): AgentMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) {
		return branch.map((entry) => entryToMessage(entry, includeCustomMessages)).filter((message) => message !== undefined);
	}

	const compaction = branch[compactionIndex];
	const firstKeptIndex =
		compaction.type === "compaction" ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
	const compactedBranch = [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
	return compactedBranch.map((entry) => entryToMessage(entry, includeCustomMessages)).filter((message) => message !== undefined);
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
	generatePrompt: generateHandoffPrompt,
};

export function registerHandoffExtension(
	pi: ExtensionAPI,
	dependencies: HandoffDependencies = defaultDependencies,
): void {
	let autoState: AutoHandoffState = "armed";
	let autoThresholdTokens = DEFAULT_AUTO_THRESHOLD_TOKENS;
	let automaticPreparation: AutomaticHandoffPreparation | undefined;
	const disableAutomatic = (
		ctx: ExtensionContext,
		message: string,
		level: "info" | "error" = "error",
	): void => {
		automaticPreparation = undefined;
		autoState = transitionAutoHandoffState(autoState, { type: "attempt-failed" });
		ctx.ui.notify(`${message} Run /handoff auto on to re-enable it.`, level);
	};

	const performHandoff = async (
		intent: HandoffIntent,
		ctx: ExtensionCommandContext,
		preparedAutomatic?: PreparedAutomaticHandoff,
	): Promise<void> => {
		const automatic = intent.kind === "automatic";
		if (!ctx.model) {
			if (automatic) disableAutomatic(ctx, "No model selected.");
			else ctx.ui.notify("No model selected", "error");
			return;
		}
		const messages = preparedAutomatic?.sourceMessages ?? getHandoffMessages(ctx.sessionManager.getBranch());
		if (messages.length === 0) {
			if (automatic) disableAutomatic(ctx, "No conversation to hand off.");
			else ctx.ui.notify("No conversation to hand off", "error");
			return;
		}
		const currentSessionFile = preparedAutomatic?.parentSession ?? ctx.sessionManager.getSessionFile();
		let generatedResult: Awaited<ReturnType<HandoffDependencies["generatePrompt"]>>;
		try {
			generatedResult = await dependencies.generatePrompt({
				ctx,
				messages,
				preparationMessages: preparedAutomatic?.preparationMessages,
				intent,
			});
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
		if (generatedResult === null) {
			if (automatic) disableAutomatic(ctx, "Handoff generation cancelled.", "info");
			else ctx.ui.notify("Cancelled", "info");
			return;
		}
		if (!isGeneratedHandoff(generatedResult)) {
			if (automatic) disableAutomatic(ctx, "Handoff generation returned an invalid action.");
			else ctx.ui.notify("Handoff generation returned an invalid action.", "error");
			return;
		}
		const { action: handoffAction, prompt: generatedPrompt } = generatedResult;
		if (generatedPrompt.trim().length === 0) {
			if (automatic) {
				disableAutomatic(ctx, "Handoff generation returned an empty prompt.");
			} else {
				ctx.ui.notify("Handoff generation returned an empty prompt.", "error");
			}
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
		const answer = automatic && generatedResult.replayLastAnswer === true
			? getLastAnswerCandidate(messages) : undefined;
		const replayContent = answer === undefined ? undefined : `Answer from previous session:\n\n${answer}`;
		const fallbackPrompt = replayContent === undefined ? stagedPrompt : `${stagedPrompt}\n\n${replayContent}`;
		const parentSession = currentSessionFile;
		let newSessionResult: Awaited<ReturnType<typeof ctx.newSession>>;
		try {
			newSessionResult = await ctx.newSession({
				parentSession,
				withSession: async (replacementCtx) => {
					if (automatic) {
						if (handoffAction === "wait") {
							try {
								await replacementCtx.sendMessage({
									customType: "handoff-context",
									content: stagedPrompt,
									display: true,
								}, { triggerTurn: false });
							} catch (error) {
								replacementCtx.ui.setEditorText(fallbackPrompt);
								replacementCtx.ui.notify(
									`Automatic handoff context injection failed: ${error instanceof Error ? error.message : String(error)}. Checkpoint staged; no agent turn was started.`,
									"error",
								);
								return;
							}
						}
						if (replayContent !== undefined) {
							try {
								await replacementCtx.sendMessage({
									customType: "handoff-answer",
									content: replayContent,
									display: true,
								}, { triggerTurn: false });
							} catch (error) {
								replacementCtx.ui.setEditorText(fallbackPrompt);
								replacementCtx.ui.notify(
									`Automatic handoff answer replay failed: ${error instanceof Error ? error.message : String(error)}. Checkpoint and answer staged; no agent turn was started.`,
									"error",
								);
								return;
							}
						}
						if (handoffAction === "wait") return;
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

	const startAutomaticPreparation = (ctx: ExtensionCommandContext): void => {
		if (!ctx.model) {
			disableAutomatic(ctx, "No model selected.");
			return;
		}
		const branch = ctx.sessionManager.getBranch();
		const sourceMessages = getHandoffMessages(branch, true);
		const preparationBoundaryEntryId = ctx.sessionManager.getLeafId();
		if (sourceMessages.length === 0) {
			disableAutomatic(ctx, "No conversation to hand off.");
			return;
		}
		if (!preparationBoundaryEntryId) {
			disableAutomatic(ctx, "Automatic handoff could not mark the preparation boundary.");
			return;
		}
		automaticPreparation = {
			sourceMessages,
			preparationBoundaryEntryId,
			parentSession: ctx.sessionManager.getSessionFile(),
		};
		autoState = transitionAutoHandoffState(autoState, { type: "preparation-started" });
		try {
			pi.sendMessage({
				customType: "handoff-preparation",
				content: AUTOMATIC_HANDOFF_PREPARATION_MESSAGE,
				display: true,
			}, { triggerTurn: true });
		} catch (error) {
			disableAutomatic(
				ctx,
				`Automatic handoff preparation failed: ${error instanceof Error ? error.message : String(error)}.`,
			);
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

	const dispatchAutomaticFinalization = (ctx: ExtensionContext): void => {
		try {
			pi.sendUserMessage("/handoff --auto-finalize", { expandPromptTemplates: true });
		} catch (error) {
			disableAutomatic(
				ctx,
				`Automatic handoff finalization failed: ${error instanceof Error ? error.message : String(error)}.`,
			);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		automaticPreparation = undefined;
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
		if (autoState === "preparing") {
			if (!automaticPreparation) {
				disableAutomatic(ctx, "Automatic handoff lost its preparation state.");
				return;
			}
			const preparationEntries = getEntriesAfterBoundary(
				ctx.sessionManager.getBranch(),
				automaticPreparation.preparationBoundaryEntryId,
			);
			if (!preparationEntries) {
				disableAutomatic(ctx, "Automatic handoff preparation branch changed.");
				return;
			}
			if (hasMessageRole(preparationEntries, "user")) {
				disableAutomatic(ctx, "Automatic handoff stopped because a user message arrived during preparation.");
				return;
			}
			const assistantStatus = getPreparationAssistantStatus(preparationEntries);
			if (assistantStatus === "failed") {
				disableAutomatic(ctx, "Automatic handoff preparation did not complete.");
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages() || assistantStatus === "missing") return;
			autoState = transitionAutoHandoffState(autoState, { type: "preparation-settled" });
			dispatchAutomaticFinalization(ctx);
			return;
		}
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
					automaticPreparation = undefined;
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
				if (autoState === "preparing" || autoState === "finalizing") {
					ctx.ui.notify(
						`Automatic handoff is already ${autoState}. Use /handoff auto off to cancel it.`,
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
				if (autoState === "countdown") dispatchAutomaticHandoff(ctx);
				return;
			}
			if (command.kind === "internal-auto") {
				if (autoState !== "countdown") return;
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
				startAutomaticPreparation(ctx);
				return;
			}
			if (command.kind === "internal-auto-finalize") {
				if (autoState !== "finalizing" || !automaticPreparation) return;
				const capture = automaticPreparation;
				const preparationEntries = getEntriesAfterBoundary(
					ctx.sessionManager.getBranch(),
					capture.preparationBoundaryEntryId,
				);
				if (!preparationEntries) {
					disableAutomatic(ctx, "Automatic handoff preparation result is no longer available.");
					return;
				}
				if (hasMessageRole(preparationEntries, "user")) {
					disableAutomatic(ctx, "Automatic handoff stopped because a user message arrived during preparation.");
					return;
				}
				if (getPreparationAssistantStatus(preparationEntries) !== "completed") {
					disableAutomatic(ctx, "Automatic handoff preparation did not complete.");
					return;
				}
				automaticPreparation = undefined;
				const preparationMessages = getHandoffMessages(preparationEntries);
				await performHandoff({ kind: "automatic" }, ctx, {
					sourceMessages: capture.sourceMessages,
					preparationMessages,
					parentSession: capture.parentSession,
				});
				return;
			}
			if (command.kind === "missing-goal") {
				ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
				return;
			}
			await performHandoff({ kind: "manual", goal: command.goal }, ctx);
		},
	});
}

export default registerHandoffExtension;
