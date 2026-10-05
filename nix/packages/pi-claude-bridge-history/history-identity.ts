import { createHash } from "node:crypto";

export type HistoryIdentityMessage = {
	role?: string;
	timestamp?: unknown;
	toolCallId?: unknown;
	toolName?: unknown;
	isError?: unknown;
	content?: unknown;
};

function historyKey(message: HistoryIdentityMessage): string {
	return createHash("sha256").update(JSON.stringify([
		message.role,
		message.timestamp ?? null,
		message.toolCallId ?? null,
		message.toolName ?? null,
		message.isError ?? null,
		message.content ?? null,
	])).digest("hex");
}

/** Identifies the pi history a Claude Code session holds once a turn starts: the
 *  messages before the turn and the turn's first user message. */
export function sessionHistoryKeys(history: readonly HistoryIdentityMessage[], turnStart: number): string[] {
	return history.slice(0, turnStart + 1).map(historyKey);
}

/** Reports whether pi's history still begins with the messages a session holds.
 *  Context transforms such as paging drop messages from the front, so a matching
 *  message count alone does not prove the history continues the session. */
export function historyStartsWith(history: readonly HistoryIdentityMessage[], keys: readonly string[]): boolean {
	return keys.length <= history.length && keys.every((key, index) => historyKey(history[index]!) === key);
}
