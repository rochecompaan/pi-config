import { assertRunnableAvailability } from "./availability.ts";
import { buildCommLogPayload, generateNextRunId, writeRunArtifacts } from "./persistence.ts";
import {
	buildDiscussionRound1Prompt,
	buildDiscussionRound2Prompt,
	buildDraftPrompt,
	buildSynthesisPrompt,
	type PromptResponse,
} from "./prompts.ts";
import {
	disposeManagedSessions,
	runDraft,
	runDiscussion,
	runSynthesis,
	type ManagedSession,
	type RunSessionResult,
} from "./runner.ts";
import { buildTeamTranscript } from "./transcript.ts";
import {
	memberKey,
	memberLabel,
	normalizeLookupName,
	resolveConsensusModel,
	type CommEntry,
	type PersistedMemberState,
	type PersistedTeamRun,
	type ResolvedTeamConfig,
	type ResolvedTeamMember,
	type RunTeamProgress,
	type RunTeamResult,
	type RunTeamToolDetails,
	type TeamAvailability,
	type TeamTranscript,
} from "./types.ts";

export interface OrchestrateTeamRunInput {
	cwd: string;
	team: ResolvedTeamConfig;
	task: string;
	signal?: AbortSignal;
	availability?: TeamAvailability;
	onProgress?: (update: OrchestrateTeamRunProgressUpdate) => void;
}

export interface OrchestrateTeamRunProgressUpdate {
	run: PersistedTeamRun;
	progress: RunTeamProgress;
	transcript: TeamTranscript;
	availability: TeamAvailability;
}

export interface OrchestratedTeamRunOutcome {
	ok: boolean;
	error?: string;
	result: RunTeamResult;
	details: RunTeamToolDetails;
}

export interface OrchestratorDependencies {
	now: () => number;
	generateNextRunId: typeof generateNextRunId;
	checkTeamAvailability: (input: { team: ResolvedTeamConfig }) => Promise<TeamAvailability>;
	assertRunnableAvailability: (input: { team: ResolvedTeamConfig; availability: TeamAvailability }) => void;
	createSession: (input: { member: ResolvedTeamMember; purpose: "phase" | "synthesis" }) => Promise<ManagedSession>;
	runDraft: typeof runDraft;
	runDiscussion: typeof runDiscussion;
	runSynthesis: typeof runSynthesis;
	disposeManagedSessions: typeof disposeManagedSessions;
	writeRunArtifacts: typeof writeRunArtifacts;
	buildCommLogPayload: typeof buildCommLogPayload;
	buildTeamTranscript: typeof buildTeamTranscript;
}

const defaultDependencies: OrchestratorDependencies = {
	now: () => Date.now(),
	generateNextRunId,
	checkTeamAvailability: async () => {
		throw new Error("availability must be provided or checkTeamAvailability dependency must be wired.");
	},
	assertRunnableAvailability,
	createSession: async () => {
		throw new Error("createSession dependency is required for orchestration.");
	},
	runDraft,
	runDiscussion,
	runSynthesis,
	disposeManagedSessions,
	writeRunArtifacts,
	buildCommLogPayload,
	buildTeamTranscript,
};

