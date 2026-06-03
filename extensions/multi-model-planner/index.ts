import {
	DefaultResourceLoader,
	SessionManager,
	createAgentSession,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
	checkTeamAvailability,
	createAvailabilityStore,
	ensureAvailabilityChecked,
	refreshAvailabilityCache,
	type AvailabilityModelRegistry,
	type AvailabilityStore,
} from "./availability.ts";
import { loadAgentDefinitions } from "./agent-loader.ts";
import { orchestrateTeamRun } from "./orchestrator.ts";
import { buildMemberResourceLoaderOptions } from "./resource-loader.ts";
import { getTeamConfig, loadTeamConfigs, type TeamConfigRegistry } from "./team-config.ts";
import {
	getAllowedBuiltInToolNames,
	resolveBuiltInTools,
} from "./tool-resolver.ts";
import { renderTranscriptText } from "./transcript.ts";
import type {
	ResolvedTeamConfig,
	RunTeamProgressDetails,
	RunTeamToolDetails,
	TeamAvailability,
	TeamTranscript,
} from "./types.ts";

interface ToolContentPart {
	type: "text";
	text: string;
}

interface ToolResultLike<TDetails = unknown> {
	content: ToolContentPart[];
	details?: TDetails;
}

interface TextComponentLike {
	render(width: number): string[];
	invalidate(): void;
}

interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface ModelLike {
	provider?: string;
	id?: string;
}

interface ModelRegistryLike {
	find(provider: string, modelId: string): ModelLike | undefined;
	getApiKeyAndHeaders(model: ModelLike): Promise<{ ok: boolean; error?: string }>;
}

interface ExtensionContextLike {
	cwd: string;
	hasUI?: boolean;
	modelRegistry: ModelRegistryLike;
	ui: {
		notify(message: string, level: string): void;
		custom?<T>(
			factory: (tui: unknown, theme: ThemeLike, keybindings: unknown, done: (result: T | undefined) => void) => TextComponentLike & {
				handleInput?(data: string): void;
			},
			options?: Record<string, unknown>,
		): Promise<T | undefined>;
	};
	sessionManager: Record<string, unknown>;
}

interface SessionManagerFactoryLike {
	inMemory(): unknown;
}

interface ResourceLoaderLike {
	reload(): Promise<void>;
}

interface ResourceLoaderConstructorLike {
	new (options: Record<string, unknown>): ResourceLoaderLike;
}

interface AgentSessionLike {
	messages: unknown[];
	subscribe(listener: (event: unknown) => void): () => void;
	prompt(text: string, mode?: "draft" | "discussion" | "synthesis"): Promise<void>;
	dispose(): void;
	abort(): Promise<void>;
	setThinkingLevel?(level: string): void;
}

interface CreateAgentSessionLike {
	(options: Record<string, unknown>): Promise<{ session: AgentSessionLike }>;
}

interface SchemaLike {
	Object(properties: Record<string, unknown>): unknown;
	String(options?: Record<string, unknown>): unknown;
}

interface CommandContextLike extends ExtensionContextLike {}

interface ExtensionApiLike {
	on(event: string, handler: (event: unknown, ctx: ExtensionContextLike) => unknown): void;
	registerTool(definition: Record<string, unknown>): void;
	registerCommand(name: string, options: Record<string, unknown>): void;
	appendEntry(customType: string, data: unknown): void;
}

export interface PlannerDependencies {
	schema: SchemaLike;
	createTextComponent: (text: string) => TextComponentLike;
	createAgentSession: CreateAgentSessionLike;
	DefaultResourceLoader: ResourceLoaderConstructorLike;
	SessionManager: SessionManagerFactoryLike;
	getAllowedBuiltInToolNames: typeof getAllowedBuiltInToolNames;
	loadAgentDefinitions: typeof loadAgentDefinitions;
	loadTeamConfigs: typeof loadTeamConfigs;
	getTeamConfig: typeof getTeamConfig;
	createAvailabilityStore: typeof createAvailabilityStore;
	ensureAvailabilityChecked: typeof ensureAvailabilityChecked;
	refreshAvailabilityCache: typeof refreshAvailabilityCache;
	checkTeamAvailability: typeof checkTeamAvailability;
	orchestrateTeamRun: typeof orchestrateTeamRun;
	resolveBuiltInTools: typeof resolveBuiltInTools;
	buildMemberResourceLoaderOptions: typeof buildMemberResourceLoaderOptions;
	renderTranscriptText: typeof renderTranscriptText;
	now: () => number;
}

interface LoadedPlannerContext {
	teams: TeamConfigRegistry;
}

