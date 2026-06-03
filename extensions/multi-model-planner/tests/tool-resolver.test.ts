import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_PI_TOOL_NAMES,
	getAllowedBuiltInToolNames,
	resolveBuiltInToolNames,
	resolveBuiltInTools,
} from "../tool-resolver.ts";
import { parseAgentDefinition } from "../agent-loader.ts";

const ALLOWED_TOOLS = new Set(DEFAULT_PI_TOOL_NAMES);

function makeAgent(tools: string) {
	return parseAgentDefinition(
		`---
name: claude
description: Senior planning agent
tools: ${tools}
---

You are Claude.
`,
		"/tmp/claude.md",
		ALLOWED_TOOLS,
	);
}

test("getAllowedBuiltInToolNames returns the full default v1 built-in tool list", () => {
	assert.deepEqual(getAllowedBuiltInToolNames(), ["read", "bash", "edit", "write", "grep", "find", "ls"]);
});

test("resolveBuiltInToolNames preserves requested order and removes duplicates", () => {
	const names = resolveBuiltInToolNames(["read", "bash", "read", "grep"]);
	assert.deepEqual(names, ["read", "bash", "grep"]);
});

test("resolveBuiltInToolNames rejects unsupported tool names", () => {
	assert.throws(() => resolveBuiltInToolNames(["read", "deploy"]), /unsupported built-in tools: deploy/i);
});

test("resolveBuiltInTools maps agent tool names to a built-in tool allowlist", () => {
	const agent = makeAgent("read, bash, grep");
	const tools = resolveBuiltInTools({
		agent,
	});

	assert.deepEqual(tools, ["read", "bash", "grep"]);
});

test("resolveBuiltInTools rejects tools outside the supported default set even if passed directly", () => {
	const agent = {
		...makeAgent("read"),
		toolNames: ["read", "deploy"],
	};

	assert.throws(
		() =>
			resolveBuiltInTools({
				agent,
			}),
		/unsupported built-in tools: deploy/i,
	);
});