export async function orchestrateTeamRun(
	input: OrchestrateTeamRunInput,
	dependencies: Partial<OrchestratorDependencies> = {},
): Promise<OrchestratedTeamRunOutcome> {
	const deps = { ...defaultDependencies, ...dependencies };
	const team: ResolvedTeamConfig = {
		...input.team,
		members: normalizeTeamMembers(input.team.members),
	};
	const availability = input.availability ?? (await deps.checkTeamAvailability({ team }));
	deps.assertRunnableAvailability({ team, availability });

	const participatingMembers = team.members.filter((member) =>
		availability.availableMembers.some((available) => availabilityMatchesMember(available, member)),
	);
	const synthesisMember = resolveSynthesisMember(team, availability);

	const runId = await deps.generateNextRunId({ cwd: input.cwd, teamName: team.name });
	const run = createInitialRun(runId, team, input.task, participatingMembers, deps.now());
	const progress = createInitialProgress();
	const commEntries: CommEntry[] = [];
	const managedSessions: ManagedSession[] = [];

	const emitProgress = () => {
		input.onProgress?.({
			run,
			progress: cloneProgress(progress),
			transcript: deps.buildTeamTranscript({
				run,
				consensusModel: resolveConsensusModel(team),
				availabilityChecked: true,
				progress,
			}),
			availability,
		});
	};

	try {
		for (const member of participatingMembers) {
			managedSessions.push(await deps.createSession({ member, purpose: "phase" }));
		}

		progress.phase = "draft";
		progress.phaseMembers = participatingMembers.map((member) => member.key);
		emitProgress();

		const draftSuccesses = await executePhase({
			members: participatingMembers,
			managedSessions,
		run,
			phase: "draft",
			buildPrompt: () => buildDraftPrompt({ task: input.task }),
			execute: deps.runDraft,
			commEntries,
			now: deps.now,
			progress,
			emitProgress,
			signal: input.signal,
		});

		if (draftSuccesses.length < 2) {
			return finalizeOutcome({
				ok: false,
				error: "Run failed because fewer than 2 draft outputs succeeded.",
				input,
				run,
				commEntries,
				availability,
				deps,
			});
		}

		const round1Members = participatingMembers.filter((member) => draftSuccesses.includes(member.key));
		progress.phase = "discussion_round_1";
		progress.phaseMembers = round1Members.map((member) => member.key);
		emitProgress();

		const round1Successes = await executePhase({
			members: round1Members,
			managedSessions,
			run,
			phase: "discussion_round_1",
			buildPrompt: (member) =>
				buildDiscussionRound1Prompt({
					responses: buildPeerResponses({
						source: run.draftResponses,
						members: run.members,
						recipientKey: member.key,
						memberOrder: participatingMembers,
					}),
				}),
			execute: deps.runDiscussion,
			commEntries,
			now: deps.now,
			progress,
			emitProgress,
			signal: input.signal,
		});

		const round2Members = round1Members.filter((member) => round1Successes.includes(member.key));
		progress.phase = "discussion_round_2";
		progress.phaseMembers = round2Members.map((member) => member.key);
		emitProgress();

		await executePhase({
			members: round2Members,
			managedSessions,
			run,
			phase: "discussion_round_2",
			buildPrompt: (member) =>
				buildDiscussionRound2Prompt({
					responses: buildPeerResponses({
						source: run.discussionRounds[0]?.responses ?? {},
						members: run.members,
						recipientKey: member.key,
						memberOrder: participatingMembers,
					}),
				}),
			execute: deps.runDiscussion,
			commEntries,
			now: deps.now,
			progress,
			emitProgress,
			signal: input.signal,
		});

		const synthesisSession = await deps.createSession({ member: synthesisMember, purpose: "synthesis" });
		managedSessions.push(synthesisSession);
		progress.phase = "synthesis";
		progress.phaseMembers = [synthesisMember.key];
		setMemberStatus(run, synthesisMember.key, "running");
		emitProgress();

		const synthesisPrompt = buildSynthesisPrompt({
			task: input.task,
			draftResponses: buildResponsesForSynthesis(run.draftResponses, run.members, participatingMembers),
			discussionRounds: run.discussionRounds.map((round) => ({
				round: round.round,
				responses: buildResponsesForSynthesis(round.responses, run.members, participatingMembers),
			})),
		});

		try {
			const synthesisResult = await deps.runSynthesis({
				session: synthesisSession.session,
				prompt: synthesisPrompt,
				signal: input.signal,
				onTextDelta: ({ streamedText }) => {
					progress.liveResponses.synthesis[synthesisMember.key] = streamedText;
					emitProgress();
				},
			});
			delete progress.liveResponses.synthesis[synthesisMember.key];
			run.synthesis = synthesisResult.text;
			setMemberResult(run, synthesisMember.key, synthesisResult.text, synthesisResult.tokens, synthesisResult.durationMs);
			emitProgress();
			commEntries.push(makeCommEntry({
				id: `${run.runId}-consensus-${commEntries.length + 1}`,
				timestamp: deps.now(),
				phase: "consensus",
				status: "ok",
				from: displayResolvedMemberLabel(synthesisMember, participatingMembers),
				to: null,
				content: synthesisResult.text,
				model: synthesisMember.model,
				tokens: synthesisResult.tokens,
				durationMs: synthesisResult.durationMs,
			}));
		} catch (error) {
			delete progress.liveResponses.synthesis[synthesisMember.key];
			setMemberError(run, synthesisMember.key, errorMessage(error));
			emitProgress();
			commEntries.push(makeCommEntry({
				id: `${run.runId}-consensus-${commEntries.length + 1}`,
				timestamp: deps.now(),
				phase: "consensus",
				status: "error",
				from: displayResolvedMemberLabel(synthesisMember, participatingMembers),
				to: null,
				content: "",
				model: synthesisMember.model,
				error: errorMessage(error),
				tokens: { input: 0, output: 0 },
				durationMs: 0,
			}));
			return finalizeOutcome({
				ok: false,
				error: "Run failed because synthesis failed.",
				input,
				run,
				commEntries,
				availability,
				deps,
			});
		}

		progress.phase = "persisting";
		progress.phaseMembers = [];
		return finalizeOutcome({
			ok: true,
			input,
			run,
			commEntries,
			availability,
			deps,
		});
	} finally {
		await deps.disposeManagedSessions(managedSessions);
	}
}