interface RunTeamToolResultDetails extends RunTeamToolDetails {
	ok: boolean;
	error?: string;
}

type RunTeamRenderDetails = RunTeamToolResultDetails | RunTeamProgressDetails;

export function createMultiModelPlannerExtension(
	deps: PlannerDependencies = createDefaultPlannerDependencies(),
) {
	let availabilityStore = deps.createAvailabilityStore();

	return function multiModelPlannerExtension(pi: ExtensionApiLike): void {
		const resetAvailabilityState = () => {
			availabilityStore = deps.createAvailabilityStore();
		};

		pi.on("session_start", resetAvailabilityState);

		pi.registerCommand("team-check", {
			description: "Check team model availability (all teams by default, or one named team)",
			handler: async (args: string, ctx: CommandContextLike) => {
				const planner = await loadPlannerContext(ctx.cwd, deps);
				const teamName = args.trim();

				let results: TeamAvailability[];
				if (teamName) {
					const team = deps.getTeamConfig(planner.teams, teamName);
					const availability = await deps.checkTeamAvailability({
						team,
						modelRegistry: createAvailabilityModelRegistry(ctx.modelRegistry),
					});
					results = [availability];
					mergeAvailabilityResults(availabilityStore, results, deps.now());
				} else {
					const cache = await deps.refreshAvailabilityCache({
						teams: planner.teams.ordered,
						modelRegistry: createAvailabilityModelRegistry(ctx.modelRegistry),
						store: availabilityStore,
					});
					results = Object.values(cache.byTeam).sort((left, right) => left.team.localeCompare(right.team));
				}

				await showAvailabilitySummary(results, ctx, deps);
			},
		});

		pi.registerTool({
			name: "run_team",
			label: "Run Team",
			description: "Run a named multi-model team through Draft, Discussion Round 1, Discussion Round 2, and Synthesis.",
			parameters: deps.schema.Object({
				task: deps.schema.String({ description: "The task for the team to solve." }),
				team: deps.schema.String({ description: "The explicit team name to run." }),
			}),
			async execute(_toolCallId: string, params: { task: string; team: string }, _signal: AbortSignal | undefined, onUpdate: ((update: Partial<ToolResultLike<RunTeamRenderDetails>>) => void) | undefined, ctx: ExtensionContextLike): Promise<ToolResultLike<RunTeamToolResultDetails>> {
				onUpdate?.({
					content: [{ type: "text", text: `Preparing team \"${params.team}\"...` }],
				});

				const planner = await loadPlannerContext(ctx.cwd, deps);
				const team = deps.getTeamConfig(planner.teams, params.team);
				const availability = await getAvailabilityForRun({
					team,
					teams: planner.teams.ordered,
					store: availabilityStore,
					modelRegistry: ctx.modelRegistry,
					deps,
				});

				onUpdate?.({
					content: [{ type: "text", text: `Running team \"${team.name}\"...` }],
				});

				const outcome = await deps.orchestrateTeamRun(
					{
						cwd: ctx.cwd,
						team,
						task: params.task,
						availability,
						onProgress: (update) => {
							onUpdate?.({
								content: [{ type: "text", text: `Running team \"${team.name}\"...` }],
								details: {
									version: 1,
									progress: update.progress,
									transcript: update.transcript,
									availability: update.availability,
								},
							});
						},
					},
					{
						createSession: ({ member, purpose }) =>
							createManagedTeamSession({
								cwd: ctx.cwd,
								team,
								member,
								purpose,
								modelRegistry: ctx.modelRegistry,
								deps,
							}),
					},
				);

				pi.appendEntry("multi-model-planner:comm", {
					runId: outcome.result.runId,
					team: outcome.result.team,
					task: params.task,
					entries: outcome.details.comm.entries,
					summary: outcome.details.comm.summary,
					timestamp: deps.now(),
				});

				const details: RunTeamToolResultDetails = {
					...outcome.details,
					ok: outcome.ok,
					error: outcome.error,
				};

				return {
					content: [{ type: "text", text: formatRunSummary(details) }],
					details,
				};
			},
			renderCall(args: { team?: string; task?: string }, theme: ThemeLike) {
				const title = theme.fg("toolTitle", theme.bold("run_team"));
				const teamLabel = theme.fg("accent", args.team ?? "(missing team)");
				const taskPreview = args.task ? ` — ${compactPreview(args.task, 80)}` : "";
				return deps.createTextComponent(`${title} ${teamLabel}${taskPreview}`);
			},
			renderResult(result: ToolResultLike<RunTeamRenderDetails>, options: { expanded?: boolean; isPartial?: boolean }, _theme: ThemeLike) {
				if (result.details?.transcript) {
					const transcript = deps.renderTranscriptText(result.details.transcript as TeamTranscript, {
						availabilityChecked: Boolean(result.details.availability),
					});
					return deps.createTextComponent(transcript);
				}

				if (options.isPartial) {
					return deps.createTextComponent(result.content.find((part) => part.type === "text")?.text ?? "Running team...");
				}

				return deps.createTextComponent(result.content.find((part) => part.type === "text")?.text ?? "");
			},
		});
	};
}

