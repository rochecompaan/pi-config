export const TEAM_THINKING_LEVELS = [
	"off",
	"low",
	"medium",
	"high",
	"highest",
] as const;

export type TeamThinkingLevel = (typeof TEAM_THINKING_LEVELS)[number];

export const TEAM_RUN_PHASES = [
	"draft",
	"discussion_round_1",
	"discussion_round_2",
	"synthesis",
] as const;

export type TeamRunPhase = (typeof TEAM_RUN_PHASES)[number];

export type DiscussionRoundNumber = 1 | 2;
export type MemberExecutionStatus = "pending" | "running" | "done" | "error";
export type CommPhase = "draft" | "discuss" | "consensus";
export type CommStatus = "ok" | "error";
export type TranscriptEntryStatus = "ok" | "error" | "running" | "pending";
export type RunProgressPhase = "preparing" | TeamRunPhase | "persisting";

export interface RunTeamParams {
	task: string;
	team: string;
}

export interface AgentDef {
	name: string;
	description: string;
	tools: string;
	model?: string | null;
	thinking?: TeamThinkingLevel;
	systemPrompt: string;
	file: string;
}

export interface ResolvedAgentDef extends AgentDef {
	toolNames: string[];
}

export interface TeamMember {
	name: string;
	model: string;
}

export interface ThinkingConfig {
	draft: TeamThinkingLevel;
	discussion: TeamThinkingLevel;
	synthesis: TeamThinkingLevel;
}

export interface ConsensusConfig {
	model: string;
}

export interface TeamConfig {
	name: string;
	description: string;
	agents: TeamMember[];
	thinking: ThinkingConfig;
	consensus: ConsensusConfig;
	file: string;
}

export interface ResolvedTeamMember extends TeamMember {
	key: string;
	agent: ResolvedAgentDef;
}

export interface ResolvedTeamConfig extends TeamConfig {
	members: ResolvedTeamMember[];
}

export interface TokenUsage {
	input: number;
	output: number;
}

export interface RunPhaseUsageSummary {
	count: number;
	tokensIn: number;
	tokensOut: number;
}

export interface AgentUsageSummary {
	count: number;
	tokensIn: number;
	tokensOut: number;
}

export interface CommEntry {
	id: string;
	timestamp: number;
	phase: CommPhase;
	status: CommStatus;
	from: string;
	to: string | null;
	content: string;
	model: string;
	error?: string;
	tokens: TokenUsage;
	durationMs: number;
}

export interface CommSummary {
	totalEntries: number;
	totalTokensIn: number;
	totalTokensOut: number;
	totalDurationMs: number;
	byPhase: Record<string, RunPhaseUsageSummary>;
	byAgent: Record<string, AgentUsageSummary>;
}

export interface ActiveMemberState {
	session: unknown;
	status: MemberExecutionStatus;
	latestResponse: string;
	key: string;
	name: string;
	model: string;
	error?: string;
	lastTokens?: TokenUsage;
	lastDurationMs?: number;
}

export interface DiscussionRound {
	round: DiscussionRoundNumber;
	promptByMember: Map<string, string>;
	responses: Map<string, string>;
}

export interface TeamRun {
	runId: string;
	teamName: string;
	task: string;
	members: Map<string, ActiveMemberState>;
	draftResponses: Map<string, string>;
	discussionRounds: DiscussionRound[];
	synthesis?: string;
	startedAt: number;
	completedAt?: number;
}

export interface RunTeamResult {
	runId: string;
	team: string;
	agents: string[];
	summary: {
		totalEntries: number;
		totalTokensIn: number;
		totalTokensOut: number;
		totalDurationMs: number;
	};
	finalOutput: string;
}

export interface AvailabilityMemberStatus {
	key: string;
	name: string;
	model: string;
	available: boolean;
	reason?: string;
}

export interface TeamAvailability {
	team: string;
	availableMembers: AvailabilityMemberStatus[];
	unavailableMembers: AvailabilityMemberStatus[];
	consensusModel: string;
	consensusModelAvailable: boolean;
	checkedAt: number;
}

export interface TeamAvailabilityCache {
	checkedAt: number;
	byTeam: Record<string, TeamAvailability>;
}

export interface PersistedDiscussionRound {
	round: DiscussionRoundNumber;
	promptByMember: Record<string, string>;
	responses: Record<string, string>;
}

export interface PersistedMemberState {
	key: string;
	name: string;
	model: string;
	status: MemberExecutionStatus;
	latestResponse: string;
	error?: string;
	lastTokens?: TokenUsage;
	lastDurationMs?: number;
}

export interface PersistedTeamRun {
	runId: string;
	teamName: string;
	task: string;
	members: Record<string, PersistedMemberState>;
	draftResponses: Record<string, string>;
	discussionRounds: PersistedDiscussionRound[];
	synthesis?: string;
	startedAt: number;
	completedAt?: number;
}

export interface RunArtifactManifest {
	runDir: string;
	draftArtifacts: Record<string, string>;
	discussionArtifacts: Record<string, string[]>;
	discussionPromptArtifacts: Record<string, string[]>;
	synthesisArtifact?: string;
	finalArtifact?: string;
}

export interface TeamRunProgress {
	phase: RunProgressPhase;
	phaseMembers: string[];
	liveResponses: Record<TeamRunPhase, Record<string, string>>;
}

export interface TranscriptSpeakerBlock {
	agent: string;
	model: string;
	status: TranscriptEntryStatus;
	content: string;
	error?: string;
}

export interface TranscriptPhaseSection {
	phase: TeamRunPhase;
	title: string;
	statusLine?: string;
	entries: TranscriptSpeakerBlock[];
}

export interface TeamTranscript {
	teamName: string;
	runId: string;
	agentCount: number;
	leadLine: string;
	sections: TranscriptPhaseSection[];
}

export interface RunTeamToolDetails {
	version: 1;
	result: RunTeamResult;
	run: PersistedTeamRun;
	transcript: TeamTranscript;
	comm: {
		entries: CommEntry[];
		summary: CommSummary;
	};
	artifacts: RunArtifactManifest;
	availability?: TeamAvailability;
}

export interface RunTeamProgressDetails {
	version: 1;
	progress: TeamRunProgress;
	transcript: TeamTranscript;
	availability?: TeamAvailability;
}

export function normalizeLookupName(value: string): string {
	return value.trim().toLowerCase();
}

export function memberKey(name: string, model: string, index: number): string {
	return `${normalizeLookupName(name)}|${normalizeLookupName(model)}|${String(index).padStart(3, "0")}`;
}

export function memberLabel(name: string, model: string): string {
	return `${name} · ${model}`;
}

export function isTeamThinkingLevel(value: string): value is TeamThinkingLevel {
	return (TEAM_THINKING_LEVELS as readonly string[]).includes(value);
}

export function discussionPhaseName(round: DiscussionRoundNumber): Extract<TeamRunPhase, "discussion_round_1" | "discussion_round_2"> {
	return round === 1 ? "discussion_round_1" : "discussion_round_2";
}

export function resolveConsensusModel(team: { members: ReadonlyArray<{ name: string; model: string }>; consensus: ConsensusConfig }): string {
	if (team.consensus.model.trim()) {
		return team.consensus.model.trim();
	}
	return "";
}