async function executePhase(input: {
	members: ResolvedTeamMember[];
	managedSessions: ManagedSession[];
	run: PersistedTeamRun;
	phase: "draft" | "discussion_round_1" | "discussion_round_2";
	buildPrompt: (member: ResolvedTeamMember) => string;
	execute: typeof runDraft | typeof runDiscussion;
	commEntries: CommEntry[];
	now: () => number;
	progress: RunTeamProgress;
	emitProgress: () => void;
	signal?: AbortSignal;
}): Promise<string[]> {
	const results = await Promise.all(
		input.members.map(async (member) => {
			const duplicateNameCount = input.members.filter(
				(entry) => normalizeLookupName(entry.name) === normalizeLookupName(member.name),
			).length;
			const managed =
				input.managedSessions.find((entry) => entry.memberKey === member.key) ??
				input.managedSessions.find(
					(entry) =>
						normalizeLookupName(entry.memberName) === normalizeLookupName(member.name) &&
						normalizeLookupName(entry.model) === normalizeLookupName(member.model),
				) ??
				(duplicateNameCount === 1
					? input.managedSessions.find(
							(entry) => normalizeLookupName(entry.memberName) === normalizeLookupName(member.name),
						)
					: undefined);
			if (!managed) {
				throw new Error(`Missing managed session for ${member.key}.`);
			}
			setMemberStatus(input.run, member.key, "running");
			input.emitProgress();

			try {
				const prompt = input.buildPrompt(member);
				recordPhasePrompt(input.run, input.phase, member.key, prompt);
				const result = await input.execute({
					session: managed.session,
					prompt,
					signal: input.signal,
					onTextDelta: ({ streamedText }) => {
						input.progress.liveResponses[input.phase][member.key] = streamedText;
						input.emitProgress();
					},
				});
				delete input.progress.liveResponses[input.phase][member.key];
				setMemberResult(input.run, member.key, result.text, result.tokens, result.durationMs);
				applyPhaseSuccess(input.run, input.phase, member.key, result.text);
				input.emitProgress();
				input.commEntries.push(makeCommEntry({
					id: `${input.run.runId}-${phaseToCommPrefix(input.phase)}-${input.commEntries.length + 1}`,
					timestamp: input.now(),
					phase: input.phase === "draft" ? "draft" : "discuss",
					status: "ok",
					from: displayResolvedMemberLabel(member, input.members),
					to: null,
					content: result.text,
					model: member.model,
					tokens: result.tokens,
					durationMs: result.durationMs,
				}));
				return member.key;
			} catch (error) {
				delete input.progress.liveResponses[input.phase][member.key];
				setMemberError(input.run, member.key, errorMessage(error));
				input.emitProgress();
				input.commEntries.push(makeCommEntry({
					id: `${input.run.runId}-${phaseToCommPrefix(input.phase)}-${input.commEntries.length + 1}`,
					timestamp: input.now(),
					phase: input.phase === "draft" ? "draft" : "discuss",
					status: "error",
					from: displayResolvedMemberLabel(member, input.members),
					to: null,
					content: "",
					model: member.model,
					error: errorMessage(error),
					tokens: { input: 0, output: 0 },
					durationMs: 0,
				}));
				return null;
			}
		}),
	);

	return results.filter(Boolean) as string[];
}

function createInitialProgress(): RunTeamProgress {
	return {
		phase: "preparing",
		phaseMembers: [],
		liveResponses: {
			draft: {},
			discussion_round_1: {},
			discussion_round_2: {},
			synthesis: {},
		},
	};
}

