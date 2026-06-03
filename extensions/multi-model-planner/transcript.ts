import type {
	PersistedMemberState,
	PersistedTeamRun,
	TeamRunPhase,
	TeamRunProgress,
	TeamTranscript,
	TranscriptPhaseSection,
	TranscriptSpeakerBlock,
} from "./types.ts";
import { memberLabel, normalizeLookupName } from "./types.ts";

const PHASE_SEPARATOR = "--------------------------------------------------------------------------";
const PHASE_RULER_WIDTH = 74;

export interface BuildTeamTranscriptInput {
	run: PersistedTeamRun;
	consensusModel?: string;
	availabilityChecked?: boolean;
	progress?: TeamRunProgress;
}

export function transcriptPhaseTitle(phase: TeamRunPhase): string {
	switch (phase) {
		case "draft":
			return "Draft";
		case "discussion_round_1":
			return "Discussion · Round 1";
		case "discussion_round_2":
			return "Discussion · Round 2";
		case "synthesis":
			return "Synthesis";
	}
}

export function buildTeamTranscript(input: BuildTeamTranscriptInput): TeamTranscript {
	const memberOrder = Object.values(input.run.members).sort(compareMembers);
	const sectionInputs = [
		{ phase: "draft" as const, build: () => buildDraftSection(input.run, memberOrder, input.progress) },
		{ phase: "discussion_round_1" as const, build: () => buildDiscussionSection(input.run, 1, memberOrder, input.progress) },
		{ phase: "discussion_round_2" as const, build: () => buildDiscussionSection(input.run, 2, memberOrder, input.progress) },
		{
			phase: "synthesis" as const,
			build: () => buildSynthesisSection(input.run, input.consensusModel ?? "", memberOrder, input.progress),
		},
	];
	const maxPhaseIndex = getVisiblePhaseCount(input.progress?.phase);

	return {
		teamName: input.run.teamName,
		runId: input.run.runId,
		agentCount: memberOrder.length,
		leadLine: `Team lead: Running team \"${input.run.teamName}\".`,
		sections: sectionInputs.slice(0, maxPhaseIndex).map((entry) => entry.build()),
	};
}

export function renderTranscriptText(transcript: TeamTranscript, options?: { availabilityChecked?: boolean }): string {
	const lines: string[] = [];
	lines.push(transcript.leadLine);

	const availabilityChecked = options?.availabilityChecked ?? true;
	lines.push(
		`Run id: ${transcript.runId} · ${transcript.agentCount || countDistinctAgents(transcript)} agents${availabilityChecked ? " · availability checked" : ""}`,
	);
	lines.push("");

	for (const [index, section] of transcript.sections.entries()) {
		lines.push(renderPhaseRuler(section.title));
		if (section.statusLine) {
			lines.push(section.statusLine);
		}
		lines.push("");
		lines.push(...renderSectionEntries(section));
		if (index < transcript.sections.length - 1) {
			lines.push("");
		}
	}

	return lines.join("\n");
}

function buildDraftSection(
	run: PersistedTeamRun,
	memberOrder: ReadonlyArray<PersistedMemberState>,
	progress?: TeamRunProgress,
): TranscriptPhaseSection {
	const entries = memberOrder
		.map((member) => buildPhaseEntry({ run, member, phase: "draft", memberOrder, progress }))
		.filter(Boolean) as TranscriptSpeakerBlock[];

	return {
		phase: "draft",
		title: transcriptPhaseTitle("draft"),
		statusLine: buildPhaseStatusLine({ run, phase: "draft", successCount: countSuccesses(run, "draft", memberOrder), memberOrder, progress }),
		entries,
	};
}

function buildDiscussionSection(
	run: PersistedTeamRun,
	round: 1 | 2,
	memberOrder: ReadonlyArray<PersistedMemberState>,
	progress?: TeamRunProgress,
): TranscriptPhaseSection {
	const phase = round === 1 ? "discussion_round_1" : "discussion_round_2";
	const entries = memberOrder
		.map((member) => buildPhaseEntry({ run, member, phase, memberOrder, progress }))
		.filter(Boolean) as TranscriptSpeakerBlock[];
	const successCount = countSuccesses(run, phase, memberOrder);
	const failureCount = countActiveFailures(run, phase, memberOrder, progress) || (round === 2 ? countRoundTwoFinalFailures(run, memberOrder) : 0);

	return {
		phase,
		title: transcriptPhaseTitle(phase),
		statusLine: buildPhaseStatusLine({ run, phase, successCount, memberOrder, progress, fallbackFailureCount: failureCount }),
		entries,
	};
}

