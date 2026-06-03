import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseAgentDefinition } from "../agent-loader.ts";
import {
	discoverTeamConfigFiles,
	findNearestProjectTeamsDir,
	getTeamConfig,
	loadTeamConfigs,
	parseTeamConfig,
} from "../team-config.ts";
import type { ResolvedAgentDef } from "../types.ts";

const ALLOWED_TOOLS = new Set(["read", "bash", "write", "edit"]);

function makeAgents(...names: string[]): Map<string, ResolvedAgentDef> {
	return new Map(
		names.map((name) => [
			name.toLowerCase(),
			parseAgentDefinition(
				`---
name: ${name}
description: ${name} agent
tools: read, bash
---

You are ${name}.`,
				`/tmp/${name}.md`,
				ALLOWED_TOOLS,
			),
		]),
	);
}

async function makeTempDir(prefix = "multi-model-planner-team-config-") {
	return mkdtemp(path.join(tmpdir(), prefix));
}

test("parseTeamConfig parses a valid team and resolves members", () => {
	const agents = makeAgents("claude", "codex", "gemini");
	const content = `name: Planning Team
description: Multi-model planning team

agents:
  - name: claude
    model: anthropic/claude-opus-4.6
  - name: codex
    model: openai/gpt-5.4
  - name: gemini
    model: google/gemini-2.5-pro

thinking:
  draft: highest
  discussion: high
  synthesis: high

consensus:
  model: anthropic/claude-opus-4.6
`;

	const team = parseTeamConfig(content, "/tmp/planning-team.yaml", agents);

	assert.equal(team.name, "Planning Team");
	assert.equal(team.description, "Multi-model planning team");
	assert.equal(team.file, "/tmp/planning-team.yaml");
	assert.equal(team.agents.length, 3);
	assert.equal(team.members.length, 3);
	assert.equal(team.members[0]?.agent.name, "claude");
	assert.equal(team.agents[1]?.model, "openai/gpt-5.4");
	assert.equal(team.thinking.draft, "highest");
	assert.equal(team.consensus.model, "anthropic/claude-opus-4.6");
});

test("parseTeamConfig rejects undefined agents", () => {
	const agents = makeAgents("claude");
	const content = `name: Planning Team
description: Multi-model planning team
agents:
  - name: codex
    model: openai/gpt-5.4
thinking:
  draft: high
  discussion: high
  synthesis: high
consensus:
  model: openai/gpt-5.4
`;

	assert.throws(() => parseTeamConfig(content, "/tmp/missing-agent.yaml", agents), /undefined agent/i);
});

test("parseTeamConfig rejects missing explicit models", () => {
	const agents = makeAgents("claude");
	const content = `name: Planning Team
description: Multi-model planning team
agents:
  - name: claude
thinking:
  draft: high
  discussion: high
  synthesis: high
consensus:
  model: anthropic/claude-opus-4.6
`;

	assert.throws(() => parseTeamConfig(content, "/tmp/missing-model.yaml", agents), /agents\[0\]\.model/i);
});

test("parseTeamConfig rejects invalid thinking settings", () => {
	const agents = makeAgents("claude");
	const content = `name: Planning Team
description: Multi-model planning team
agents:
  - name: claude
    model: anthropic/claude-opus-4.6
thinking:
  draft: maximal
  discussion: high
  synthesis: high
consensus:
  model: anthropic/claude-opus-4.6
`;

	assert.throws(() => parseTeamConfig(content, "/tmp/invalid-thinking.yaml", agents), /thinking\.draft/i);
});

test("parseTeamConfig accepts an external consensus model", () => {
	const agents = makeAgents("claude");
	const content = `name: Planning Team
description: Multi-model planning team
agents:
  - name: claude
    model: anthropic/claude-opus-4.6
thinking:
  draft: high
  discussion: high
  synthesis: high
consensus:
  model: openrouter/consensus-model
`;

	const team = parseTeamConfig(content, "/tmp/external-consensus.yaml", agents);
	assert.equal(team.consensus.model, "openrouter/consensus-model");
	assert.equal(team.members.length, 1);
});