export default createMultiModelPlannerExtension();

function createDefaultPlannerDependencies(): PlannerDependencies {
	return {
		schema: Type as SchemaLike,
		createTextComponent: (text: string) => new Text(text, 0, 0),
		createAgentSession: createAgentSession as CreateAgentSessionLike,
		DefaultResourceLoader: DefaultResourceLoader as ResourceLoaderConstructorLike,
		SessionManager: SessionManager as SessionManagerFactoryLike,
		getAllowedBuiltInToolNames,
		loadAgentDefinitions,
		loadTeamConfigs,
		getTeamConfig,
		createAvailabilityStore,
		ensureAvailabilityChecked,
		refreshAvailabilityCache,
		checkTeamAvailability,
		orchestrateTeamRun,
		resolveBuiltInTools,
		buildMemberResourceLoaderOptions,
		renderTranscriptText,
		now: () => Date.now(),
	};
}

async function loadPlannerContext(cwd: string, deps: PlannerDependencies): Promise<LoadedPlannerContext> {
	const agents = await deps.loadAgentDefinitions({
		cwd,
		allowedToolNames: deps.getAllowedBuiltInToolNames(),
	});
	const teams = await deps.loadTeamConfigs({ cwd, agents });
	return { teams };
}

async function getAvailabilityForRun(input: {
	team: ResolvedTeamConfig;
	teams: ReadonlyArray<ResolvedTeamConfig>;
	store: AvailabilityStore;
	modelRegistry: ModelRegistryLike;
	deps: PlannerDependencies;
}): Promise<TeamAvailability> {
	if (!input.store.hasChecked) {
		await input.deps.ensureAvailabilityChecked({
			teams: input.teams,
			modelRegistry: createAvailabilityModelRegistry(input.modelRegistry),
			store: input.store,
		});
	}

	const cached = input.store.cache?.byTeam[input.team.name.trim().toLowerCase()];
	if (cached) {
		return cached;
	}

	const availability = await input.deps.checkTeamAvailability({
		team: input.team,
		modelRegistry: createAvailabilityModelRegistry(input.modelRegistry),
	});
	mergeAvailabilityResults(input.store, [availability], input.deps.now());
	return availability;
}

function mergeAvailabilityResults(
	store: AvailabilityStore,
	results: TeamAvailability[],
	checkedAt: number,
): void {
	const nextByTeam = {
		...(store.cache?.byTeam ?? {}),
	};
	for (const result of results) {
		nextByTeam[result.team.trim().toLowerCase()] = result;
	}
	store.cache = {
		checkedAt,
		byTeam: nextByTeam,
	};
	store.hasChecked = true;
}

function createAvailabilityModelRegistry(modelRegistry: ModelRegistryLike): AvailabilityModelRegistry {
	return {
		async checkModel(modelRef: string) {
			const parsed = parseModelReference(modelRef);
			if (!parsed) {
				return {
					available: false,
					reason: `Invalid model reference \"${modelRef}\". Expected provider/model.`,
				};
			}

			const model = modelRegistry.find(parsed.provider, parsed.id);
			if (!model) {
				return {
					available: false,
					reason: `Model \"${modelRef}\" is not registered.`,
				};
			}

			const auth = await modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				return { available: false, reason: auth.error };
			}

			return { available: true };
		},
	};
}

function parseModelReference(modelRef: string): { provider: string; id: string } | null {
	const slashIndex = modelRef.indexOf("/");
	if (slashIndex <= 0 || slashIndex === modelRef.length - 1) {
		return null;
	}
	return {
		provider: modelRef.slice(0, slashIndex),
		id: modelRef.slice(slashIndex + 1),
	};
}