function buildSynthesisSection(
	run: PersistedTeamRun,
	consensusTarget: string,
	memberOrder: ReadonlyArray<PersistedMemberState>,
	progress?: TeamRunProgress,
): TranscriptPhaseSection {
	const member = findConsensusMember(run.members, consensusTarget);
	const entries: TranscriptSpeakerBlock[] = [];
	if (member) {
		if (run.synthesis?.trim()) {
			entries.push(makeSuccessEntry(member, visibleMemberLabel(member, memberOrder), run.synthesis.trim()));
		} else if (progress?.phase === "synthesis" && isActiveMember(progress, member)) {
			const liveText = getLiveResponse(progress.liveResponses.synthesis, member)?.trimEnd();
			if (member.status === "error" && member.error) {
				entries.push(makeErrorEntry(member, visibleMemberLabel(member, memberOrder), "Synthesis"));
			} else {
				entries.push(makeRunningEntry(member, visibleMemberLabel(member, memberOrder), liveText));
			}
		}
	} else if (consensusTarget) {
		const externalMember = makeExternalConsensusMember(consensusTarget, progress);
		if (run.synthesis?.trim()) {
			entries.push(makeSuccessEntry(externalMember, consensusTarget, run.synthesis.trim()));
		} else if (progress?.phase === "synthesis") {
			const liveText = getLiveResponse(progress.liveResponses.synthesis, externalMember)?.trimEnd();
			entries.push(makeRunningEntry(externalMember, consensusTarget, liveText));
		}
	}

	return {
		phase: "synthesis",
		title: transcriptPhaseTitle("synthesis"),
		statusLine: buildSynthesisStatusLine({ run, consensusTarget, memberOrder, progress }),
		entries,
	};
}

function makeExternalConsensusMember(consensusTarget: string, progress?: TeamRunProgress): PersistedMemberState {
	return {
		key: progress?.phaseMembers[0] ?? consensusTarget,
		name: consensusTarget,
		model: consensusTarget,
		status: "pending",
		latestResponse: "",
	};
}