test("findNearestProjectTeamsDir finds the closest multi-model-planning-teams ancestor", async () => {
	const root = await makeTempDir();
	const nested = path.join(root, "a", "b", "c");
	await mkdir(path.join(root, "multi-model-planning-teams"), { recursive: true });
	await mkdir(nested, { recursive: true });

	const found = await findNearestProjectTeamsDir(nested);
	assert.equal(found, path.join(root, "multi-model-planning-teams"));
});

test("discoverTeamConfigFiles returns sorted yaml and yml files only", async () => {
	const root = await makeTempDir();
	const teamsDir = path.join(root, "multi-model-planning-teams");
	await mkdir(teamsDir, { recursive: true });
	await writeFile(path.join(teamsDir, "zeta.yaml"), "", "utf8");
	await writeFile(path.join(teamsDir, "alpha.yml"), "", "utf8");
	await writeFile(path.join(teamsDir, "ignore.md"), "", "utf8");

	const files = await discoverTeamConfigFiles(root);
	assert.deepEqual(files, [path.join(teamsDir, "alpha.yml"), path.join(teamsDir, "zeta.yaml")]);
});

test("loadTeamConfigs orders teams alphabetically by team name and supports case-insensitive lookup", async () => {
	const root = await makeTempDir();
	const teamsDir = path.join(root, "multi-model-planning-teams");
	await mkdir(teamsDir, { recursive: true });
	await writeFile(
		path.join(teamsDir, "b.yaml"),
		`name: Review Team
description: Review team
agents:
  - name: codex
    model: openai/gpt-5.4
thinking:
  draft: high
  discussion: medium
  synthesis: high
consensus:
  model: openai/gpt-5.4
`,
		"utf8",
	);
	await writeFile(
		path.join(teamsDir, "a.yaml"),
		`name: Planning Team
description: Planning team
agents:
  - name: claude
    model: anthropic/claude-opus-4.6
thinking:
  draft: highest
  discussion: high
  synthesis: high
consensus:
  model: anthropic/claude-opus-4.6
`,
		"utf8",
	);

	const agents = makeAgents("claude", "codex");
	const registry = await loadTeamConfigs({ cwd: root, agents });
	assert.deepEqual(registry.ordered.map((team) => team.name), ["Planning Team", "Review Team"]);
	assert.equal(getTeamConfig(registry, "planning team").name, "Planning Team");
	assert.equal(getTeamConfig(registry, "REVIEW TEAM").name, "Review Team");
});

test("loadTeamConfigs rejects duplicate normalized team names", async () => {
	const root = await makeTempDir();
	const teamsDir = path.join(root, "multi-model-planning-teams");
	await mkdir(teamsDir, { recursive: true });
	await writeFile(
		path.join(teamsDir, "one.yaml"),
		`name: Planning Team
description: One
agents:
  - name: claude
    model: anthropic/claude-opus-4.6
thinking:
  draft: high
  discussion: high
  synthesis: high
consensus:
  model: anthropic/claude-opus-4.6
`,
		"utf8",
	);
	await writeFile(
		path.join(teamsDir, "two.yaml"),
		`name: planning team
description: Two
agents:
  - name: claude
    model: anthropic/claude-opus-4.6
thinking:
  draft: high
  discussion: high
  synthesis: high
consensus:
  model: anthropic/claude-opus-4.6
`,
		"utf8",
	);

	const agents = makeAgents("claude");
	await assert.rejects(() => loadTeamConfigs({ cwd: root, agents }), /duplicate team name/i);
});

test("getTeamConfig fails clearly for missing teams", () => {
	assert.throws(
		() => getTeamConfig({ byName: new Map(), ordered: [] }, "Unknown Team"),
		/does not exist/i,
	);
});
