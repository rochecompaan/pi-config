// Adapted from @signalridge/pi-code-actions. See NOTICE.
import type { ExtractedCopyItem } from "./copy-items.ts";

type SourceRange = { start: number; end: number };

function isInsideRanges(position: number, ranges: readonly SourceRange[]): boolean {
	return ranges.some((range) => position >= range.start && position < range.end);
}

export function extractCopyItems(text: string): ExtractedCopyItem[] {
	const items: ExtractedCopyItem[] = [];
	const fencedRanges: SourceRange[] = [];
	const fencedPattern = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;

	while ((match = fencedPattern.exec(text)) !== null) {
		const language = match[1]?.trim() || undefined;
		const content = (match[2] ?? "").replace(/\r?\n$/, "");
		fencedRanges.push({ start: match.index, end: match.index + match[0].length });
		if (content.length > 0) {
			items.push({
				kind: "code",
				content,
				sourcePosition: match.index,
				...(language ? { language } : {}),
			});
		}
	}

	const inlinePattern = /(?<!`)`([^`\r\n]+)`(?!`)/g;
	while ((match = inlinePattern.exec(text)) !== null) {
		if (!isInsideRanges(match.index, fencedRanges)) {
			items.push({
				kind: "inline",
				content: match[1] ?? "",
				sourcePosition: match.index,
			});
		}
	}

	let pipeStart = -1;
	let pipeParts: string[] = [];
	const flushPipeBlock = (): void => {
		if (pipeStart >= 0) {
			const content = pipeParts.join("");
			if (content.length > 0) {
				items.push({ kind: "pipe-message", content, sourcePosition: pipeStart });
			}
		}
		pipeStart = -1;
		pipeParts = [];
	};

	const linePattern = /([^\r\n]*)(\r?\n|$)/g;
	while ((match = linePattern.exec(text)) !== null) {
		if (match[0].length === 0) break;
		const line = match[1] ?? "";
		if (!isInsideRanges(match.index, fencedRanges) && line.startsWith("| ")) {
			if (pipeStart < 0) pipeStart = match.index;
			pipeParts.push(line.slice(2));
		} else {
			flushPipeBlock();
		}
	}
	flushPipeBlock();

	return items.sort((left, right) => left.sourcePosition - right.sourcePosition);
}
