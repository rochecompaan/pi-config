import test from "node:test";
import assert from "node:assert/strict";
import { orchestrateTeamRun, type OrchestratorDependencies } from "../orchestrator.ts";
import type { TeamAvailability, ResolvedAgentDef, ResolvedTeamConfig } from "../types.ts";
import type { ManagedSession, RunSessionResult } from "../runner.ts";

function makeAgent(name: string): ResolvedAgentDef {
	return {
		name,
		description: `${name} agent`,
		tools: "read, bash",
		toolNames: ["read", "bash"],
		systemPrompt: `You are ${name}.`,
		file: `/tmp/${name}.md`,
	};
}

function makeTeam(): ResolvedTeamConfig {
	const claude = makeAgent("claude");
	const codex = makeAgent("codex");
	const gemini = makeAgent("gemini");
	return {
		name: "Planning Team",
		description: "Multi-model planning team",
		file: "/tmp/planning-team.yaml",
		agents: [
			{ name: "claude", model: "anthropic/claude-opus-4.6" },
			{ name: "codex", model: "openai/gpt-5.4" },
			{ name: "gemini", model: "google/gemini-2.5-pro" },
		],
		thinking: { draft: "highest", discussion: "high", synthesis: "high" },
		consensus: { model: "anthropic/claude-opus-4.6" },
		members: [
			{ name: "claude", model: "anthropic/claude-opus-4.6", agent: claude },
			{ name: "codex", model: "openai/gpt-5.4", agent: codex },
			{ name: "gemini", model: "google/gemini-2.5-pro", agent: gemini },
		],
	};
}

function makeAvailability(overrides?: Partial<TeamAvailability>): TeamAvailability {
	return {
		team: "Planning Team",
		availableMembers: [
			{ name: "claude", model: "anthropic/claude-opus-4.6", available: true },
			{ name: "codex", model: "openai/gpt-5.4", available: true },
			{ name: "gemini", model: "google/gemini-2.5-pro", available: true },
		],
		unavailableMembers: [],
		consensusModel: "anthropic/claude-opus-4.6",
		consensusModelAvailable: true,
		checkedAt: 1,
		...overrides,
	};
}

function makeSession(memberName: string, purpose: "phase" | "synthesis"): ManagedSession {
	return {
		memberName,
		model: `${memberName}-model`,
		session: {
			memberName,
			purpose,
			messages: [],
			subscribe: () => () => {},
			prompt: async () => {},
			dispose: () => {},
			abort: async () => {},
		} as ManagedSession["session"] & { memberName: string; purpose: string },
		purpose,
	} as ManagedSession & { purpose: string };
}

function result(text: string, input = 10, output = 20): RunSessionResult {
	return {
		text,
		streamedText: text,
		tokens: { input, output },
		stopReason: "stop",
		durationMs: 100,
	};
}

