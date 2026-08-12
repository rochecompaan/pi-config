import test from "node:test";
import assert from "node:assert/strict";
import {
	runVerifiedFixWorkflow,
	type VerifiedFixWorkflowDependencies,
} from "./review-verified-fix-workflow.ts";

const SUMMARY = `## Review Scope
- review extension

## Verdict
- needs attention

## Findings
- [P1] Fix action trusts findings without checking
  - File location: extensions/review/index.ts:2404
  - Why it matters: invalid findings can cause regressions.
  - What should change: verify each finding first.

- [P2] Verification rationale is not preserved
  - File location: extensions/review/index.ts:2654
  - Why it matters: users cannot audit rejected findings.
  - What should change: record a decision and reason.

## Fix Queue
1. Verify findings.
2. Fix agreed findings.

## Constraints & Preferences
- (none)

## Human Reviewer Callouts (Non-Blocking)
- (none)

<!-- END REVIEW SUMMARY -->`;

function createWorkflowHarness(
	reports: Array<{ id: string; text: string; stopReason?: string }>,
	initialTools = ["read", "edit", "write", "bash"],
) {
	let activeTools = [...initialTools];
	let latestSnapshot: { id: string; text: string; stopReason?: string } | null = {
		id: "review-summary",
		text: SUMMARY,
	};
	const sentPrompts: string[] = [];
	const toolHistory: string[][] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	let pendingReport = 0;

	const dependencies: VerifiedFixWorkflowDependencies = {
		getActiveTools: () => [...activeTools],
		setActiveTools: (toolNames) => {
			activeTools = [...toolNames];
			toolHistory.push([...toolNames]);
		},
		getLastAssistantSnapshot: () => latestSnapshot,
		sendUserMessage: (prompt) => {
			sentPrompts.push(prompt);
			latestSnapshot = reports[pendingReport++] ?? latestSnapshot;
		},
		waitForTurnToStart: async () => true,
		waitForIdle: async () => {},
		notify: (message, level) => notifications.push({ message, level }),
	};

	return {
		dependencies,
		get activeTools() {
			return activeTools;
		},
		sentPrompts,
		toolHistory,
		notifications,
	};
}

test("verified workflow disables mutation tools, records decisions, and fixes only agreed findings", async () => {
	const harness = createWorkflowHarness([
		{
			id: "verification",
			text: `## Finding Verification
### F1
- Decision: Agree
- Reason: The current action queues every finding without an evidence check.

### F2
- Decision: Disagree
- Reason: The report remains in the session transcript.
`,
		},
		{ id: "fix", text: "Fixed F1 and ran tests." },
	]);

	assert.equal(await runVerifiedFixWorkflow(SUMMARY, harness.dependencies), "ok");
	assert.deepEqual(harness.toolHistory[0], ["read"]);
	assert.ok(harness.activeTools.includes("edit"));
	assert.ok(harness.activeTools.includes("write"));
	assert.equal(harness.sentPrompts.length, 2);
	assert.match(harness.sentPrompts[0], /verification-only turn/i);
	assert.match(harness.sentPrompts[1], /F1 — \[P1\]/);
	assert.doesNotMatch(harness.sentPrompts[1], /F2 — \[P2\]/);
	assert.ok(
		harness.notifications.some(({ message }) => message.includes("1 agreed, 1 disagreed")),
	);
});

test("verified workflow removes unknown tools during verification and restores the exact active set", async () => {
	const initialTools = ["read", "grep", "apply_patch", "subagent", "custom_mutator"];
	const harness = createWorkflowHarness(
		[
			{
				id: "verification",
				text: `## Finding Verification
### F1
- Decision: Disagree
- Reason: Not reproducible.

### F2
- Decision: Disagree
- Reason: Not reproducible.
`,
			},
		],
		initialTools,
	);

	assert.equal(await runVerifiedFixWorkflow(SUMMARY, harness.dependencies), "noAgreedFindings");
	assert.deepEqual(harness.toolHistory[0], ["read", "grep"]);
	assert.deepEqual(harness.activeTools, initialTools);
});

test("verified workflow rejects a truncated summary before sending verification", async () => {
	const truncated = `## Review Scope
- review extension

## Verdict
- needs attention

## Findings
- [P1] Complete finding in a truncated summary
  - File location: demo.ts:1
  - Why it matters: It can regress.
  - What should change: Fix it.`;
	const harness = createWorkflowHarness([]);

	assert.equal(await runVerifiedFixWorkflow(truncated, harness.dependencies), "error");
	assert.equal(harness.sentPrompts.length, 0);
	assert.ok(harness.notifications.some(({ message }) => message.includes("must end with")));
});

test("verified workflow queues no fix turn when every finding is rejected", async () => {
	const harness = createWorkflowHarness([
		{
			id: "verification",
			text: `## Finding Verification
### F1
- Decision: Disagree
- Reason: The code already checks validity before editing.

### F2
- Decision: Disagree
- Reason: The rationale is persisted in the session.
`,
		},
	]);

	assert.equal(await runVerifiedFixWorkflow(SUMMARY, harness.dependencies), "noAgreedFindings");
	assert.equal(harness.sentPrompts.length, 1);
	assert.deepEqual(new Set(harness.activeTools), new Set(["read", "edit", "write", "bash"]));
});

test("verified workflow refuses to fix an incomplete verification report", async () => {
	const harness = createWorkflowHarness([
		{
			id: "verification",
			text: `## Finding Verification
### F1
- Decision: Agree
- Reason: Confirmed.
`,
		},
	]);

	assert.equal(await runVerifiedFixWorkflow(SUMMARY, harness.dependencies), "error");
	assert.equal(harness.sentPrompts.length, 1);
	assert.ok(harness.notifications.some(({ message }) => message.includes("expected '### F2' next")));
	assert.deepEqual(new Set(harness.activeTools), new Set(["read", "edit", "write", "bash"]));
});