function normalizeTeamMembers(members: ReadonlyArray<ResolvedTeamMember>): ResolvedTeamMember[] {
	const nameCounts = new Map<string, number>();
	for (const member of members) {
		const lookup = normalizeLookupName(member.name);
		nameCounts.set(lookup, (nameCounts.get(lookup) ?? 0) + 1);
	}

	return members.map((member, index) => ({
		...member,
		key:
			typeof member.key === "string" && member.key.trim()
				? member.key
				: (nameCounts.get(normalizeLookupName(member.name)) ?? 0) === 1
					? member.name
					: memberKey(member.name, member.model, index),
	}));
}

function cloneProgress(progress: RunTeamProgress): RunTeamProgress {
	return {
		phase: progress.phase,
		phaseMembers: [...progress.phaseMembers],
		liveResponses: {
			draft: { ...progress.liveResponses.draft },
			discussion_round_1: { ...progress.liveResponses.discussion_round_1 },
			discussion_round_2: { ...progress.liveResponses.discussion_round_2 },
			synthesis: { ...progress.liveResponses.synthesis },
		},
	};
}

function createInitialRun(
	runId: string,
	team: ResolvedTeamConfig,
	task: string,
	members: ResolvedTeamMember[],
	startedAt: number,
): PersistedTeamRun {
	return {
		runId,
		teamName: team.name,
		task,
		members: Object.fromEntries(
			members.map((member) => [
				member.key,
				{
					key: member.key,
					name: member.name,
					model: member.model,
					status: "pending",
					latestResponse: "",
				},
			]),
		),
		draftResponses: {},
		discussionRounds: [
			{ round: 1, promptByMember: {}, responses: {} },
			{ round: 2, promptByMember: {}, responses: {} },
		],
		startedAt,
	};
}

function applyPhaseSuccess(
	run: PersistedTeamRun,
	phase: "draft" | "discussion_round_1" | "discussion_round_2",
	memberKey: string,
	text: string,
): void {
	if (phase === "draft") {
		run.draftResponses[memberKey] = text;
		return;
	}
	const roundIndex = phase === "discussion_round_1" ? 0 : 1;
	run.discussionRounds[roundIndex]!.responses[memberKey] = text;
}

function recordPhasePrompt(
	run: PersistedTeamRun,
	phase: "draft" | "discussion_round_1" | "discussion_round_2",
	memberKey: string,
	prompt: string,
): void {
	if (phase === "draft") {
		return;
	}
	const roundIndex = phase === "discussion_round_1" ? 0 : 1;
	run.discussionRounds[roundIndex]!.promptByMember[memberKey] = prompt;
}

function setMemberStatus(run: PersistedTeamRun, memberKey: string, status: PersistedMemberState["status"]): void {
	const member = run.members[memberKey];
	if (member) {
		member.status = status;
	}
}

function setMemberResult(
	run: PersistedTeamRun,
	memberKey: string,
	text: string,
	tokens: RunSessionResult["tokens"],
	durationMs: number,
): void {
	const member = run.members[memberKey];
	if (!member) return;
	member.status = "done";
	member.latestResponse = text;
	member.error = undefined;
	member.lastTokens = tokens;
	member.lastDurationMs = durationMs;
}

function setMemberError(run: PersistedTeamRun, memberKey: string, error: string): void {
	const member = run.members[memberKey];
	if (!member) return;
	member.status = "error";
	member.error = error;
}

function buildPeerResponses(input: {
	source: Record<string, string>;
	members: Record<string, PersistedMemberState>;
	recipientKey: string;
	memberOrder: ReadonlyArray<ResolvedTeamMember>;
}): PromptResponse[] {
	return input.memberOrder
		.filter((member) => member.key !== input.recipientKey)
		.map((member) => [member, input.source[member.key]] as const)
		.filter(([, response]) => Boolean(response && response.trim().length > 0))
		.map(([member, response]) => ({
			label: displayResolvedMemberLabel(member, input.memberOrder),
			content: response!.trim(),
		}));
}