function createDeps(): {
	deps: OrchestratorDependencies;
	calls: {
		createSession: Array<{ member: string; purpose: string }>;
		draft: string[];
		discussion: string[];
		synthesis: string[];
		disposeCount: number;
		artifactsRunId?: string;
		logPayloads: any[];
	};
} {
	const draftQueue = new Map<string, Array<RunSessionResult | Error>>();
	const discussionQueue = new Map<string, Array<RunSessionResult | Error>>();
	const synthesisQueue = new Map<string, Array<RunSessionResult | Error>>();
	const calls = {
		createSession: [] as Array<{ member: string; purpose: string }>,
		draft: [] as string[],
		discussion: [] as string[],
		synthesis: [] as string[],
		disposeCount: 0,
		artifactsRunId: undefined as string | undefined,
		logPayloads: [] as any[],
	};

	const deps: OrchestratorDependencies = {
		now: (() => {
			let current = 1000;
			return () => current++;
		})(),
		generateNextRunId: async () => "planning-team-001",
		checkTeamAvailability: async () => makeAvailability(),
		assertRunnableAvailability: ({ availability }) => {
			if (availability.availableMembers.length < 2) throw new Error("fewer than 2 members are available");
			if (!availability.consensusModelAvailable) throw new Error("consensus model is unavailable");
		},
		createSession: async ({ member, purpose }) => {
			calls.createSession.push({ member: member.name, purpose });
			return makeSession(member.name, purpose);
		},
		runDraft: async ({ session, prompt }) => {
			calls.draft.push(prompt);
			const queue = draftQueue.get((session as any).memberName) ?? [];
			const next = queue.shift();
			if (next instanceof Error) throw next;
			if (!next) throw new Error(`No draft result queued for ${(session as any).memberName}`);
			return next;
		},
		runDiscussion: async ({ session, prompt }) => {
			calls.discussion.push(prompt);
			const queue = discussionQueue.get((session as any).memberName) ?? [];
			const next = queue.shift();
			if (next instanceof Error) throw next;
			if (!next) throw new Error(`No discussion result queued for ${(session as any).memberName}`);
			return next;
		},
		runSynthesis: async ({ session, prompt }) => {
			calls.synthesis.push(prompt);
			const queue = synthesisQueue.get((session as any).memberName) ?? [];
			const next = queue.shift();
			if (next instanceof Error) throw next;
			if (!next) throw new Error(`No synthesis result queued for ${(session as any).memberName}`);
			return next;
		},
		disposeManagedSessions: async (sessions) => {
			calls.disposeCount += sessions.length;
		},
		writeRunArtifacts: async ({ run }) => {
			calls.artifactsRunId = run.runId;
			return {
				runDir: `/tmp/${run.runId}`,
				draftArtifacts: {},
				discussionArtifacts: {},
				finalArtifact: `/tmp/${run.runId}/final.md`,
				synthesisArtifact: `/tmp/${run.runId}/synthesis.md`,
			};
		},
		buildCommLogPayload: (payload) => {
			const summary = {
				totalEntries: payload.entries.length,
				totalTokensIn: payload.entries.reduce((sum, entry) => sum + entry.tokens.input, 0),
				totalTokensOut: payload.entries.reduce((sum, entry) => sum + entry.tokens.output, 0),
				totalDurationMs: payload.entries.reduce((sum, entry) => sum + entry.durationMs, 0),
				byPhase: {},
				byAgent: {},
			};
			const out = { ...payload, summary, timestamp: 123 };
			calls.logPayloads.push(out);
			return out;
		},
		buildTeamTranscript: ({ run, consensusModel }) => ({
			teamName: run.teamName,
			runId: run.runId,
			agentCount: Object.keys(run.members).length,
			leadLine: `Team lead: Running team \"${run.teamName}\".`,
			sections: [{ phase: "synthesis", title: "Synthesis", statusLine: consensusModel, entries: [] }],
		}),
	};

	(deps as any).__queues = { draftQueue, discussionQueue, synthesisQueue };
	return { deps, calls };
}

function queueResults(
	deps: OrchestratorDependencies,
	kind: "draftQueue" | "discussionQueue" | "synthesisQueue",
	member: string,
	...items: Array<RunSessionResult | Error>
): void {
	const queues = (deps as any).__queues[kind] as Map<string, Array<RunSessionResult | Error>>;
	queues.set(member, items);
}

test("orchestrateTeamRun executes phases in order and returns structured success result", async () => {
	const team = makeTeam();
	const { deps, calls } = createDeps();
	queueResults(deps, "draftQueue", "claude", result("Claude draft"));
	queueResults(deps, "draftQueue", "codex", result("Codex draft"));
	queueResults(deps, "draftQueue", "gemini", result("Gemini draft"));
	queueResults(deps, "discussionQueue", "claude", result("Claude round 1"), result("Claude round 2"));
	queueResults(deps, "discussionQueue", "codex", result("Codex round 1"), result("Codex round 2"));
	queueResults(deps, "discussionQueue", "gemini", result("Gemini round 1"), result("Gemini round 2"));
	queueResults(deps, "synthesisQueue", "consensus", result("Final synthesis", 30, 40));

	const outcome = await orchestrateTeamRun({ cwd: "/workspace", team, task: "Design run_team.", availability: makeAvailability() }, deps);

	assert.equal(outcome.ok, true);
	assert.equal(outcome.result.runId, "planning-team-001");
	assert.equal(outcome.result.finalOutput, "Final synthesis");
	assert.deepEqual(outcome.result.agents, ["claude", "codex", "gemini"]);
	assert.equal(calls.createSession.length, 4);
	assert.deepEqual(calls.createSession.map((entry) => entry.purpose), ["phase", "phase", "phase", "synthesis"]);
	assert.equal(calls.draft.length, 3);
	assert.equal(calls.discussion.length, 6);
	assert.equal(calls.synthesis.length, 1);
	assert.equal(calls.artifactsRunId, "planning-team-001");
	assert.equal(calls.logPayloads.length, 1);
	assert.equal(outcome.details.run.draftResponses.claude, "Claude draft");
	assert.equal(outcome.details.run.discussionRounds[1]?.responses.codex, "Codex round 2");
	assert.equal(outcome.details.run.synthesis, "Final synthesis");
});