function renderSectionEntries(section: TranscriptPhaseSection): string[] {
	const lines: string[] = [];
	for (const [index, entry] of section.entries.entries()) {
		if (index > 0) {
			lines.push(PHASE_SEPARATOR);
		}
		if (entry.status === "error") {
			lines.push(`[${entry.agent} · error]`);
			lines.push(`Agent failed during ${phaseErrorLabel(section.phase)}: ${entry.error ?? "Unknown error"}`);
			lines.push("");
			continue;
		}
		if (entry.status === "running") {
			lines.push(`[${entry.agent} · streaming]`);
			lines.push(entry.content || "Waiting for first response...");
			lines.push("");
			continue;
		}
		if (entry.status === "pending") {
			lines.push(`[${entry.agent} · pending]`);
			lines.push(entry.content || "Waiting to start...");
			lines.push("");
			continue;
		}
		lines.push(`[${entry.agent}]`);
		lines.push(entry.content);
		lines.push("");
	}
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

function renderPhaseRuler(title: string): string {
	const prefix = `== ${title} `;
	const fillCount = Math.max(4, PHASE_RULER_WIDTH - prefix.length);
	return prefix + "=".repeat(fillCount);
}

function makeSuccessEntry(member: PersistedMemberState, agent: string, content: string): TranscriptSpeakerBlock {
	return {
		agent,
		model: member.model,
		status: "ok",
		content,
	};
}

function makeErrorEntry(
	member: PersistedMemberState,
	agent: string,
	label: 1 | 2 | "Draft" | "Synthesis",
): TranscriptSpeakerBlock {
	return {
		agent,
		model: member.model,
		status: "error",
		content: "",
		error:
			member.error ??
			(typeof label === "number" ? `Agent failed during Discussion Round ${label}.` : `Agent failed during ${label}.`),
	};
}

function buildPhaseEntry(input: {
	run: PersistedTeamRun;
	member: PersistedMemberState;
	phase: TeamRunPhase;
	memberOrder: ReadonlyArray<PersistedMemberState>;
	progress?: TeamRunProgress;
}): TranscriptSpeakerBlock | null {
	const response = getPhaseResponse(input.run, input.phase, input.member)?.trim();
	const agent = visibleMemberLabel(input.member, input.memberOrder);
	if (response) {
		return makeSuccessEntry(input.member, agent, response);
	}
	if (input.progress?.phase === input.phase && isActiveMember(input.progress, input.member)) {
		if (input.member.status === "error" && input.member.error) {
			return makeErrorEntry(input.member, agent, errorLabelForPhase(input.phase));
		}
		return makeRunningEntry(input.member, agent, getLiveResponse(input.progress.liveResponses[input.phase], input.member)?.trimEnd());
	}
	if (input.phase === "discussion_round_2" && input.member.status === "error" && input.member.error) {
		return makeErrorEntry(input.member, agent, 2);
	}
	return null;
}

function buildPhaseStatusLine(input: {
	run: PersistedTeamRun;
	phase: TeamRunPhase;
	successCount: number;
	memberOrder: ReadonlyArray<PersistedMemberState>;
	progress?: TeamRunProgress;
	fallbackFailureCount?: number;
}): string {
	if (input.progress?.phase === input.phase) {
		const activeMembers = input.memberOrder.filter((member) => isActiveMember(input.progress!, member));
		const completeCount = activeMembers.filter((member) => getPhaseResponse(input.run, input.phase, member)?.trim()).length;
		const failureCount = activeMembers.filter((member) => {
			return Boolean(member.status === "error" && member.error && !getPhaseResponse(input.run, input.phase, member)?.trim());
		}).length;
		const runningCount = Math.max(0, activeMembers.length - completeCount - failureCount);
		return formatCountSummary({ completeCount, runningCount, failureCount });
	}
	return formatCountSummary({
		completeCount: input.successCount,
		failureCount: input.fallbackFailureCount ?? 0,
	});
}

function buildSynthesisStatusLine(input: {
	run: PersistedTeamRun;
	consensusTarget: string;
	memberOrder: ReadonlyArray<PersistedMemberState>;
	progress?: TeamRunProgress;
}): string {
	const member = findConsensusMember(input.run.members, input.consensusTarget);
	const label = member ? visibleMemberLabel(member, input.memberOrder) : input.consensusTarget;
	const parts = [`${label} · consensus model`];
	if (input.progress?.phase === "synthesis" && member && isActiveMember(input.progress, member)) {
		if (input.run.synthesis?.trim()) {
			parts.push("complete");
		} else if (member.status === "error") {
			parts.push("failed");
		} else {
			parts.push("running");
		}
	}
	return parts.join(" · ");
}

function formatCountSummary(input: { completeCount: number; runningCount?: number; failureCount?: number }): string {
	const parts = [`${input.completeCount} responses complete`];
	if (input.runningCount && input.runningCount > 0) {
		parts.push(`${input.runningCount} running`);
	}
	if (input.failureCount && input.failureCount > 0) {
		parts.push(`${input.failureCount} failure${input.failureCount === 1 ? "" : "s"}`);
	}
	return parts.join(" · ");
}

function countSuccesses(
	run: PersistedTeamRun,
	phase: TeamRunPhase,
	memberOrder: ReadonlyArray<PersistedMemberState>,
): number {
	if (phase === "synthesis") {
		return run.synthesis?.trim() ? 1 : 0;
	}
	return memberOrder.filter((member) => Boolean(getPhaseResponse(run, phase, member)?.trim())).length;
}

function countRoundTwoFinalFailures(run: PersistedTeamRun, memberOrder: ReadonlyArray<PersistedMemberState>): number {
	return memberOrder.filter(
		(member) => member.status === "error" && member.error && !getPhaseResponse(run, "discussion_round_2", member)?.trim(),
	).length;
}

function countActiveFailures(
	run: PersistedTeamRun,
	phase: TeamRunPhase,
	memberOrder: ReadonlyArray<PersistedMemberState>,
	progress?: TeamRunProgress,
): number {
	if (!progress || progress.phase !== phase) {
		return 0;
	}
	return memberOrder.filter((member) => {
		return isActiveMember(progress, member) && Boolean(member.status === "error" && member.error && !getPhaseResponse(run, phase, member)?.trim());
	}).length;
}

function getPhaseResponse(run: PersistedTeamRun, phase: TeamRunPhase, member: PersistedMemberState): string | undefined {
	if (phase === "draft") {
		return getRecordValue(run.draftResponses, member);
	}
	if (phase === "synthesis") {
		return run.synthesis;
	}
	const roundIndex = phase === "discussion_round_1" ? 0 : 1;
	return getRecordValue(run.discussionRounds[roundIndex]?.responses ?? {}, member);
}

function getVisiblePhaseCount(phase: TeamRunProgress["phase"] | undefined): number {
	switch (phase) {
		case "draft":
			return 1;
		case "discussion_round_1":
			return 2;
		case "discussion_round_2":
			return 3;
		case "synthesis":
		case "persisting":
		default:
			return 4;
	}
}

function isActiveMember(progress: TeamRunProgress, member: PersistedMemberState): boolean {
	const identifiers = memberIdentifiers(member);
	return progress.phaseMembers.some((value) => identifiers.some((identifier) => sameLookupValue(value, identifier)));
}

function errorLabelForPhase(phase: TeamRunPhase): 1 | 2 | "Draft" | "Synthesis" {
	switch (phase) {
		case "discussion_round_1":
			return 1;
		case "discussion_round_2":
			return 2;
		case "synthesis":
			return "Synthesis";
		case "draft":
		default:
			return "Draft";
	}
}

function makeRunningEntry(member: PersistedMemberState, agent: string, content?: string): TranscriptSpeakerBlock {
	return {
		agent,
		model: member.model,
		status: content ? "running" : "pending",
		content: content ?? "",
	};
}

function phaseErrorLabel(phase: TeamRunPhase): string {
	switch (phase) {
		case "draft":
			return "Draft";
		case "discussion_round_1":
			return "Discussion Round 1";
		case "discussion_round_2":
			return "Discussion Round 2";
		case "synthesis":
			return "Synthesis";
	}
}

function countDistinctAgents(transcript: TeamTranscript): number {
	const names = new Set<string>();
	for (const section of transcript.sections) {
		for (const entry of section.entries) {
			names.add(entry.agent);
		}
	}
	return names.size;
}

function compareMembers(a: PersistedMemberState, b: PersistedMemberState): number {
	const aKey = a.key ?? a.name;
	const bKey = b.key ?? b.name;
	return a.name.localeCompare(b.name) || a.model.localeCompare(b.model) || aKey.localeCompare(bKey);
}

function visibleMemberLabel(
	member: PersistedMemberState,
	memberOrder: ReadonlyArray<PersistedMemberState>,
): string {
	const duplicateNameCount = memberOrder.filter((entry) => sameLookupValue(entry.name, member.name)).length;
	return duplicateNameCount > 1 ? memberLabel(member.name, member.model) : member.name;
}

function findConsensusMember(
	members: Record<string, PersistedMemberState>,
	consensusTarget: string,
): PersistedMemberState | undefined {
	const orderedMembers = Object.values(members);
	return (
		orderedMembers.find((member) => sameLookupValue(member.name, consensusTarget)) ??
		orderedMembers.find((member) => sameLookupValue(member.model, consensusTarget))
	);
}

function getRecordValue(record: Record<string, string>, member: PersistedMemberState): string | undefined {
	for (const identifier of memberIdentifiers(member)) {
		if (identifier && record[identifier] !== undefined) {
			return record[identifier];
		}
	}
	return undefined;
}

function getLiveResponse(record: Record<string, string>, member: PersistedMemberState): string | undefined {
	for (const identifier of memberIdentifiers(member)) {
		if (identifier && record[identifier] !== undefined) {
			return record[identifier];
		}
	}
	return undefined;
}

function memberIdentifiers(member: PersistedMemberState): string[] {
	return [member.key, member.name, member.model].filter((value): value is string => Boolean(value));
}

function sameLookupValue(left: string | undefined, right: string | undefined): boolean {
	if (!left || !right) return false;
	return normalizeLookupName(left) === normalizeLookupName(right);
}
