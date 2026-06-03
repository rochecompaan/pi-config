import test from "node:test";
import assert from "node:assert/strict";
import {
	assertRunnableAvailability,
	checkAllTeamsAvailability,
	checkTeamAvailability,
	createAvailabilityStore,
	ensureAvailabilityChecked,
	refreshAvailabilityCache,
	type AvailabilityModelRegistry,
} from "../availability.ts";
import type { ResolvedTeamConfig, ResolvedAgentDef } from "../types.ts";

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

function makeRegistry(availableModels: string[]): AvailabilityModelRegistry {
	const available = new Set(availableModels);
	return {
		async checkModel(model: string) {
			return available.has(model)
				? { available: true }
				: { available: false, reason: `${model} is unavailable` };
		},
	};
}

test("checkTeamAvailability reports available and unavailable members plus consensus model state", async () => {
	const team = makeTeam();
	const availability = await checkTeamAvailability({
		team,
		modelRegistry: makeRegistry(["anthropic/claude-opus-4.6", "openai/gpt-5.4"]),
	});

	assert.equal(availability.team, "Planning Team");
	assert.equal(availability.availableMembers.length, 2);
	assert.equal(availability.unavailableMembers.length, 1);
	assert.equal(availability.unavailableMembers[0]?.name, "gemini");
	assert.equal(availability.consensusModel, "anthropic/claude-opus-4.6");
	assert.equal(availability.consensusModelAvailable, true);
});

test("checkTeamAvailability checks an external consensus model", async () => {
	const team = {
		...makeTeam(),
		consensus: { model: "openrouter/consensus-model" },
	};
	const availability = await checkTeamAvailability({
		team,
		modelRegistry: makeRegistry([
			"anthropic/claude-opus-4.6",
			"openai/gpt-5.4",
			"google/gemini-2.5-pro",
			"openrouter/consensus-model",
		]),
	});

	assert.equal(availability.availableMembers.length, 3);
	assert.equal(availability.consensusModel, "openrouter/consensus-model");
	assert.equal(availability.consensusModelAvailable, true);
});

test("assertRunnableAvailability fails when fewer than two members are available", () => {
	assert.throws(
		() =>
			assertRunnableAvailability({
				team: makeTeam(),
				availability: {
					team: "Planning Team",
					availableMembers: [{ name: "claude", model: "anthropic/claude-opus-4.6", available: true }],
					unavailableMembers: [
						{ name: "codex", model: "openai/gpt-5.4", available: false, reason: "no auth" },
						{ name: "gemini", model: "google/gemini-2.5-pro", available: false, reason: "no auth" },
					],
					consensusModel: "anthropic/claude-opus-4.6",
					consensusModelAvailable: true,
					checkedAt: 1,
				},
			}),
		/fewer than 2 members are available/i,
	);
});

test("assertRunnableAvailability fails when consensus model is unavailable", () => {
	assert.throws(
		() =>
			assertRunnableAvailability({
				team: makeTeam(),
				availability: {
					team: "Planning Team",
					availableMembers: [
						{ name: "codex", model: "openai/gpt-5.4", available: true },
						{ name: "gemini", model: "google/gemini-2.5-pro", available: true },
					],
					unavailableMembers: [
						{ name: "claude", model: "anthropic/claude-opus-4.6", available: false, reason: "no auth" },
					],
					consensusModel: "anthropic/claude-opus-4.6",
					consensusModelAvailable: false,
					checkedAt: 1,
				},
			}),
		/consensus model is unavailable/i,
	);
});

test("checkAllTeamsAvailability returns all teams and refreshAvailabilityCache stores results", async () => {
	const team = makeTeam();
	const otherTeam = { ...makeTeam(), name: "Review Team", file: "/tmp/review-team.yaml" };
	const store = createAvailabilityStore();

	const checked = await refreshAvailabilityCache({
		store,
		teams: [team, otherTeam],
		modelRegistry: makeRegistry([
			"anthropic/claude-opus-4.6",
			"openai/gpt-5.4",
			"google/gemini-2.5-pro",
		]),
	});

	assert.equal(checked.byTeam["planning team"]?.team, "Planning Team");
	assert.equal(checked.byTeam["review team"]?.team, "Review Team");
	assert.equal(store.cache?.byTeam["planning team"]?.availableMembers.length, 3);

	const all = await checkAllTeamsAvailability({
		teams: [team, otherTeam],
		modelRegistry: makeRegistry([
			"anthropic/claude-opus-4.6",
			"openai/gpt-5.4",
			"google/gemini-2.5-pro",
		]),
	});
	assert.equal(all.length, 2);
});

test("ensureAvailabilityChecked performs the first automatic check only once until refreshed", async () => {
	const team = makeTeam();
	const store = createAvailabilityStore();
	let calls = 0;
	const registry: AvailabilityModelRegistry = {
		async checkModel(model) {
			calls += 1;
			return { available: true, reason: model };
		},
	};

	await ensureAvailabilityChecked({ store, teams: [team], modelRegistry: registry });
	await ensureAvailabilityChecked({ store, teams: [team], modelRegistry: registry });

	assert.equal(calls, 3);
	assert.equal(store.hasChecked, true);
});