test("orchestrateTeamRun continues after one draft failure when two members still succeed", async () => {
	const team = makeTeam();
	const { deps } = createDeps();
	queueResults(deps, "draftQueue", "claude", result("Claude draft"));
	queueResults(deps, "draftQueue", "codex", result("Codex draft"));
	queueResults(deps, "draftQueue", "gemini", new Error("timed out"));
	queueResults(deps, "discussionQueue", "claude", result("Claude round 1"), result("Claude round 2"));
	queueResults(deps, "discussionQueue", "codex", result("Codex round 1"), result("Codex round 2"));
	queueResults(deps, "synthesisQueue", "consensus", result("Final synthesis"));

	const outcome = await orchestrateTeamRun({ cwd: "/workspace", team, task: "Design run_team.", availability: makeAvailability() }, deps);

	assert.equal(outcome.ok, true);
	assert.deepEqual(Object.keys(outcome.details.run.draftResponses), ["claude", "codex"]);
	assert.equal(outcome.details.run.members.gemini.status, "error");
	assert.match(outcome.details.run.members.gemini.error ?? "", /timed out/i);
	assert.equal(outcome.details.comm.entries.some((entry) => entry.status === "error" && entry.from === "gemini"), true);
});

test("orchestrateTeamRun fails when fewer than two draft outputs succeed", async () => {
	const team = makeTeam();
	const { deps, calls } = createDeps();
	queueResults(deps, "draftQueue", "claude", result("Claude draft"));
	queueResults(deps, "draftQueue", "codex", new Error("timed out"));
	queueResults(deps, "draftQueue", "gemini", new Error("rate limited"));

	const outcome = await orchestrateTeamRun({ cwd: "/workspace", team, task: "Design run_team.", availability: makeAvailability() }, deps);

	assert.equal(outcome.ok, false);
	assert.match(outcome.error ?? "", /fewer than 2 draft outputs succeeded/i);
	assert.equal(calls.discussion.length, 0);
	assert.equal(calls.synthesis.length, 0);
	assert.equal(outcome.result.finalOutput, "");
	assert.equal(outcome.details.comm.entries.filter((entry) => entry.phase === "draft").length, 3);
});

test("orchestrateTeamRun uses the consensus model even when the matching member failed before synthesis", async () => {
	const team = makeTeam();
	const { deps, calls } = createDeps();
	queueResults(deps, "draftQueue", "claude", result("Claude draft"));
	queueResults(deps, "draftQueue", "codex", result("Codex draft"));
	queueResults(deps, "draftQueue", "gemini", result("Gemini draft"));
	queueResults(deps, "discussionQueue", "claude", result("Claude round 1"), new Error("claude failed in round 2"));
	queueResults(deps, "discussionQueue", "codex", result("Codex round 1"), result("Codex round 2"));
	queueResults(deps, "discussionQueue", "gemini", result("Gemini round 1"), result("Gemini round 2"));
	queueResults(deps, "synthesisQueue", "consensus", result("Final synthesis"));

	const outcome = await orchestrateTeamRun({ cwd: "/workspace", team, task: "Design run_team.", availability: makeAvailability() }, deps);

	assert.equal(outcome.ok, true);
	assert.equal(outcome.result.finalOutput, "Final synthesis");
	assert.equal(calls.synthesis.length, 1);
	assert.equal(outcome.details.run.members.claude.status, "error");
});

