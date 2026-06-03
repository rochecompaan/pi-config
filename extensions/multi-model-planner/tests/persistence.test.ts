import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	buildCommLogPayload,
	buildCommSummary,
	generateNextRunId,
	slugifyName,
	writeRunArtifacts,
} from "../persistence.ts";
import type { CommEntry, PersistedTeamRun } from "../types.ts";

async function makeTempDir(prefix = "multi-model-planner-persistence-") {
	return mkdtemp(path.join(tmpdir(), prefix));
}

function makeRun(runId = "planning-team-001"): PersistedTeamRun {
	return {
		runId,
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
			gemini: "",
		},
		discussionRounds: [
			{
				round: 1,
				promptByMember: {
					claude: "Round 1 prompt for Claude",
					codex: "Round 1 prompt for Codex",
					gemini: "Round 1 prompt for Gemini",
				},
				responses: {
					claude: "Claude round 1",
					codex: "Codex round 1",
					gemini: "Gemini round 1",
				},
			},
			{
				round: 2,
				promptByMember: {
					claude: "Round 2 prompt for Claude",
					codex: "Round 2 prompt for Codex",
					gemini: "   ",
				},
				responses: {
					claude: "Claude round 2",
					codex: "Codex round 2",
					gemini: "   ",
				},
			},
		],
		startedAt: 1,
		completedAt: 2,
		synthesis: "Final synthesis from Claude",
	};
}

function makeEntries(): CommEntry[] {
	return [
		{
			id: "1",
			timestamp: 1,
			phase: "draft",
			status: "ok",
			from: "claude",
			to: null,
			content: "Claude draft",
			model: "anthropic/claude-opus-4.6",
			tokens: { input: 100, output: 200 },
			durationMs: 1000,
		},
		{
			id: "2",
			timestamp: 2,
			phase: "draft",
			status: "error",
			from: "gemini",
			to: null,
			content: "",
			model: "google/gemini-2.5-pro",
			error: "timed out",
			tokens: { input: 50, output: 0 },
			durationMs: 1500,
		},
		{
			id: "3",
			timestamp: 3,
			phase: "discuss",
			status: "ok",
			from: "codex",
			to: null,
			content: "Codex round 1",
			model: "openai/gpt-5.4",
			tokens: { input: 80, output: 120 },
			durationMs: 800,
		},
		{
			id: "4",
			timestamp: 4,
			phase: "consensus",
			status: "ok",
			from: "claude",
			to: null,
			content: "Final synthesis from Claude",
			model: "anthropic/claude-opus-4.6",
			tokens: { input: 120, output: 300 },
			durationMs: 1100,
		},
	];
}

test("slugifyName creates stable lowercase dash-separated names", () => {
	assert.equal(slugifyName("Planning Team"), "planning-team");
	assert.equal(slugifyName("  Review__Team  "), "review-team");
	assert.equal(slugifyName("!!!"), "team");
});

test("generateNextRunId uses workspace-local increment with slugified prefix", async () => {
	const root = await makeTempDir();
	const specsDir = path.join(root, ".pi", "specs");
	await mkdir(path.join(specsDir, "planning-team-001"), { recursive: true });
	await mkdir(path.join(specsDir, "planning-team-002"), { recursive: true });
	await mkdir(path.join(specsDir, "review-team-001"), { recursive: true });

	const runId = await generateNextRunId({ cwd: root, teamName: "Planning Team" });
	assert.equal(runId, "planning-team-003");
});

test("writeRunArtifacts writes successful artifacts and skips failed or empty outputs", async () => {
	const root = await makeTempDir();
	const manifest = await writeRunArtifacts({ cwd: root, run: makeRun() });

	assert.equal(manifest.runDir, path.join(root, ".pi", "specs", "planning-team-001"));
	assert.equal(manifest.draftArtifacts.claude, path.join(manifest.runDir, "draft-claude.md"));
	assert.equal(manifest.draftArtifacts.codex, path.join(manifest.runDir, "draft-codex.md"));
	assert.equal(manifest.draftArtifacts.gemini, undefined);
	assert.deepEqual(manifest.discussionPromptArtifacts.r1, [
		path.join(manifest.runDir, "prompt-discuss-r1-claude.md"),
		path.join(manifest.runDir, "prompt-discuss-r1-codex.md"),
		path.join(manifest.runDir, "prompt-discuss-r1-gemini.md"),
	]);
	assert.deepEqual(manifest.discussionPromptArtifacts.r2, [
		path.join(manifest.runDir, "prompt-discuss-r2-claude.md"),
		path.join(manifest.runDir, "prompt-discuss-r2-codex.md"),
	]);
	assert.deepEqual(manifest.discussionArtifacts.r1, [
		path.join(manifest.runDir, "discuss-r1-claude.md"),
		path.join(manifest.runDir, "discuss-r1-codex.md"),
		path.join(manifest.runDir, "discuss-r1-gemini.md"),
	]);
	assert.deepEqual(manifest.discussionArtifacts.r2, [
		path.join(manifest.runDir, "discuss-r2-claude.md"),
		path.join(manifest.runDir, "discuss-r2-codex.md"),
	]);
	assert.equal(manifest.synthesisArtifact, path.join(manifest.runDir, "synthesis-planning-team.md"));
	assert.equal(manifest.finalArtifact, path.join(manifest.runDir, "final.md"));
});

test("buildCommSummary aggregates totals by phase and agent including failures", () => {
	const summary = buildCommSummary(makeEntries());

	assert.equal(summary.totalEntries, 4);
	assert.equal(summary.totalTokensIn, 350);
	assert.equal(summary.totalTokensOut, 620);
	assert.equal(summary.totalDurationMs, 4400);
	assert.deepEqual(summary.byPhase.draft, { count: 2, tokensIn: 150, tokensOut: 200 });
	assert.deepEqual(summary.byPhase.discuss, { count: 1, tokensIn: 80, tokensOut: 120 });
	assert.deepEqual(summary.byPhase.consensus, { count: 1, tokensIn: 120, tokensOut: 300 });
	assert.deepEqual(summary.byAgent.claude, { count: 2, tokensIn: 220, tokensOut: 500 });
	assert.deepEqual(summary.byAgent.gemini, { count: 1, tokensIn: 50, tokensOut: 0 });
	assert.deepEqual(summary.byAgent.codex, { count: 1, tokensIn: 80, tokensOut: 120 });
});

test("buildCommLogPayload returns append-ready structured payload", () => {
	const entries = makeEntries();
	const payload = buildCommLogPayload({
		runId: "planning-team-001",
		team: "Planning Team",
		task: "Design the run_team tool.",
		entries,
		timestamp: 123,
	});

	assert.equal(payload.runId, "planning-team-001");
	assert.equal(payload.team, "Planning Team");
	assert.equal(payload.task, "Design the run_team tool.");
	assert.equal(payload.timestamp, 123);
	assert.equal(payload.entries.length, 4);
	assert.equal(payload.summary.totalEntries, 4);
	assert.equal(payload.summary.byPhase.consensus?.tokensOut, 300);
});
