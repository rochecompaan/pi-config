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
	| { ok: true; verifications: FindingVerification[]; undecided: string[] }
	| { ok: false; error: string };

const HEADING_PATTERN = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM_PATTERN = /^ {0,3}(?:[-*+]|\d+[.)])\s+(.*)$/;
const PRIORITY_TAG_PATTERN = /\[\s*(P[0-3])\s*\]|^[*_`]*(P[0-3])\b[*_`]*/i;
const SUMMARY_END_MARKER = "<!-- END REVIEW SUMMARY -->";

function stripEmphasis(text: string): string {
	return text.replace(/[*_`]/g, "").trim();
}

function getFindingsSectionLines(summaryText: string): string[] {
	const lines = summaryText.split(/\r?\n/);
	const start = lines.findIndex((line) => {
		const heading = line.match(HEADING_PATTERN);
		return heading ? /^findings\b/i.test(stripEmphasis(heading[2])) : false;
	});
	if (start < 0) {
		throw new Error("The review summary does not contain a Findings section");
	}

	const level = lines[start].match(HEADING_PATTERN)![1].length;
	const section: string[] = [];
	for (const line of lines.slice(start + 1)) {
		const heading = line.match(HEADING_PATTERN);
		if (heading && heading[1].length <= level) break;
		// Pi appends file metadata after the end marker; never read it as findings.
		if (line.includes(SUMMARY_END_MARKER)) break;
		section.push(line);
	}
	return section;
}

function parseFindingStart(line: string): { priority: ReviewFinding["priority"]; title: string } | null {
	const item = line.match(LIST_ITEM_PATTERN);
	if (!item) return null;
	const tag = item[1].match(PRIORITY_TAG_PATTERN);
	if (!tag) return null;

	const priority = (tag[1] ?? tag[2]).toUpperCase() as ReviewFinding["priority"];
	const title = stripEmphasis(item[1].replace(tag[0], "")).replace(/^[\s:—–-]+/, "").trim();
	return { priority, title: title || "(untitled finding)" };
}

/**
 * Reads findings from a review summary. Any list item tagged [P0]..[P3] under the
 * Findings heading starts a finding; every following line belongs to it until the
 * next tagged item. Formatting details are intentionally not validated.
 */
export function extractReviewFindings(summaryText: string): ReviewFinding[] {
	const findings: ReviewFinding[] = [];
	let current: { priority: ReviewFinding["priority"]; title: string; lines: string[] } | null = null;

	const flush = () => {
		if (!current) return;
		while (current.lines.length > 1 && !current.lines[current.lines.length - 1].trim()) current.lines.pop();
		findings.push({
			id: `F${findings.length + 1}`,
			priority: current.priority,
			title: current.title,
			markdown: current.lines.join("\n"),
		});
	};

	for (const line of getFindingsSectionLines(summaryText)) {
		const start = parseFindingStart(line);
		if (start) {
			flush();
			current = { ...start, lines: [line] };
		} else if (current) {
			current.lines.push(line);
		}
	}
	flush();

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
		throw new Error("The review summary does not contain any [P0]-[P3] findings to verify");
	}

	const findingList = findings.map(formatFinding).join("\n\n");
	return {
		findings,
		prompt: `Verify the review findings below before making any code changes.

This is a verification-only turn. Inspect the current code and available read-only evidence as needed, but do not fix findings yet. Mutation-capable edit, write, and shell tools are disabled for this turn.

For every finding, decide whether you agree or disagree and explain why with specific evidence from the current code. Use one block per finding, labelled with its id:

## Finding Verification
### F1
- Decision: Agree
- Reason: <why the finding is valid or invalid, citing concrete evidence>

### F2
- Decision: Disagree
- Reason: <why the finding is valid or invalid, citing concrete evidence>

Decision must be Agree or Disagree. Findings without a clear decision will not be fixed. End after the verification report; fixes will be handled in a separate turn.

## Findings to Verify
${findingList}`,
	};
}

const FINDING_ID_LINE_PATTERN = /^\s*(?:#{1,6}\s*|(?:[-*+]|\d+[.)])\s+)?[*_`]*F(\d+)\b/i;
const DECISION_PATTERN = /\bdecision\b[^A-Za-z]*(disagree|agree)/i;
const HEADING_DECISION_PATTERN = /\b(disagree|agree)/i;
const REASON_PATTERN = /^[\s>*_`-]*reason\b[*_`]*\s*[:—–-]?[*_`]*\s*(.*)$/i;

function readDecision(block: string[]): FindingVerification["decision"] | null {
	const decisions = new Set<string>();
	for (const line of block) {
		const match = line.match(DECISION_PATTERN);
		if (match) decisions.add(match[1].toLowerCase());
	}
	// Fall back to a decision written on the id line, such as "### F1 — Agree".
	if (decisions.size === 0) {
		const match = block[0].match(HEADING_DECISION_PATTERN);
		if (match) decisions.add(match[1].toLowerCase());
	}
	// Contradictory decisions are treated as undecided so the finding is not fixed.
	return decisions.size === 1 ? ([...decisions][0] as FindingVerification["decision"]) : null;
}

function readReason(block: string[]): string {
	const reasonIndex = block.findIndex((line) => REASON_PATTERN.test(line));
	const reasonLines =
		reasonIndex >= 0
			? [block[reasonIndex].match(REASON_PATTERN)![1], ...block.slice(reasonIndex + 1)]
			: block.slice(1).filter((line) => !DECISION_PATTERN.test(line));
	return reasonLines.join("\n").trim() || "(no reason given)";
}

/**
 * Reads Agree/Disagree decisions from a verification report. Blocks are found by
 * finding id in any order; findings without a single clear decision are returned
 * as undecided so they are never fixed by accident.
 */
export function parseFindingVerificationReport(
	reportText: string,
	findings: readonly ReviewFinding[],
): FindingVerificationParseResult {
	const knownIds = new Set(findings.map((finding) => finding.id));
	const blocks = new Map<string, string[][]>();
	let current: string[] | null = null;

	for (const line of reportText.split(/\r?\n/)) {
		const idMatch = line.match(FINDING_ID_LINE_PATTERN);
		const id = idMatch ? `F${Number(idMatch[1])}` : null;
		if (id && knownIds.has(id)) {
			current = [line];
			blocks.set(id, [...(blocks.get(id) ?? []), current]);
			continue;
		}
		// Other headings end the current block so trailing notes are not read as reasons.
		if (HEADING_PATTERN.test(line)) {
			current = null;
			continue;
		}
		current?.push(line);
	}

	const verifications: FindingVerification[] = [];
	const undecided: string[] = [];
	for (const finding of findings) {
		const candidates = blocks.get(finding.id) ?? [];
		const block = candidates.find((candidate) => readDecision(candidate) !== null);
		if (!block) {
			undecided.push(finding.id);
			continue;
		}
		verifications.push({ findingId: finding.id, decision: readDecision(block)!, reason: readReason(block) });
	}

	if (verifications.length === 0) {
		return { ok: false, error: "Could not read an Agree or Disagree decision for any finding" };
	}
	return { ok: true, verifications, undecided };
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

${buildFixInstructions("agreed findings")}`;
}

function buildFixInstructions(findingsLabel: string): string {
	return `Instructions:
1. Treat the ${findingsLabel} as a checklist.
2. Fix in priority order: P0, P1, then P2 (include P3 if quick and safe).
3. If one of the ${findingsLabel} is already fixed or cannot be completed now, briefly explain why and continue.
4. Treat human reviewer callouts as informational only unless one of the ${findingsLabel} explicitly requires a change.
5. Follow fail-fast error handling: do not add local catch/fallback recovery unless this scope is an explicit boundary that can safely translate the failure.
6. If you add or keep a try/catch, explain the expected failure mode and either rethrow with context or return a boundary-safe error response.
7. JSON parsing/decoding should fail loudly by default; avoid silent fallback parsing.
8. Run relevant tests/checks for touched code where practical.
9. End with: fixed items, deferred/skipped items (with reasons), and verification results.`;
}

/**
 * Builds a fix prompt from the raw review summary without parsing or verifying it,
 * so any summary format can be handed straight to the agent.
 */
export function buildDirectFixPrompt(summaryText: string): string {
	return `Fix the review findings below. They have not been verified, so check each one against the current code first and skip any that are wrong, saying why.

## Review Summary
${summaryText.trim()}

${buildFixInstructions("review findings")}`;
}
