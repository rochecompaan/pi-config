import assert from "node:assert/strict";
import test from "node:test";
import {
	AUTO_HANDOFF_GOAL,
	DEFAULT_AUTO_THRESHOLD_TOKENS,
	parseHandoffCommand,
	resolveAutoThresholdTokens,
	shouldTriggerAutoHandoff,
	transitionAutoHandoffState,
} from "../../extensions/handoff-auto.ts";

test("uses the default when no threshold exists", () => {
	assert.equal(
		resolveAutoThresholdTokens({ globalSettings: {}, projectTrusted: false }),
		150_000,
	);
});

test("uses a valid global threshold", () => {
	assert.equal(
		resolveAutoThresholdTokens({
			globalSettings: { handoff: { autoThresholdTokens: 90_000 } },
			projectTrusted: false,
		}),
		90_000,
	);
});

test("uses a valid trusted project threshold", () => {
	assert.equal(
		resolveAutoThresholdTokens({
			globalSettings: { handoff: { autoThresholdTokens: 90_000 } },
			projectSettings: { handoff: { autoThresholdTokens: 120_000 } },
			projectTrusted: true,
		}),
		120_000,
	);
});

test("ignores an untrusted project threshold", () => {
	assert.equal(
		resolveAutoThresholdTokens({
			globalSettings: { handoff: { autoThresholdTokens: 90_000 } },
			projectSettings: { handoff: { autoThresholdTokens: 1 } },
			projectTrusted: false,
		}),
		90_000,
	);
});

test("uses the default for invalid effective values", () => {
	for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "120000", null]) {
		assert.equal(
			resolveAutoThresholdTokens({
				globalSettings: { handoff: { autoThresholdTokens: 90_000 } },
				projectSettings: { handoff: { autoThresholdTokens: value } },
				projectTrusted: true,
			}),
			DEFAULT_AUTO_THRESHOLD_TOKENS,
		);
	}
});

test("parses internal, control, missing, and manual command forms", () => {
	assert.deepEqual(parseHandoffCommand("--auto"), { kind: "internal-auto" });
	assert.deepEqual(parseHandoffCommand("auto on"), { kind: "auto-control", action: "on" });
	assert.deepEqual(parseHandoffCommand("auto off"), { kind: "auto-control", action: "off" });
	assert.deepEqual(parseHandoffCommand("auto status"), { kind: "auto-control", action: "status" });
	assert.deepEqual(parseHandoffCommand(""), { kind: "missing-goal" });
	assert.deepEqual(parseHandoffCommand("continue phase one"), {
		kind: "manual",
		goal: "continue phase one",
	});
	assert.deepEqual(parseHandoffCommand("auto investigate the parser"), {
		kind: "manual",
		goal: "auto investigate the parser",
	});
});

test("triggers only for an armed idle TUI at or above the threshold", () => {
	const ready = {
		mode: "tui",
		idle: true,
		state: "armed" as const,
		usageTokens: 150_000,
		thresholdTokens: 150_000,
	};
	assert.equal(shouldTriggerAutoHandoff(ready), true);
	assert.equal(shouldTriggerAutoHandoff({ ...ready, usageTokens: 149_999 }), false);
	assert.equal(shouldTriggerAutoHandoff({ ...ready, usageTokens: undefined }), false);
	assert.equal(shouldTriggerAutoHandoff({ ...ready, mode: "print" }), false);
	assert.equal(shouldTriggerAutoHandoff({ ...ready, idle: false }), false);
	assert.equal(shouldTriggerAutoHandoff({ ...ready, state: "running" }), false);
	assert.equal(shouldTriggerAutoHandoff({ ...ready, state: "disabled" }), false);
});

test("applies every approved state transition", () => {
	assert.equal(transitionAutoHandoffState("disabled", { type: "session-start" }), "armed");
	assert.equal(transitionAutoHandoffState("armed", { type: "threshold-reached" }), "running");
	assert.equal(transitionAutoHandoffState("armed", { type: "auto-off" }), "disabled");
	assert.equal(transitionAutoHandoffState("running", { type: "attempt-failed" }), "disabled");
	assert.equal(
		transitionAutoHandoffState("disabled", {
			type: "auto-on",
			usageTokens: 149_999,
			thresholdTokens: 150_000,
		}),
		"armed",
	);
	assert.equal(
		transitionAutoHandoffState("disabled", {
			type: "auto-on",
			usageTokens: 150_000,
			thresholdTokens: 150_000,
		}),
		"running",
	);
});

test("exports the approved default and automatic goal", () => {
	assert.equal(DEFAULT_AUTO_THRESHOLD_TOKENS, 150_000);
	assert.equal(
		AUTO_HANDOFF_GOAL,
		"Continue the current task in a fresh session. Preserve the current objective, decisions, progress, blockers, and concrete next steps.",
	);
});
