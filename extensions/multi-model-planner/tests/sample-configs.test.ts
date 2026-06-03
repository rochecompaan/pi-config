import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadAgentDefinitions } from "../agent-loader.ts";
import { loadTeamConfigs } from "../team-config.ts";
import { getAllowedBuiltInToolNames } from "../tool-resolver.ts";

test("sample agents and teams load with reusable planner/review roles", async () => {
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
	const cwd = await mkdtemp(path.join(tmpdir(), "multi-model-planner-samples-"));
	const agentsDir = path.join(cwd, ".pi", "agents");
	await mkdir(agentsDir, { recursive: true });
	await symlink(path.join(repoRoot, "agents", "planner.md"), path.join(agentsDir, "planner.md"));
	await symlink(path.join(repoRoot, "agents", "reviewer.md"), path.join(agentsDir, "reviewer.md"));
	await symlink(
		path.join(repoRoot, "multi-model-planning-teams"),
		path.join(cwd, "multi-model-planning-teams"),
		"dir",
	);

	const agents = await loadAgentDefinitions({ cwd, allowedToolNames: getAllowedBuiltInToolNames() });
	const teams = await loadTeamConfigs({ cwd, agents });

	assert.equal(agents.has("planner"), true);
	assert.equal(agents.has("reviewer"), true);
	assert.equal(teams.ordered.length, 2);
	assert.deepEqual(teams.ordered.map((team) => team.name), ["Planning Team", "Review Team"]);

	for (const team of teams.ordered) {
		const expectedAgentName = team.name === "Planning Team" ? "planner" : "reviewer";
		assert.equal(team.members.length, 4);
		assert.ok(team.members.every((member) => member.name === expectedAgentName));
		assert.ok(team.members.every((member) => member.model.includes("/")));
		assert.equal(team.consensus.model.includes("/"), true);
	}
});
