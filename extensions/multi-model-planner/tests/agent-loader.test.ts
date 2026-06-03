import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	discoverAgentDefinitionFiles,
	findNearestProjectAgentsDir,
	loadAgentDefinitions,
	normalizeToolList,
	parseAgentDefinition,
} from "../agent-loader.ts";

const ALLOWED_TOOLS = new Set(["read", "bash", "write", "edit"]);

async function makeTempDir(prefix = "multi-model-planner-agent-loader-") {
	return mkdtemp(path.join(tmpdir(), prefix));
}

test("normalizeToolList trims, removes empties, and deduplicates while preserving order", () => {
	assert.deepEqual(normalizeToolList(" read, bash ,read,, write , bash "), ["read", "bash", "write"]);
});

test("parseAgentDefinition parses valid frontmatter and markdown body", () => {
	const content = `---
name: claude
description: Senior planning agent
tools: read, bash, read
model: anthropic/claude-opus-4.6
thinking: high
---

You are a planner.`;

	const parsed = parseAgentDefinition(content, "/tmp/claude.md", ALLOWED_TOOLS);

	assert.equal(parsed.name, "claude");
	assert.equal(parsed.description, "Senior planning agent");
	assert.equal(parsed.tools, "read, bash, read");
	assert.deepEqual(parsed.toolNames, ["read", "bash"]);
	assert.equal(parsed.model, "anthropic/claude-opus-4.6");
	assert.equal(parsed.thinking, "high");
	assert.match(parsed.systemPrompt, /You are a planner\./);
	assert.equal(parsed.file, "/tmp/claude.md");
});

test("parseAgentDefinition rejects missing required fields", () => {
	const content = `---
name: claude
tools: read
---

Body`;

	assert.throws(
		() => parseAgentDefinition(content, "/tmp/missing-description.md", ALLOWED_TOOLS),
		/message\s+file .*missing required frontmatter field "description"|Agent file .*missing required frontmatter field "description"/i,
	);
});

test("parseAgentDefinition rejects invalid thinking levels", () => {
	const content = `---
name: claude
description: Senior planning agent
tools: read
thinking: maximal
---

Body`;

	assert.throws(
		() => parseAgentDefinition(content, "/tmp/invalid-thinking.md", ALLOWED_TOOLS),
		/invalid thinking value/i,
	);
});

test("parseAgentDefinition rejects unknown tools", () => {
	const content = `---
name: claude
description: Senior planning agent
tools: read, deploy
---

Body`;

	assert.throws(
		() => parseAgentDefinition(content, "/tmp/invalid-tools.md", ALLOWED_TOOLS),
		/references unknown tools: deploy/i,
	);
});

test("findNearestProjectAgentsDir finds the closest .pi/agents ancestor", async () => {
	const root = await makeTempDir();
	const nested = path.join(root, "a", "b", "c");
	await mkdir(path.join(root, ".pi", "agents"), { recursive: true });
	await mkdir(nested, { recursive: true });

	const found = await findNearestProjectAgentsDir(nested);
	assert.equal(found, path.join(root, ".pi", "agents"));
});

test("discoverAgentDefinitionFiles returns sorted markdown files only", async () => {
	const root = await makeTempDir();
	const agentsDir = path.join(root, ".pi", "agents");
	await mkdir(agentsDir, { recursive: true });
	await writeFile(path.join(agentsDir, "zeta.md"), "", "utf8");
	await writeFile(path.join(agentsDir, "alpha.md"), "", "utf8");
	await writeFile(path.join(agentsDir, "README.md"), "", "utf8");
	await writeFile(path.join(agentsDir, "ignore.txt"), "", "utf8");

	const files = await discoverAgentDefinitionFiles(root);
	assert.deepEqual(files, [path.join(agentsDir, "alpha.md"), path.join(agentsDir, "zeta.md")]);
});

test("discoverAgentDefinitionFiles falls back to packaged agents", async () => {
	const root = await makeTempDir();

	const files = await discoverAgentDefinitionFiles(root);

	assert.ok(files.some((file) => file.endsWith(path.join("agents", "planner.md"))));
	assert.ok(files.some((file) => file.endsWith(path.join("agents", "reviewer.md"))));
});

test("loadAgentDefinitions skips incompatible unrelated agent files", async () => {
	const root = await makeTempDir();
	const agentsDir = path.join(root, ".pi", "agents");
	await mkdir(agentsDir, { recursive: true });
	await writeFile(
		path.join(agentsDir, "planner.md"),
		`---
name: planner
description: Planner
tools: read
---

Plan.
`,
		"utf8",
	);
	await writeFile(
		path.join(agentsDir, "worker.md"),
		`---
name: worker
description: Worker
tools: contact_supervisor
---

Work.
`,
		"utf8",
	);

	const agents = await loadAgentDefinitions({ cwd: root, allowedToolNames: ALLOWED_TOOLS });
	assert.deepEqual([...agents.keys()], ["planner"]);
});

test("loadAgentDefinitions returns a map keyed by normalized agent name", async () => {
	const root = await makeTempDir();
	const agentsDir = path.join(root, ".pi", "agents");
	await mkdir(agentsDir, { recursive: true });
	await writeFile(
		path.join(agentsDir, "claude.md"),
		`---
name: Claude
description: Senior planning agent
tools: read, bash
thinking: medium
---

You are Claude.
`,
		"utf8",
	);
	await writeFile(
		path.join(agentsDir, "codex.md"),
		`---
name: codex
description: Reviewer
tools: read, write
---

You are Codex.
`,
		"utf8",
	);

	const agents = await loadAgentDefinitions({ cwd: root, allowedToolNames: ALLOWED_TOOLS });
	assert.deepEqual([...agents.keys()], ["claude", "codex"]);
	assert.equal(agents.get("claude")?.name, "Claude");
	assert.deepEqual(agents.get("claude")?.toolNames, ["read", "bash"]);
	assert.equal(agents.get("codex")?.systemPrompt.trim(), "You are Codex.");
});

test("loadAgentDefinitions rejects duplicate normalized agent names", async () => {
	const root = await makeTempDir();
	const agentsDir = path.join(root, ".pi", "agents");
	await mkdir(agentsDir, { recursive: true });
	await writeFile(
		path.join(agentsDir, "a.md"),
		`---
name: Claude
description: One
tools: read
---

Body
`,
		"utf8",
	);
	await writeFile(
		path.join(agentsDir, "b.md"),
		`---
name: claude
description: Two
tools: read
---

Body
`,
		"utf8",
	);

	await assert.rejects(
		() => loadAgentDefinitions({ cwd: root, allowedToolNames: ALLOWED_TOOLS }),
		/duplicate agent name/i,
	);
});
