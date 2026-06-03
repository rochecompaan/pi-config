import test from "node:test";
import assert from "node:assert/strict";
import {
	buildTeamTranscript,
	renderTranscriptText,
	transcriptPhaseTitle,
} from "../transcript.ts";
import type { PersistedTeamRun, TeamRunProgress } from "../types.ts";

function makeRun(): PersistedTeamRun {
	return {
		runId: "planning-team-001",
		teamName: "Planning Team",
		task: "Design the run_team tool.",
		members: {
			claude: {
				name: "claude",
				model: "anthropic/claude-opus-4.6",
				status: "done",
				latestResponse: "Final synthesis from Claude",
			},
			codex: {
				name: "codex",
				model: "openai/gpt-5.4",
				status: "done",
				latestResponse: "Codex latest response",
			},
			gemini: {
				name: "gemini",
				model: "google/gemini-2.5-pro",
				status: "error",
				latestResponse: "",
				error: "model request timed out before a final assistant message was produced.",
			},
		},
		draftResponses: {
			claude: "Claude draft",
			codex: "Codex draft",
			gemini: "Gemini draft",
		},
		discussionRounds: [
			{
				round: 1,
				promptByMember: {},
				responses: {
					claude: "Claude round 1",
					codex: "Codex round 1",
					gemini: "Gemini round 1",
				},
			},
			{
				round: 2,
				promptByMember: {},
				responses: {
					claude: "Claude round 2",
					codex: "Codex round 2",
				},
			},
		],
		startedAt: 1,
		completedAt: 2,
		synthesis: "Final synthesis from Claude",
	};
}

test("transcriptPhaseTitle returns stable Option A1 titles", () => {
	assert.equal(transcriptPhaseTitle("draft"), "Draft");
	assert.equal(transcriptPhaseTitle("discussion_round_1"), "Discussion · Round 1");
	assert.equal(transcriptPhaseTitle("discussion_round_2"), "Discussion · Round 2");
	assert.equal(transcriptPhaseTitle("synthesis"), "Synthesis");
});

test("buildTeamTranscript builds ordered phase sections with inline failures", () => {
	const transcript = buildTeamTranscript({
		run: makeRun(),
		consensusModel: "anthropic/claude-opus-4.6",
		availabilityChecked: true,
	});

	assert.equal(transcript.teamName, "Planning Team");
	assert.equal(transcript.runId, "planning-team-001");
	assert.equal(transcript.agentCount, 3);
	assert.match(transcript.leadLine, /Running team "Planning Team"/);
	assert.equal(transcript.sections.length, 4);
	assert.deepEqual(
		transcript.sections.map((section) => section.title),
		["Draft", "Discussion · Round 1", "Discussion · Round 2", "Synthesis"],
	);
	assert.equal(transcript.sections[0]?.statusLine, "3 responses complete");
	assert.equal(transcript.sections[2]?.statusLine, "2 responses complete · 1 failure");
	assert.equal(transcript.sections[2]?.entries[2]?.status, "error");
	assert.match(transcript.sections[2]?.entries[2]?.error ?? "", /timed out/i);
	assert.equal(transcript.sections[3]?.statusLine, "claude · consensus model");
});

test("renderTranscriptText matches the selected flat phase ruler structure", () => {
	const transcript = buildTeamTranscript({
		run: makeRun(),
		consensusModel: "anthropic/claude-opus-4.6",
		availabilityChecked: true,
	});
	const rendered = renderTranscriptText(transcript);

	assert.match(rendered, /Team lead: Running team "Planning Team"\./);
	assert.match(rendered, /Run id: planning-team-001 · 3 agents · availability checked/);
	assert.match(rendered, /== Draft =+/);
	assert.match(rendered, /\[claude\]\nClaude draft/);
	assert.match(rendered, /--------------------------------------------------------------------------/);
	assert.match(rendered, /== Discussion · Round 2 =+/);
	assert.match(rendered, /\[gemini · error\]\nAgent failed during Discussion Round 2: model request timed out/i);
	assert.match(rendered, /== Synthesis =+/);
	assert.match(rendered, /\[claude\]\nFinal synthesis from Claude/);
});

test("renderTranscriptText does not leak prompt scaffolding markers", () => {
	const run = makeRun();
	run.draftResponses.claude = "Claude draft without prompt scaffolding";
	const transcript = buildTeamTranscript({
		run,
		consensusModel: "anthropic/claude-opus-4.6",
	});
	const rendered = renderTranscriptText(transcript);

	assert.doesNotMatch(rendered, /## Original Task/);
	assert.doesNotMatch(rendered, /## Team Discussion/);
	assert.doesNotMatch(rendered, /### codex/);
});

test("buildTeamTranscript renders the active phase with streaming entries during partial progress", () => {
	const run = makeRun();
	run.discussionRounds[0]!.responses = {
		claude: "Claude round 1",
	};
	run.discussionRounds[1]!.responses = {};
	run.members.claude!.status = "done";
	run.members.codex!.status = "running";
	run.members.gemini!.status = "running";

	const progress: TeamRunProgress = {
		phase: "discussion_round_1",
		phaseMembers: ["claude", "codex", "gemini"],
		liveResponses: {
			draft: {},
			discussion_round_1: {
				codex: "Codex is still typing",
			},
			discussion_round_2: {},
			synthesis: {},
		},
	};

	const transcript = buildTeamTranscript({
		run,
		consensusModel: "anthropic/claude-opus-4.6",
		progress,
	});
	const rendered = renderTranscriptText(transcript);

	assert.equal(transcript.sections.length, 2);
	assert.equal(transcript.sections[1]?.statusLine, "1 responses complete · 2 running");
	assert.match(rendered, /== Discussion · Round 1 =+/);
	assert.match(rendered, /\[codex · streaming\]\nCodex is still typing/);
	assert.match(rendered, /\[gemini · pending\]\nWaiting to start/);
	assert.doesNotMatch(rendered, /== Discussion · Round 2 =+/);
});

test("buildTeamTranscript omits empty speaker entries while preserving errors", () => {
	const run = makeRun();
	run.draftResponses.gemini = "   ";
	run.discussionRounds[1]!.responses = {
		claude: "Claude round 2",
		codex: "Codex round 2",
	};

	const transcript = buildTeamTranscript({
		run,
		consensusModel: "anthropic/claude-opus-4.6",
	});

	assert.equal(transcript.sections[0]?.entries.length, 2);
	assert.equal(transcript.sections[2]?.entries.length, 3);
	assert.equal(transcript.sections[2]?.entries[2]?.agent, "gemini");
	assert.equal(transcript.sections[2]?.entries[2]?.status, "error");
});
