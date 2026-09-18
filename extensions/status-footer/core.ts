export interface WeeklyLimit {
	usedPercent: number;
	resetAt: number;
}

export type TruncateToWidth = (text: string, width: number) => string;

export interface FooterInput {
	modelId: string;
	thinkingLevel: string;
	contextTokens: number;
	contextWindow: number;
	cost: number;
	weeklyLimit: WeeklyLimit | null;
	gitBranch: string | null;
	extensionStatuses: ReadonlyMap<string, string>;
	accountLabel: string | null;
	nowMs: number;
}

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const SAFE_EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const WEEK_MINUTES = 7 * 24 * 60;

function finiteNonNegative(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

function trimDecimal(value: number, digits = 1): string {
	return value.toFixed(digits).replace(/\.0+$/, "");
}

function compactNumber(value: number): string {
	const safe = finiteNonNegative(value);
	if (safe >= 1_000_000) return `${trimDecimal(safe / 1_000_000)}M`;
	if (safe >= 1_000) return `${trimDecimal(safe / 1_000)}k`;
	return String(Math.round(safe));
}

function decodeJwtPayload(accessToken: string): Record<string, unknown> | null {
	const parts = accessToken.split(".");
	if (parts.length !== 3 || !parts[1]) return null;
	try {
		const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: null;
	} catch {
		return null;
	}
}

export function extractSafeAccountLabel(accessToken: string | undefined): string | null {
	if (!accessToken) return null;
	const claims = decodeJwtPayload(accessToken);
	if (!claims) return null;
	const profile = claims["https://api.openai.com/profile"];
	const nestedEmail = profile && typeof profile === "object" && !Array.isArray(profile)
		? (profile as Record<string, unknown>).email
		: undefined;
	const email = typeof claims.email === "string"
		? claims.email
		: typeof nestedEmail === "string" ? nestedEmail : null;
	if (!email || email.length > 254 || !SAFE_EMAIL.test(email)) return null;
	return email;
}

function headerNumber(headers: Readonly<Record<string, string>>, name: string): number | null {
	const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
	if (value === undefined || value.trim() === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function parseWeeklyLimit(headers: Readonly<Record<string, string>>): WeeklyLimit | null {
	for (const windowName of ["secondary", "primary"]) {
		const prefix = `x-codex-${windowName}`;
		const windowMinutes = headerNumber(headers, `${prefix}-window-minutes`);
		if (windowMinutes === null || Math.abs(windowMinutes - WEEK_MINUTES) > 60) continue;
		const usedPercent = headerNumber(headers, `${prefix}-used-percent`);
		const resetAt = headerNumber(headers, `${prefix}-reset-at`);
		if (usedPercent === null || usedPercent < 0 || usedPercent > 100) return null;
		if (resetAt === null || resetAt <= 0) return null;
		return { usedPercent, resetAt: Math.round(resetAt) };
	}
	return null;
}

function formatResetDistance(resetAt: number, nowMs: number): string {
	const totalHours = Math.max(0, Math.ceil((resetAt * 1000 - nowMs) / 3_600_000));
	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	if (days > 0) return `${days}d${hours}h`;
	return `${hours}h`;
}

function stripAnsi(value: string | undefined): string {
	return value?.replace(ANSI_ESCAPE, "").trim() ?? "";
}

function relayStatus(statuses: ReadonlyMap<string, string>): string {
	const status = stripAnsi(statuses.get("remote-pi:relay"));
	if (/^🟢\s*relay\b/i.test(status)) return "● relay";
	if (status) return "◐ relay";
	return "○ relay";
}

function voiceStatus(statuses: ReadonlyMap<string, string>): string {
	const status = stripAnsi(statuses.get("voice"));
	if (/^REC\b/i.test(status)) return "● voice";
	if (status && !/^MIC\s+(?:LOCAL|STREAM|SETUP)$/i.test(status)) return "◐ voice";
	return "○ voice";
}

function authStatus(input: FooterInput): string {
	const status = stripAnsi(input.extensionStatuses.get("auth-scope"));
	const scope = status.match(/\bauth:\s*(GLOBAL|LOCAL)\b/i)?.[1]?.toUpperCase();
	const account = input.accountLabel ? ` ${input.accountLabel}` : "";
	return `AUTH${account}${scope ? ` · ${scope}` : ""}`;
}

export function buildFooterLines(
	input: FooterInput,
	width: number,
	truncateToWidth: TruncateToWidth,
): string[] {
	const contextPercent = input.contextWindow > 0
		? Math.round((finiteNonNegative(input.contextTokens) / input.contextWindow) * 100)
		: 0;
	const firstParts = [
		`${input.modelId || "no-model"}${input.thinkingLevel && input.thinkingLevel !== "off" ? ` ${input.thinkingLevel}` : ""}`,
		`ctx ${contextPercent}% ${compactNumber(input.contextTokens)}/${compactNumber(input.contextWindow)}`,
		`$${finiteNonNegative(input.cost).toFixed(3)}`,
	];
	if (input.weeklyLimit) {
		const remaining = trimDecimal(Math.max(0, 100 - input.weeklyLimit.usedPercent));
		firstParts.push(`Week ${remaining}% rem · ${formatResetDistance(input.weeklyLimit.resetAt, input.nowMs)}`);
	}
	const secondParts = [
		` ${input.gitBranch?.trim() || "—"}`,
		`${relayStatus(input.extensionStatuses)} ${voiceStatus(input.extensionStatuses)}`,
		authStatus(input),
	];
	return [
		truncateToWidth(firstParts.join(" │ "), width),
		truncateToWidth(secondParts.join(" │ "), width),
	];
}