test("orchestrateTeamRun can synthesize with an external consensus model", async () => {
	const team = {
		...makeTeam(),
		consensus: { model: "openrouter/consensus-model" },
	};
	const { deps, calls } = createDeps();
	queueResults(deps, "draftQueue", "claude", result("Claude draft"));
	queueResults(deps, "draftQueue", "codex", result("Codex draft"));
	queueResults(deps, "draftQueue", "gemini", result("Gemini draft"));
	queueResults(deps, "discussionQueue", "claude", result("Claude round 1"), result("Claude round 2"));
	queueResults(deps, "discussionQueue", "codex", result("Codex round 1"), result("Codex round 2"));
	queueResults(deps, "discussionQueue", "gemini", result("Gemini round 1"), result("Gemini round 2"));
	queueResults(deps, "synthesisQueue", "consensus", result("External synthesis", 30, 40));

	const outcome = await orchestrateTeamRun({
		cwd: "/workspace",
		team,
		task: "Design run_team.",
		availability: makeAvailability({
			consensusModel: "openrouter/consensus-model",
			consensusModelAvailable: true,
		}),
	}, deps);

	assert.equal(outcome.ok, true);
	assert.equal(outcome.result.finalOutput, "External synthesis");
	assert.deepEqual(calls.createSession.at(-1), { member: "consensus", purpose: "synthesis" });
	assert.equal(outcome.details.comm.entries.at(-1)?.from, "consensus");
	assert.equal(outcome.details.comm.entries.at(-1)?.model, "openrouter/consensus-model");
});

