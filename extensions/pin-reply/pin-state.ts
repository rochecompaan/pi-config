/**
 * Pure helpers for the pin-reply extension. No Pi imports, so they can be
 * unit-tested with `node --test`.
 */

export const PIN_ENTRY_TYPE = "pin-reply";

export type PinData = { text: string; pinnedAt: number };
export type PinEntryData = PinData | { cleared: true };

/** The parts of a session branch entry these helpers read. */
type BranchEntry = { type: string; message?: unknown; customType?: string; data?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function assistantText(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const parts = message.content
		.filter((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text);
	const text = parts.join("\n").trim();
	return text || undefined;
}

/** Text of the most recent assistant message that has any text. */
export function lastReplyText(branch: readonly BranchEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const text = assistantText(entry.message);
		if (text) return text;
	}
	return undefined;
}

function isPinData(data: unknown): data is PinData {
	return isRecord(data) && typeof data.text === "string" && typeof data.pinnedAt === "number";
}

function isCleared(data: unknown): boolean {
	return isRecord(data) && data.cleared === true;
}

/** The pin as of the end of the branch: the latest valid pin-reply entry decides. */
export function currentPin(branch: readonly BranchEntry[]): PinData | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== PIN_ENTRY_TYPE) continue;
		if (isCleared(entry.data)) return undefined;
		if (isPinData(entry.data)) return { text: entry.data.text, pinnedAt: entry.data.pinnedAt };
	}
	return undefined;
}

/** Keep a scroll offset between the top and the last full page. */
export function clampScroll(offset: number, totalLines: number, viewHeight: number): number {
	const max = Math.max(0, totalLines - viewHeight);
	return Math.min(Math.max(0, offset), max);
}
