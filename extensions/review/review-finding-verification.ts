export type ReviewFinding = {
	id: string;
	priority: "P0" | "P1" | "P2" | "P3";
	title: string;
	markdown: string;
};

export type FindingVerification = {
	findingId: string;
	decision: "agree" | "disagree";
	reason: string;
};

export type FindingVerificationParseResult =
	| { ok: true; verifications: FindingVerification[] }
	| { ok: false; error: string };

const FINDING_START_PATTERN = /^- \[(P[0-3])\] (\S.+)$/;
const FINDING_LOCATION_PATTERN = /^  - File location: (\S.+)$/;
const FINDING_WHY_PATTERN = /^  - Why it matters: (\S.+)$/;
const FINDING_CHANGE_PATTERN = /^  - What should change: (\S.+)$/;

function parseHeading(line: string): { level: number; title: string } | null {
	const match = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
	if (!match) return null;
	return { level: match[1].length, title: match[2].replace(/\s+#+\s*$/, "").trim() };
}

const REVIEW_SUMMARY_SECTION_ORDER = [
	"Review Scope",
	"Verdict",
	"Findings",
	"Fix Queue",
	"Constraints & Preferences",
	"Human Reviewer Callouts (Non-Blocking)",
] as const;
const REVIEW_SUMMARY_SENTINEL = "<!-- END REVIEW SUMMARY -->";

function getFindingsSectionLines(summaryText: string): string[] {
	const lines = summaryText.split(/\r?\n/);
	while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
	if (lines.pop() !== REVIEW_SUMMARY_SENTINEL) {
		throw new Error(`Review summary must end with ${REVIEW_SUMMARY_SENTINEL}`);
	}

	const firstContentIndex = lines.findIndex((line) => line.trim());
	if (firstContentIndex < 0 || lines[firstContentIndex] !== "## Review Scope") {
		throw new Error("Review summary must start with the exact '## Review Scope' heading");
	}

	const sections = new Map<string, string[]>();
	let currentSection: string | undefined;
	for (let index = firstContentIndex; index < lines.length; index++) {
		const heading = parseHeading(lines[index]);
		if (heading?.level === 2) {
			if (lines[index] !== `## ${heading.title}`) {
				throw new Error(`Review summary contains malformed section heading: ${lines[index].trim()}`);
			}
			currentSection = heading.title;
			if (!REVIEW_SUMMARY_SECTION_ORDER.includes(currentSection as (typeof REVIEW_SUMMARY_SECTION_ORDER)[number])) {
				throw new Error(`Review summary contains unexpected section: ${currentSection}`);
			}
			if (sections.has(currentSection)) {
				throw new Error(`Review summary contains duplicate section: ${currentSection}`);
			}
			sections.set(currentSection, []);
			continue;
		}
		if (currentSection) sections.get(currentSection)!.push(lines[index]);
	}

	const actualSections = [...sections.keys()];
	if (
		actualSections.length !== REVIEW_SUMMARY_SECTION_ORDER.length ||
		REVIEW_SUMMARY_SECTION_ORDER.some((section, index) => actualSections[index] !== section)
	) {
		throw new Error(`Review summary must contain the exact ordered sections: ${REVIEW_SUMMARY_SECTION_ORDER.join(", ")}`);
	}

	for (const section of REVIEW_SUMMARY_SECTION_ORDER) {
		if (!sections.get(section)!.some((line) => line.trim())) {
			throw new Error(`Review summary section is empty: ${section}`);
		}
	}

	const verdictLines = sections.get("Verdict")!.filter((line) => line.trim());
	if (verdictLines.length !== 1 || !/^(?:- )?(?:correct|needs attention)$/.test(verdictLines[0])) {
		throw new Error("Review summary has a malformed Verdict section");
	}

	return sections.get("Findings")!;
}

export function extractReviewFindings(summaryText: string): ReviewFinding[] {
	const lines = getFindingsSectionLines(summaryText);
	const nonemptyLines = lines.filter((line) => line.trim());
	if (nonemptyLines.length === 1 && nonemptyLines[0] === "- (none)") return [];
	if (lines.length === 0) return [];

	const findings: ReviewFinding[] = [];
	let index = 0;
	while (index < lines.length) {
		if (!lines[index].trim()) {
			index++;
			continue;
		}

		const start = lines[index].match(FINDING_START_PATTERN);
		if (!start) {
			throw new Error(`Malformed finding line: ${lines[index].trim()}`);
		}
		const block = [lines[index]];
		const requiredFields = [
			{ pattern: FINDING_LOCATION_PATTERN, label: "File location" },
			{ pattern: FINDING_WHY_PATTERN, label: "Why it matters" },
			{ pattern: FINDING_CHANGE_PATTERN, label: "What should change" },
		];

		for (const field of requiredFields) {
			index++;
			const fieldLine = lines[index] ?? "";
			if (!field.pattern.test(fieldLine)) {
				throw new Error(`Finding ${findings.length + 1} is missing or has a malformed ${field.label} field`);
			}
			block.push(fieldLine);
		}

		index++;
		if (index < lines.length && lines[index].trim()) {
			if (FINDING_START_PATTERN.test(lines[index])) {
				throw new Error(`Findings must be separated by a blank line before: ${lines[index].trim()}`);
			}
			throw new Error(`Unexpected content after finding ${findings.length + 1}: ${lines[index].trim()}`);
		}

		findings.push({
			id: `F${findings.length + 1}`,
			priority: start[1] as ReviewFinding["priority"],
			title: start[2].trim(),
			markdown: block.join("\n"),
		});
	}

	return findings;
}

function formatFinding(finding: ReviewFinding): string {
	return `### ${finding.id} — [${finding.priority}] ${finding.title}\n${finding.markdown}`;
}

export function buildFindingVerificationPrompt(summaryText: string): {
	prompt: string;
	findings: ReviewFinding[];
} {
	const findings = extractReviewFindings(summaryText);
	if (findings.length === 0) {
		throw new Error("The review summary does not contain any structured findings to verify");
	}

	const findingList = findings.map(formatFinding).join("\n\n");
	return {
		findings,
		prompt: `Verify the review findings below before making any code changes.

This is a verification-only turn. Inspect the current code and available read-only evidence as needed, but do not fix findings yet. Mutation-capable edit, write, and shell tools are disabled for this turn.

For every finding, decide whether you agree or disagree and explain why with specific evidence from the current code. Use exactly one block per finding, in the same order, with this format:

## Finding Verification
### F1
- Decision: Agree
- Reason: <why the finding is valid or invalid, citing concrete evidence>

Decision must be exactly Agree or Disagree. A reason is required for every decision. Do not omit a finding. End after the verification report; fixes will be handled in a separate turn.

## Findings to Verify
${findingList}`,
	};
}

export function parseFindingVerificationReport(
	reportText: string,
	findings: readonly ReviewFinding[],
): FindingVerificationParseResult {
	const lines = reportText.split(/\r?\n/);
	while (lines.length > 0 && !lines[0].trim()) lines.shift();
	while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();

	if (lines.shift() !== "## Finding Verification") {
		return { ok: false, error: "Verification report must start with the exact '## Finding Verification' heading" };
	}

	const verifications: FindingVerification[] = [];
	for (const finding of findings) {
		while (lines.length > 0 && !lines[0].trim()) lines.shift();
		const expectedHeading = `### ${finding.id}`;
		const actualHeading = lines.shift();
		if (actualHeading !== expectedHeading) {
			return { ok: false, error: `Verification report expected '${expectedHeading}' next` };
		}

		const decisionLine = lines.shift() ?? "";
		const decisionMatch = decisionLine.match(/^- Decision: (Agree|Disagree)$/);
		if (!decisionMatch) {
			return { ok: false, error: `Verification report has an invalid decision for ${finding.id}` };
		}

		const reasonLine = lines.shift() ?? "";
		const reasonMatch = reasonLine.match(/^- Reason: (\S.+)$/);
		if (!reasonMatch) {
			return { ok: false, error: `Verification report has an invalid reason for ${finding.id}` };
		}

		verifications.push({
			findingId: finding.id,
			decision: decisionMatch[1].toLowerCase() as FindingVerification["decision"],
			reason: reasonMatch[1].trim(),
		});
	}

	while (lines.length > 0 && !lines[0].trim()) lines.shift();
	if (lines.length > 0) {
		return { ok: false, error: `Verification report contains unexpected content: ${lines[0].trim()}` };
	}

	return { ok: true, verifications };
}

export function buildAgreedFindingsFixPrompt(
	findings: readonly ReviewFinding[],
	verifications: readonly FindingVerification[],
): string | null {
	const verificationById = new Map(verifications.map((verification) => [verification.findingId, verification]));
	const agreed = findings.filter((finding) => verificationById.get(finding.id)?.decision === "agree");
	if (agreed.length === 0) return null;

	const agreedFindings = agreed
		.map((finding) => {
			const verification = verificationById.get(finding.id)!;
			return `${formatFinding(finding)}\n\nVerification reason: ${verification.reason}`;
		})
		.join("\n\n");

	return `Implement only the review findings that were verified as Agree below.

The verification turn is complete. Do not implement findings marked Disagree, and do not broaden the work beyond these agreed findings.

## Agreed Findings
${agreedFindings}

Instructions:
1. Treat the agreed findings as a checklist.
2. Fix in priority order: P0, P1, then P2 (include P3 if quick and safe).
3. If an agreed finding became already fixed or cannot be completed now, briefly explain why and continue.
4. Treat human reviewer callouts as informational only unless an agreed finding explicitly requires a change.
5. Follow fail-fast error handling: do not add local catch/fallback recovery unless this scope is an explicit boundary that can safely translate the failure.
6. If you add or keep a try/catch, explain the expected failure mode and either rethrow with context or return a boundary-safe error response.
7. JSON parsing/decoding should fail loudly by default; avoid silent fallback parsing.
8. Run relevant tests/checks for touched code where practical.
9. End with: fixed items, deferred/skipped agreed items (with reasons), and verification results.`;
}