test("orchestrateTeamRun records actual round prompts in run state", async () => {
	const team = makeTeam();
	const { deps } = createDeps();
	queueResults(deps, "draftQueue", "claude", result("Claude draft"));
	queueResults(deps, "draftQueue", "codex", result("Codex draft"));
	queueResults(deps, "draftQueue", "gemini", result("Gemini draft"));
	queueResults(deps, "discussionQueue", "claude", result("Claude round 1"), result("Claude round 2"));
	queueResults(deps, "discussionQueue", "codex", result("Codex round 1"), result("Codex round 2"));
	queueResults(deps, "discussionQueue", "gemini", result("Gemini round 1"), result("Gemini round 2"));
	queueResults(deps, "synthesisQueue", "consensus", result("Final synthesis"));

	const outcome = await orchestrateTeamRun({ cwd: "/workspace", team, task: "Design run_team.", availability: makeAvailability() }, deps);

	const round1Prompt = outcome.details.run.discussionRounds[0]?.promptByMember.claude ?? "";
	const round2Prompt = outcome.details.run.discussionRounds[1]?.promptByMember.claude ?? "";
	assert.match(round1Prompt, /The other team members have produced their drafts/i);
	assert.match(round1Prompt, /### codex/);
	assert.match(round1Prompt, /Codex draft/);
	assert.doesNotMatch(round1Prompt, /### claude/);
	assert.match(round2Prompt, /Round 2 of discussion/i);
	assert.match(round2Prompt, /### codex/);
	assert.match(round2Prompt, /Codex round 1/);
	assert.doesNotMatch(round2Prompt, /### claude/);
});

test("orchestrateTeamRun creates isolated run state across multiple executions", async () => {
	const team = makeTeam();
	const first = createDeps();
	queueResults(first.deps, "draftQueue", "claude", result("First claude draft"));
	queueResults(first.deps, "draftQueue", "codex", result("First codex draft"));
	queueResults(first.deps, "draftQueue", "gemini", new Error("timed out"));
	queueResults(first.deps, "discussionQueue", "claude", result("First claude round 1"), result("First claude round 2"));
	queueResults(first.deps, "discussionQueue", "codex", result("First codex round 1"), result("First codex round 2"));
	queueResults(first.deps, "synthesisQueue", "consensus", result("First synthesis"));
	const firstOutcome = await orchestrateTeamRun({ cwd: "/workspace", team, task: "Design run_team.", availability: makeAvailability() }, first.deps);

	const second = createDeps();
	queueResults(second.deps, "draftQueue", "claude", result("Second claude draft"));
	queueResults(second.deps, "draftQueue", "codex", result("Second codex draft"));
	queueResults(second.deps, "draftQueue", "gemini", result("Second gemini draft"));
	queueResults(second.deps, "discussionQueue", "claude", result("Second claude round 1"), result("Second claude round 2"));
	queueResults(second.deps, "discussionQueue", "codex", result("Second codex round 1"), result("Second codex round 2"));
	queueResults(second.deps, "discussionQueue", "gemini", result("Second gemini round 1"), result("Second gemini round 2"));
	queueResults(second.deps, "synthesisQueue", "consensus", result("Second synthesis"));
	const secondOutcome = await orchestrateTeamRun({ cwd: "/workspace", team, task: "Design run_team again.", availability: makeAvailability() }, second.deps);

	assert.equal(firstOutcome.details.run.draftResponses.claude, "First claude draft");
	assert.equal(secondOutcome.details.run.draftResponses.claude, "Second claude draft");
	assert.equal(firstOutcome.details.run.members.gemini.status, "error");
	assert.equal(secondOutcome.details.run.members.gemini.status, "done");
	assert.doesNotMatch(JSON.stringify(secondOutcome.details.run), /First claude draft/);
});

test("orchestrateTeamRun uses distinct managed sessions when multiple members share the same name", async () => {
	const planner = makeAgent("planner");
	const team: ResolvedTeamConfig = {
		name: "Planning Team",
		description: "Multi-model planning team",
		file: "/tmp/planning-team.yaml",
		agents: [
			{ name: "planner", model: "openrouter/deepseek/deepseek-v3.2" },
			{ name: "planner", model: "openrouter/openai/gpt-5.4" },
			{ name: "planner", model: "openrouter/google/gemini-3.1-pro-preview" },
		],
		thinking: { draft: "highest", discussion: "high", synthesis: "high" },
		consensus: { model: "openrouter/deepseek/deepseek-v3.2" },
		members: [
			{ key: "planner|openrouter/deepseek/deepseek-v3.2|000", name: "planner", model: "openrouter/deepseek/deepseek-v3.2", agent: planner },
			{ key: "planner|openrouter/openai/gpt-5.4|001", name: "planner", model: "openrouter/openai/gpt-5.4", agent: planner },
			{ key: "planner|openrouter/google/gemini-3.1-pro-preview|002", name: "planner", model: "openrouter/google/gemini-3.1-pro-preview", agent: planner },
		],
	};
	const availability: TeamAvailability = {
		team: "Planning Team",
		availableMembers: team.members.map((member) => ({ key: member.key, name: member.name, model: member.model, available: true })),
		unavailableMembers: [],
		consensusModel: "openrouter/deepseek/deepseek-v3.2",
		consensusModelAvailable: true,
		checkedAt: 1,
	};

	const draftSessionKeys: string[] = [];
	const discussionSessionKeys: string[] = [];
	const { deps } = createDeps();
	deps.createSession = async ({ member, purpose }) => ({
		memberKey: member.key,
		memberName: member.name,
		model: member.model,
		session: {
			messages: [],
			subscribe: () => () => {},
			prompt: async () => {},
			dispose: () => {},
			abort: async () => {},
			memberKey: member.key,
			purpose,
		} as ManagedSession["session"] & { memberKey: string; purpose: string },
	});
	deps.runDraft = async ({ session }) => {
		draftSessionKeys.push((session as { memberKey: string }).memberKey);
		return result(`Draft for ${(session as { memberKey: string }).memberKey}`);
	};
	deps.runDiscussion = async ({ session }) => {
		discussionSessionKeys.push((session as { memberKey: string }).memberKey);
		return result(`Discussion for ${(session as { memberKey: string }).memberKey}`);
	};
	deps.runSynthesis = async () => result("Final synthesis");

	const outcome = await orchestrateTeamRun({ cwd: "/workspace", team, task: "Design run_team.", availability }, deps);

	assert.equal(outcome.ok, true);
	assert.deepEqual(draftSessionKeys, team.members.map((member) => member.key));
	assert.deepEqual(discussionSessionKeys, [
		team.members[0]!.key,
		team.members[1]!.key,
		team.members[2]!.key,
		team.members[0]!.key,
		team.members[1]!.key,
		team.members[2]!.key,
	]);
});
