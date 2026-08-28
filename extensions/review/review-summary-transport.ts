export type ReviewSummaryFileDetails = {
	readFiles: readonly string[];
	modifiedFiles: readonly string[];
};

const REVIEW_SUMMARY_START = "## Review Scope";
const REVIEW_SUMMARY_SENTINEL = "<!-- END REVIEW SUMMARY -->";
const PI_BRANCH_SUMMARY_PREAMBLE_LINES = [
	"The user explored a different conversation branch before returning here.",
	"Summary of that exploration:",
] as const;
const PI_BRANCH_METADATA_START_PATTERN = /^<(read-files|modified-files)>$/;

function getTrustedFileDetails(details: unknown): ReviewSummaryFileDetails | null {
	if (!details || typeof details !== "object") return null;
	const candidate = details as { readFiles?: unknown; modifiedFiles?: unknown };
	if (!Array.isArray(candidate.readFiles) || !candidate.readFiles.every((path) => typeof path === "string")) {
		return null;
	}
	if (
		!Array.isArray(candidate.modifiedFiles) ||
		!candidate.modifiedFiles.every((path) => typeof path === "string")
	) {
		return null;
	}
	return {
		readFiles: candidate.readFiles,
		modifiedFiles: candidate.modifiedFiles,
	};
}

function parsePiBranchMetadataSuffix(lines: readonly string[]): ReviewSummaryFileDetails | null {
	const parsed = { readFiles: [] as string[], modifiedFiles: [] as string[] };
	let index = 0;
	let blockCount = 0;
	let previousBlockOrder = -1;

	while (index < lines.length) {
		while (index < lines.length && !lines[index].trim()) index++;
		if (index >= lines.length) break;

		const start = lines[index].match(PI_BRANCH_METADATA_START_PATTERN);
		if (!start) return null;
		const blockOrder = start[1] === "read-files" ? 0 : 1;
		if (blockOrder <= previousBlockOrder) return null;
		previousBlockOrder = blockOrder;

		const key = start[1] === "read-files" ? "readFiles" : "modifiedFiles";
		const endTag = `</${start[1]}>`;
		index++;
		while (index < lines.length && lines[index] !== endTag) {
			if (!lines[index].trim()) return null;
			parsed[key].push(lines[index]);
			index++;
		}
		if (parsed[key].length === 0 || index >= lines.length) return null;
		index++;
		blockCount++;
	}

	return blockCount > 0 ? parsed : null;
}

function hasSamePaths(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((path, index) => path === expected[index]);
}

function hasMatchingFileDetails(actual: ReviewSummaryFileDetails, expected: ReviewSummaryFileDetails): boolean {
	return (
		hasSamePaths(actual.readFiles, expected.readFiles) &&
		hasSamePaths(actual.modifiedFiles, expected.modifiedFiles)
	);
}

export function unwrapPiBranchReviewSummary(summaryText: string, details?: unknown): string {
	const lines = summaryText.split(/\r?\n/);
	const firstContentIndex = lines.findIndex((line) => line.trim());
	if (firstContentIndex < 0 || lines[firstContentIndex] === REVIEW_SUMMARY_START) return summaryText;

	const separatorStart = firstContentIndex + PI_BRANCH_SUMMARY_PREAMBLE_LINES.length;
	if (
		lines[firstContentIndex] !== PI_BRANCH_SUMMARY_PREAMBLE_LINES[0] ||
		lines[firstContentIndex + 1] !== PI_BRANCH_SUMMARY_PREAMBLE_LINES[1] ||
		lines[separatorStart]?.trim()
	) {
		return summaryText;
	}

	let summaryStart = separatorStart;
	while (summaryStart < lines.length && !lines[summaryStart].trim()) summaryStart++;
	if (summaryStart === separatorStart || lines[summaryStart] !== REVIEW_SUMMARY_START) return summaryText;

	const sentinelIndex = lines.indexOf(REVIEW_SUMMARY_SENTINEL, summaryStart);
	if (sentinelIndex < 0) return summaryText;

	const suffixLines = lines.slice(sentinelIndex + 1);
	const hasMetadata = suffixLines.some((line) => line.trim());
	const trustedDetails = getTrustedFileDetails(details);
	if (!hasMetadata) {
		if (trustedDetails && (trustedDetails.readFiles.length > 0 || trustedDetails.modifiedFiles.length > 0)) {
			return summaryText;
		}
	} else {
		const parsedDetails = parsePiBranchMetadataSuffix(suffixLines);
		if (!trustedDetails || !parsedDetails || !hasMatchingFileDetails(parsedDetails, trustedDetails)) {
			return summaryText;
		}
	}

	return lines.slice(summaryStart, sentinelIndex + 1).join("\n");
}
