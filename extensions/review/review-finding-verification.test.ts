import test from "node:test";
import assert from "node:assert/strict";
import {
	buildAgreedFindingsFixPrompt,
	buildFindingVerificationPrompt,
	extractReviewFindings,
	parseFindingVerificationReport,
} from "./review-finding-verification.ts";

const COMPLETE_SUMMARY_PREFIX = `## Review Scope
- review extension

## Verdict
- needs attention

`;
const COMPLETE_SUMMARY_SUFFIX = `
## Fix Queue
1. Fix findings.

## Constraints & Preferences
- (none)

## Human Reviewer Callouts (Non-Blocking)
- (none)

<!-- END REVIEW SUMMARY -->`;

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

test("buildFindingVerificationPrompt creates a verification-only turn for every finding", () => {
	const { prompt, findings } = buildFindingVerificationPrompt(SUMMARY);

	assert.equal(findings.length, 2);
	assert.match(prompt, /verification-only turn/i);
	assert.match(prompt, /do not fix findings yet/i);
	assert.match(prompt, /Decision must be exactly Agree or Disagree/);
	assert.match(prompt, /A reason is required for every decision/);
	assert.match(prompt, /### F1 — \[P1\]/);
	assert.match(prompt, /### F2 — \[P2\]/);
});

test("buildFindingVerificationPrompt rejects summaries without structured findings", () => {
	assert.throws(
		() =>
			buildFindingVerificationPrompt(`${COMPLETE_SUMMARY_PREFIX}## Findings
- (none)
${COMPLETE_SUMMARY_SUFFIX}`),
		/does not contain any structured findings/,
	);
});

test("extractReviewFindings fails closed when a priority tag does not start a finding", () => {
	assert.throws(
		() =>
			extractReviewFindings(`${COMPLETE_SUMMARY_PREFIX}## Findings
- Priority tag: [P1] Hidden finding
  - File location: demo.ts:1

- [P2] Parseable finding
  - File location: demo.ts:2
${COMPLETE_SUMMARY_SUFFIX}`),
		/Malformed finding line/,
	);
});

test("extractReviewFindings rejects nonblank content before the summary envelope", () => {
	assert.throws(
		() =>
			extractReviewFindings(`- [P0] Finding outside the envelope
  - File location: demo.ts:1
  - Why it matters: It is omitted.
  - What should change: Include it.

${SUMMARY}`),
		/must start with the exact '## Review Scope' heading/,
	);
});

test("extractReviewFindings rejects truncated summaries without the required envelope", () => {
	assert.throws(
		() =>
			extractReviewFindings(`## Review Scope
- review extension

## Verdict
- needs attention

## Findings
- [P1] Complete finding in a truncated summary
  - File location: demo.ts:1
  - Why it matters: It can regress.
  - What should change: Fix it.`),
		/must end with <!-- END REVIEW SUMMARY -->/,
	);
});

test("extractReviewFindings rejects untagged findings and missing required fields", () => {
	assert.throws(
		() =>
			extractReviewFindings(`${COMPLETE_SUMMARY_PREFIX}## Findings
- Untagged finding
  - File location: demo.ts:1
  - Why it matters: It can regress.
  - What should change: Fix it.

- [P2] Valid finding
  - File location: demo.ts:2
  - Why it matters: It can regress.
  - What should change: Fix it.
${COMPLETE_SUMMARY_SUFFIX}`),
		/Malformed finding line/,
	);

	assert.throws(
		() =>
			extractReviewFindings(`${COMPLETE_SUMMARY_PREFIX}## Findings
- [P1] Missing required field
  - File location: demo.ts:1
  - Why it matters: It can regress.
${COMPLETE_SUMMARY_SUFFIX}`),
		/missing or has a malformed What should change field/,
	);
});

test("parseFindingVerificationReport accepts complete agree and disagree decisions", () => {
	const findings = extractReviewFindings(SUMMARY);
	const result = parseFindingVerificationReport(
		`## Finding Verification
### F1
- Decision: Agree
- Reason: The fix prompt currently queues every summarized finding.

### F2
- Decision: Disagree
- Reason: The summary remains visible in the session history.
`,
		findings,
	);

	assert.deepEqual(result, {
		ok: true,
		verifications: [
			{
				findingId: "F1",
				decision: "agree",
				reason: "The fix prompt currently queues every summarized finding.",
			},
			{
				findingId: "F2",
				decision: "disagree",
				reason: "The summary remains visible in the session history.",
			},
		],
	});
});

test("parseFindingVerificationReport rejects omitted findings, decisions, and reasons", () => {
	const findings = extractReviewFindings(SUMMARY);

	assert.deepEqual(
		parseFindingVerificationReport(
			`## Finding Verification
### F1
- Decision: Agree
- Reason: Confirmed in code.
`,
			findings,
		),
		{ ok: false, error: "Verification report expected '### F2' next" },
	);

	assert.deepEqual(
		parseFindingVerificationReport(
			`## Finding Verification
### F1
- Reason: Confirmed in code.
### F2
- Decision: Disagree
- Reason: Not reproducible.
`,
			findings,
		),
		{ ok: false, error: "Verification report has an invalid decision for F1" },
	);

	assert.deepEqual(
		parseFindingVerificationReport(
			`## Finding Verification
### F1
- Decision: Agree
### F2
- Decision: Disagree
- Reason: Not reproducible.
`,
			findings,
		),
		{ ok: false, error: "Verification report has an invalid reason for F1" },
	);
});

test("parseFindingVerificationReport rejects later headings and commentary", () => {
	const findings = extractReviewFindings(SUMMARY);
	const result = parseFindingVerificationReport(
		`## Finding Verification
### F1
- Decision: Agree
- Reason: Confirmed in code.
### F2
- Decision: Disagree
- Reason: Not reproducible.

## Notes about F3
No additional findings.
`,
		findings,
	);

	assert.deepEqual(result, {
		ok: false,
		error: "Verification report contains unexpected content: ## Notes about F3",
	});
});

test("parseFindingVerificationReport rejects duplicate and invalid decision fields", () => {
	const findings = extractReviewFindings(SUMMARY);

	assert.deepEqual(
		parseFindingVerificationReport(
			`## Finding Verification
### F1
- Decision: Agree
- Decision: Disagree
- Reason: Contradictory.
### F2
- Decision: Disagree
- Reason: Not reproducible.
`,
			findings,
		),
		{ ok: false, error: "Verification report has an invalid reason for F1" },
	);

	assert.deepEqual(
		parseFindingVerificationReport(
			`## Finding Verification
### F1
- Decision: Maybe
- Reason: Unclear.
### F2
- Decision: Disagree
- Reason: Not reproducible.
`,
			findings,
		),
		{ ok: false, error: "Verification report has an invalid decision for F1" },
	);
});

test("parseFindingVerificationReport rejects reversed ids, extra heading text, and unbulleted fields", () => {
	const findings = extractReviewFindings(SUMMARY);

	assert.deepEqual(
		parseFindingVerificationReport(
			`## Finding Verification
### F2
- Decision: Disagree
- Reason: Not reproducible.
### F1
- Decision: Agree
- Reason: Confirmed.
`,
			findings,
		),
		{ ok: false, error: "Verification report expected '### F1' next" },
	);

	assert.deepEqual(
		parseFindingVerificationReport(
			`## Finding Verification
### F1 extra
- Decision: Agree
- Reason: Confirmed.
### F2
- Decision: Disagree
- Reason: Not reproducible.
`,
			findings,
		),
		{ ok: false, error: "Verification report expected '### F1' next" },
	);

	assert.deepEqual(
		parseFindingVerificationReport(
			`## Finding Verification
### F1
Decision: Agree
- Reason: Confirmed.
### F2
- Decision: Disagree
- Reason: Not reproducible.
`,
			findings,
		),
		{ ok: false, error: "Verification report has an invalid decision for F1" },
	);
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