function buildResponsesForSynthesis(
	source: Record<string, string>,
	members: Record<string, PersistedMemberState>,
	memberOrder: ReadonlyArray<ResolvedTeamMember>,
): PromptResponse[] {
	return memberOrder
		.map((member) => ({ member, response: source[member.key] }))
		.filter(({ response }) => Boolean(response && response.trim().length > 0))
		.map(({ member, response }) => ({
			label: displayResolvedMemberLabel(member, memberOrder),
			content: response!.trim(),
		}));
}

function resolveSynthesisMember(
	team: ResolvedTeamConfig,
	availability: TeamAvailability,
): ResolvedTeamMember {
	if (!availability.consensusModelAvailable) {
		throw new Error(`Team \"${team.name}\" cannot run because the consensus model is unavailable.`);
	}
	const consensusModel = resolveConsensusModel(team);
	const agent = team.members[0]?.agent;
	if (!agent) {
		throw new Error(`Team \"${team.name}\" cannot run because it has no team members.`);
	}
	return {
		key: memberKey("consensus", consensusModel, 0),
		name: "consensus",
		model: consensusModel,
		agent,
	};
}

function availabilityMatchesMember(
	available: Pick<TeamAvailability["availableMembers"][number], "key" | "name" | "model">,
	member: Pick<ResolvedTeamMember, "key" | "name" | "model">,
): boolean {
	return Boolean(
		(available.key && normalizeLookupName(available.key) === normalizeLookupName(member.key)) ||
		(normalizeLookupName(available.name) === normalizeLookupName(member.name) &&
			normalizeLookupName(available.model) === normalizeLookupName(member.model)),
	);
}

function displayResolvedMemberLabel(
	member: Pick<ResolvedTeamMember, "name" | "model">,
	memberOrder: ReadonlyArray<Pick<ResolvedTeamMember, "name" | "model">>,
): string {
	const duplicateCount = memberOrder.filter((entry) => normalizeLookupName(entry.name) === normalizeLookupName(member.name)).length;
	return duplicateCount > 1 ? memberLabel(member.name, member.model) : member.name;
}

function displayMemberLabel(
	member: Pick<PersistedMemberState, "name" | "model">,
	memberOrder: ReadonlyArray<Pick<PersistedMemberState, "name" | "model">>,
): string {
	const duplicateCount = memberOrder.filter((entry) => normalizeLookupName(entry.name) === normalizeLookupName(member.name)).length;
	return duplicateCount > 1 ? memberLabel(member.name, member.model) : member.name;
}

function finalizeOutcome(input: {
	ok: boolean;
	error?: string;
	input: OrchestrateTeamRunInput;
	run: PersistedTeamRun;
	commEntries: CommEntry[];
	availability: TeamAvailability;
	deps: OrchestratorDependencies;
}): Promise<OrchestratedTeamRunOutcome> {
	input.run.completedAt = input.deps.now();
	return input.deps.writeRunArtifacts({ cwd: input.input.cwd, run: input.run }).then(async (artifacts) => {
		const commPayload = input.deps.buildCommLogPayload({
			runId: input.run.runId,
			team: input.run.teamName,
			task: input.run.task,
			entries: input.commEntries,
		});
		const transcript = input.deps.buildTeamTranscript({
			run: input.run,
			consensusModel: resolveConsensusModel(input.input.team),
			availabilityChecked: true,
		});
		const result: RunTeamResult = {
			runId: input.run.runId,
			team: input.run.teamName,
			agents: Object.values(input.run.members).map((member) => displayMemberLabel(member, Object.values(input.run.members))),
			summary: {
				totalEntries: commPayload.summary.totalEntries,
				totalTokensIn: commPayload.summary.totalTokensIn,
				totalTokensOut: commPayload.summary.totalTokensOut,
				totalDurationMs: commPayload.summary.totalDurationMs,
			},
			finalOutput: input.run.synthesis ?? "",
		};
		const details: RunTeamToolDetails = {
			version: 1,
			result,
			run: input.run,
			transcript,
			comm: {
				entries: input.commEntries,
				summary: commPayload.summary,
			},
			artifacts,
			availability: input.availability,
		};
		return {
			ok: input.ok,
			error: input.error,
			result,
			details,
		};
	});
}

function makeCommEntry(entry: CommEntry): CommEntry {
	return entry;
}

function phaseToCommPrefix(phase: "draft" | "discussion_round_1" | "discussion_round_2"): string {
	return phase === "draft" ? "draft" : phase === "discussion_round_1" ? "discuss-r1" : "discuss-r2";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
