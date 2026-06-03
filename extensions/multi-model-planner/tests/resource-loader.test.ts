import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import {
	buildMemberResourceLoaderOptions,
	createMemberResourceLoaderConfig,
} from "../resource-loader.ts";

test("createMemberResourceLoaderConfig disables extensions skills prompts themes and AGENTS.md context", () => {
	const config = createMemberResourceLoaderConfig({
		cwd: "/workspace/project",
		systemPrompt: "You are Claude.",
	});

	assert.equal(config.cwd, "/workspace/project");
	assert.equal(config.agentDir, path.join(homedir(), ".pi", "agent"));
	assert.equal(config.noExtensions, true);
	assert.equal(config.noSkills, true);
	assert.equal(config.noPromptTemplates, true);
	assert.equal(config.noThemes, true);
	assert.equal(config.noContextFiles, true);
	assert.equal(config.preserveAgentsFiles, false);
	assert.equal(typeof config.systemPromptOverride, "function");
	assert.equal(config.systemPromptOverride?.("base prompt"), "You are Claude.");
});

test("buildMemberResourceLoaderOptions returns DefaultResourceLoader-compatible options", () => {
	const options = buildMemberResourceLoaderOptions({
		cwd: "/workspace/project",
		systemPrompt: "You are Codex.",
	});

	assert.equal(options.cwd, "/workspace/project");
	assert.equal(options.agentDir, path.join(homedir(), ".pi", "agent"));
	assert.equal(options.noExtensions, true);
	assert.equal(options.noSkills, true);
	assert.equal(options.noPromptTemplates, true);
	assert.equal(options.noThemes, true);
	assert.equal(options.noContextFiles, true);
	assert.equal(options.systemPromptOverride?.("ignored"), "You are Codex.");
	assert.deepEqual(options.agentsFilesOverride?.({ agentsFiles: [{ path: "/tmp/AGENTS.md", content: "x" }] }), {
		agentsFiles: [],
	});
});
