import test from "node:test";
import assert from "node:assert/strict";
import {
	QUICKFIX_BLOCKED_TOOLS,
	QUICKFIX_PROFILE_IDS,
	getQuickfixProfile,
	parseQuickfixCommand,
} from "./profiles.ts";

test("profiles expose the exact fixed skill allowlists", () => {
	assert.deepEqual(QUICKFIX_PROFILE_IDS, ["bug", "static", "docs", "mechanical"]);
	assert.deepEqual(getQuickfixProfile("bug").skills, [
		"systematic-debugging",
		"test-driven-development",
		"verification-before-completion",
		"module-size",
	]);
	assert.deepEqual(getQuickfixProfile("static").skills, [
		"verification-before-completion",
		"nix-config",
	]);
	assert.deepEqual(getQuickfixProfile("docs").skills, [
		"simple-english",
		"verification-before-completion",
	]);
	assert.deepEqual(getQuickfixProfile("mechanical").skills, [
		"verification-before-completion",
		"module-size",
	]);
});

test("orchestration tools are blocked", () => {
	assert.deepEqual([...QUICKFIX_BLOCKED_TOOLS], ["subagent", "run_team"]);
});

test("command parser keeps a request without an override", () => {
	assert.deepEqual(parseQuickfixCommand("Fix the empty-input crash"), {
		request: "Fix the empty-input crash",
		profileSpecified: false,
	});
});

test("command parser accepts separated and equals profile values", () => {
	assert.deepEqual(parseQuickfixCommand("--profile docs Rewrite the runbook"), {
		request: "Rewrite the runbook",
		profile: "docs",
		profileSpecified: true,
	});
	assert.deepEqual(parseQuickfixCommand("--profile=bug Fix the parser"), {
		request: "Fix the parser",
		profile: "bug",
		profileSpecified: true,
	});
});

test("command parser rejects missing and unknown profile values", () => {
	assert.equal(parseQuickfixCommand("--profile").error, "Missing value for --profile");
	assert.equal(
		parseQuickfixCommand("--profile feature Add a page").error,
		"Unknown quick-fix profile: feature. Available profiles: bug, static, docs, mechanical",
	);
});