async function createManagedTeamSession(input: {
	cwd: string;
	team: ResolvedTeamConfig;
	member: ResolvedTeamConfig["members"][number];
	purpose: "phase" | "synthesis";
	modelRegistry: ModelRegistryLike;
	deps: PlannerDependencies;
}): Promise<{ memberKey: string; memberName: string; model: string; session: AgentSessionLike }> {
	const model = resolveModel(input.modelRegistry, input.member.model);
	const resourceLoader = new input.deps.DefaultResourceLoader(
		input.deps.buildMemberResourceLoaderOptions({
			cwd: input.cwd,
			systemPrompt: input.member.agent.systemPrompt,
		}),
	);
	await resourceLoader.reload();

	const tools = input.deps.resolveBuiltInTools({
		agent: input.member.agent,
	});

	const initialThinking =
		input.purpose === "synthesis"
			? mapTeamThinkingLevel(input.team.thinking.synthesis)
			: mapTeamThinkingLevel(input.team.thinking.draft);

	const { session } = await input.deps.createAgentSession({
		cwd: input.cwd,
		model,
		modelRegistry: input.modelRegistry,
		thinkingLevel: initialThinking,
		tools,
		resourceLoader,
		sessionManager: input.deps.SessionManager.inMemory(),
	});

	const wrappedSession = wrapSessionWithThinking(session, {
		draft: mapTeamThinkingLevel(input.team.thinking.draft),
		discussion: mapTeamThinkingLevel(input.team.thinking.discussion),
		synthesis: mapTeamThinkingLevel(input.team.thinking.synthesis),
		defaultMode: input.purpose === "synthesis" ? "synthesis" : "draft",
	});

	return {
		memberKey: input.member.key,
		memberName: input.member.name,
		model: input.member.model,
		session: wrappedSession,
	};
}

function resolveModel(modelRegistry: ModelRegistryLike, modelRef: string): ModelLike {
	const parsed = parseModelReference(modelRef);
	if (!parsed) {
		throw new Error(`Invalid model reference \"${modelRef}\". Expected provider/model.`);
	}
	const model = modelRegistry.find(parsed.provider, parsed.id);
	if (!model) {
		throw new Error(`Model \"${modelRef}\" is not registered.`);
	}
	return model;
}

function wrapSessionWithThinking(
	session: AgentSessionLike,
	thinking: { draft: string; discussion: string; synthesis: string; defaultMode: "draft" | "synthesis" },
): AgentSessionLike {
	return {
		get messages() {
			return session.messages;
		},
		subscribe(listener) {
			return session.subscribe(listener);
		},
		async prompt(text: string, mode = thinking.defaultMode) {
			session.setThinkingLevel?.(
				mode === "synthesis"
					? thinking.synthesis
					: mode === "discussion"
						? thinking.discussion
						: thinking.draft,
			);
			return session.prompt(text);
		},
		dispose() {
			session.dispose();
		},
		abort() {
			return session.abort();
		},
	};
}

function mapTeamThinkingLevel(level: string): string {
	switch (level) {
		case "highest":
			return "xhigh";
		case "off":
		case "low":
		case "medium":
		case "high":
			return level;
		default:
			return "medium";
	}
}

function compactPreview(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatRunSummary(details: RunTeamToolResultDetails): string {
	const headline = details.ok
		? `Team \"${details.result.team}\" completed successfully.`
		: `Team \"${details.result.team}\" failed: ${details.error ?? "unknown error"}`;
	const stats =
		`Run ${details.result.runId} · ${details.result.agents.length} agents · ` +
		`${details.result.summary.totalEntries} entries · ` +
		`${details.result.summary.totalTokensIn} in / ${details.result.summary.totalTokensOut} out · ` +
		`${details.result.summary.totalDurationMs}ms`;
	const preview = details.result.finalOutput.trim()
		? `\n\nFinal output preview:\n${compactPreview(details.result.finalOutput, 400)}`
		: "";
	return `${headline}\n${stats}${preview}`;
}

function availabilityHasProblems(results: ReadonlyArray<TeamAvailability>): boolean {
	return results.some((result) => result.unavailableMembers.length > 0 || !result.consensusModelAvailable);
}

async function showAvailabilitySummary(
	results: ReadonlyArray<TeamAvailability>,
	ctx: CommandContextLike,
	deps: PlannerDependencies,
): Promise<void> {
	if (!ctx.hasUI || !ctx.ui.custom) {
		ctx.ui.notify(formatAvailabilitySummary(results), availabilityHasProblems(results) ? "warning" : "info");
		return;
	}

	await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
		const text = deps.createTextComponent(formatAvailabilitySummaryThemed(results, theme));
		return {
			render(width: number) {
				return text.render(width);
			},
			invalidate() {
				text.invalidate();
			},
			handleInput() {
				done(undefined);
			},
		};
	});
}

