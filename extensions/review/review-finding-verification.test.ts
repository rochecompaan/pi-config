import test from "node:test";
import assert from "node:assert/strict";
import {
	buildAgreedFindingsFixPrompt,
	buildFindingVerificationPrompt,
	extractReviewFindings,
	parseFindingVerificationReport,
} from "./review-finding-verification.ts";

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
1. [P1] Verify findings.
2. [P2] Fix agreed findings.

## Constraints & Preferences
- (none)

## Human Reviewer Callouts (Non-Blocking)
- (none)

<!-- END REVIEW SUMMARY -->`;

function summaryIds(summary: string) {
	return extractReviewFindings(summary).map(({ id, priority, title }) => ({ id, priority, title }));
}

test("extractReviewFindings assigns stable ids and stops before the fix queue", () => {
	const findings = extractReviewFindings(SUMMARY);

	assert.deepEqual(
		findings.map(({ id, priority, title }) => ({ id, priority, title })),
		[
			{ id: "F1", priority: "P1", title: "Fix action trusts findings without checking" },
			{ id: "F2", priority: "P2", title: "Verification rationale is not preserved" },
		],
	);
	assert.match(findings[0].markdown, /invalid findings can cause regressions/);
	assert.match(findings[1].markdown, /record a decision and reason/);
	assert.doesNotMatch(findings[1].markdown, /Fix Queue/);
});

test("extractReviewFindings accepts adjacent findings without a blank separator", () => {
	assert.deepEqual(
		summaryIds(`## Findings
- [P0] First finding
  - File location: demo.ts:1
- [P1] Replace the ECR cleanup loop with repository lifecycle policy
  - File location: demo.ts:2
`),
		[
			{ id: "F1", priority: "P0", title: "First finding" },
			{ id: "F2", priority: "P1", title: "Replace the ECR cleanup loop with repository lifecycle policy" },
		],
	);
});

test("extractReviewFindings tolerates common format drift", () => {
	assert.deepEqual(
		summaryIds(`Some preamble the model added.

### **Findings**
1. **[P1] Bold numbered finding**
   Free-form explanation without the usual fields.
* P2: Untagged-bracket finding
  - File location: demo.ts:9

#### Notes inside findings
- untagged commentary stays with the previous finding

- [p3] — Lowercase tag

## Fix Queue
1. [P0] Not a finding`),
		[
			{ id: "F1", priority: "P1", title: "Bold numbered finding" },
			{ id: "F2", priority: "P2", title: "Untagged-bracket finding" },
			{ id: "F3", priority: "P3", title: "Lowercase tag" },
		],
	);
});

test("extractReviewFindings returns no findings for an empty findings section", () => {
	assert.deepEqual(extractReviewFindings("## Findings\n- (none)\n\n## Fix Queue\n- (none)"), []);
});

test("extractReviewFindings fails when the summary has no Findings section", () => {
	assert.throws(() => extractReviewFindings("## Review Scope\n- [P1] Something"), /does not contain a Findings section/);
});

test("buildFindingVerificationPrompt creates a verification-only turn for every finding", () => {
	const { prompt, findings } = buildFindingVerificationPrompt(SUMMARY);

	assert.equal(findings.length, 2);
	assert.match(prompt, /verification-only turn/i);
	assert.match(prompt, /do not fix findings yet/i);
	assert.match(prompt, /### F1 — \[P1\]/);
	assert.match(prompt, /### F2 — \[P2\]/);
});

test("buildFindingVerificationPrompt rejects summaries without tagged findings", () => {
	assert.throws(
		() => buildFindingVerificationPrompt("## Findings\n- (none)\n"),
		/does not contain any \[P0\]-\[P3\] findings/,
	);
});

test("parseFindingVerificationReport reads the requested format", () => {
	const findings = extractReviewFindings(SUMMARY);
	const result = parseFindingVerificationReport(
		`## Finding Verification
### F1
- Decision: Agree
- Reason: The fix prompt currently queues every summarized finding.

### F2
- Decision: Disagree
- Reason: The summary remains visible in the session history.
  It is also kept in the branch entry.
`,
		findings,
	);

	assert.deepEqual(result, {
		ok: true,
		undecided: [],
		verifications: [
			{
				findingId: "F1",
				decision: "agree",
				reason: "The fix prompt currently queues every summarized finding.",
			},
			{
				findingId: "F2",
				decision: "disagree",
				reason: "The summary remains visible in the session history.\n  It is also kept in the branch entry.",
			},
		],
	});
});

test("parseFindingVerificationReport tolerates common format drift", () => {
	const findings = extractReviewFindings(SUMMARY);
	const result = parseFindingVerificationReport(
		`I checked both findings.

**F2 — Verification rationale is not preserved**
**Decision:** Disagree
**Reason:** Not reproducible.

## Finding Verification
### F1 — Agree
The current action queues every finding.

## Summary
One finding to fix.
`,
		findings,
	);

	assert.deepEqual(result, {
		ok: true,
		undecided: [],
		verifications: [
			{ findingId: "F1", decision: "agree", reason: "The current action queues every finding." },
			{ findingId: "F2", decision: "disagree", reason: "Not reproducible." },
		],
	});
});

test("parseFindingVerificationReport leaves missing, unclear, and contradictory findings undecided", () => {
	const findings = extractReviewFindings(`## Findings
- [P1] One
- [P1] Two
- [P1] Three
- [P1] Four
`);
	const result = parseFindingVerificationReport(
		`### F1
- Decision: Agree
- Reason: Confirmed.

### F2
- Decision: Maybe
- Reason: I agree it looks odd, but cannot confirm.

### F3
- Decision: Agree
- Decision: Disagree
`,
		findings,
	);

	assert.deepEqual(result, {
		ok: true,
		undecided: ["F2", "F3", "F4"],
		verifications: [{ findingId: "F1", decision: "agree", reason: "Confirmed." }],
	});
});

test("parseFindingVerificationReport fails when no decision can be read", () => {
	const findings = extractReviewFindings(SUMMARY);
	assert.deepEqual(parseFindingVerificationReport("I looked at the code and it seems fine.", findings), {
		ok: false,
		error: "Could not read an Agree or Disagree decision for any finding",
	});
});

test("buildAgreedFindingsFixPrompt includes only agreed findings", () => {
	const findings = extractReviewFindings(SUMMARY);
	const prompt = buildAgreedFindingsFixPrompt(findings, [
		{ findingId: "F1", decision: "agree", reason: "Confirmed in the current fix action." },
		{ findingId: "F2", decision: "disagree", reason: "The rationale is already retained." },
	]);

	assert.ok(prompt);
	assert.match(prompt, /F1 — \[P1\] Fix action trusts findings without checking/);
	assert.match(prompt, /Confirmed in the current fix action/);
	assert.doesNotMatch(prompt, /F2 — \[P2\]/);
	assert.doesNotMatch(prompt, /The rationale is already retained/);
});

test("buildAgreedFindingsFixPrompt returns null when every finding is rejected", () => {
	const findings = extractReviewFindings(SUMMARY);
	assert.equal(
		buildAgreedFindingsFixPrompt(
			findings,
			findings.map((finding) => ({
				findingId: finding.id,
				decision: "disagree" as const,
				reason: "Not valid in the current code.",
			})),
		),
		null,
	);
});