function formatAvailabilitySummary(results: ReadonlyArray<TeamAvailability>): string {
	return results.map(formatAvailabilityBlock).join("\n\n");
}

function formatAvailabilitySummaryThemed(results: ReadonlyArray<TeamAvailability>, theme: ThemeLike): string {
	return [
		...results.flatMap((result, index) => {
			const lines = formatAvailabilityBlockThemed(result, theme).split("\n");
			return index === 0 ? lines : ["", ...lines];
		}),
		"",
		theme.fg("dim", "Press any key to close."),
	].join("\n");
}

function formatAvailabilityBlock(result: TeamAvailability): string {
	const members = [...result.availableMembers, ...result.unavailableMembers];
	const totalMembers = members.length;
	const readyMembers = result.availableMembers.length;
	const runnable = readyMembers >= 2 && result.consensusModelAvailable;
	const longestName = Math.max(4, ...members.map((member) => member.name.length));
	const lines = [
		formatAvailabilityHeading(result.team),
		`${runnable ? "run readiness: READY" : "run readiness: BLOCKED"}  ${readyMembers} / ${totalMembers} members ready · consensus model ${result.consensusModelAvailable ? "available" : "unavailable"}`,
		`consensus model: ${result.consensusModel || "(missing)"}`,
		"",
		...members.flatMap((member) => formatAvailabilityMember(member, longestName)),
	];

	const note = formatAvailabilityNote(result);
	if (note) {
		lines.push("", note);
	}

	return lines.join("\n");
}

function formatAvailabilityBlockThemed(result: TeamAvailability, theme: ThemeLike): string {
	const members = [...result.availableMembers, ...result.unavailableMembers];
	const totalMembers = members.length;
	const readyMembers = result.availableMembers.length;
	const runnable = readyMembers >= 2 && result.consensusModelAvailable;
	const longestName = Math.max(4, ...members.map((member) => member.name.length));
	const lines = [
		theme.fg("accent", theme.bold(formatAvailabilityHeading(result.team))),
		`${runnable ? theme.fg("success", "run readiness: READY") : theme.fg("error", "run readiness: BLOCKED")}  ${theme.fg("dim", `${readyMembers} / ${totalMembers} members ready · consensus model ${result.consensusModelAvailable ? "available" : "unavailable"}`)}`,
		`consensus model: ${result.consensusModelAvailable ? theme.fg("accent", result.consensusModel || "(missing)") : theme.fg("error", result.consensusModel || "(missing)")}`,
		"",
		...members.flatMap((member) => formatAvailabilityMemberThemed(member, longestName, theme)),
	];

	const note = formatAvailabilityNote(result);
	if (note) {
		lines.push("", theme.fg("warning", note));
	}

	return lines.join("\n");
}

function formatAvailabilityHeading(team: string): string {
	const width = 68;
	const prefix = `== ${team} `;
	return prefix.length >= width ? prefix.trimEnd() : `${prefix}${"=".repeat(width - prefix.length)}`;
}

function formatAvailabilityMember(
	member: TeamAvailability["availableMembers"][number] | TeamAvailability["unavailableMembers"][number],
	nameWidth: number,
): string[] {
	const status = member.available ? "OK" : "BLOCK";
	const lines = [
		`  ${status.padEnd(5)} ${member.name.padEnd(nameWidth)}  ${member.model}`,
	];
	if (!member.available && member.reason?.trim()) {
		lines.push(`         reason: ${member.reason.trim()}`);
	}
	return lines;
}

function formatAvailabilityMemberThemed(
	member: TeamAvailability["availableMembers"][number] | TeamAvailability["unavailableMembers"][number],
	nameWidth: number,
	theme: ThemeLike,
): string[] {
	const statusText = (member.available ? "OK" : "BLOCK").padEnd(5);
	const status = member.available ? theme.fg("success", statusText) : theme.fg("error", statusText);
	const lines = [
		`  ${status} ${theme.bold(member.name.padEnd(nameWidth))}  ${theme.fg(member.available ? "text" : "warning", member.model)}`,
	];
	if (!member.available && member.reason?.trim()) {
		lines.push(`         ${theme.fg("dim", `reason: ${member.reason.trim()}`)}`);
	}
	return lines;
}

function formatAvailabilityNote(result: TeamAvailability): string | null {
	if (result.availableMembers.length < 2) {
		return "note: fewer than 2 members are available, so the team cannot run.";
	}
	if (!result.consensusModelAvailable) {
		return "note: enough members are available to debate, but synthesis cannot run.";
	}
	return null;
}
