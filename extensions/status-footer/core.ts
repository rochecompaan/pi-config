export interface WeeklyLimit {
	usedPercent: number;
	resetAt: number;
}

export type VisibleWidth = (text: string) => number;

export type FooterTone =
	| "model"
	| "thinking"
	| "context"
	| "quota"
	| "connected"
	| "branch"
	| "account"
	| "warning"
	| "error"
	| "cost"
	| "dim";

export type StyleFooterText = (tone: FooterTone, text: string) => string;

interface FooterPart {
	text: string;
	tone?: FooterTone;
}

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

function contextTone(percent: number): FooterTone {
	if (percent > 90) return "error";
	if (percent > 70) return "warning";
	return "context";
}

function quotaTone(remainingPercent: number): FooterTone {
	if (remainingPercent < 10) return "error";
	if (remainingPercent < 25) return "warning";
	return "quota";
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

function relayStatus(statuses: ReadonlyMap<string, string>): FooterPart {
	const status = stripAnsi(statuses.get("remote-pi:relay"));
	if (/^🟢\s*relay\b/i.test(status)) return { text: "● relay", tone: "connected" };
	if (status) return { text: "◐ relay", tone: "warning" };
	return { text: "○ relay", tone: "error" };
}

function voiceStatus(statuses: ReadonlyMap<string, string>): FooterPart {
	const status = stripAnsi(statuses.get("voice"));
	if (/^REC\b/i.test(status)) return { text: "● voice", tone: "connected" };
	if (status && !/^MIC\s+(?:LOCAL|STREAM|SETUP)$/i.test(status)) {
		return { text: "◐ voice", tone: "warning" };
	}
	return { text: "○ voice", tone: "error" };
}

function authStatus(input: FooterInput): FooterPart[] {
	const status = stripAnsi(input.extensionStatuses.get("auth-scope"));
	const scope = status.match(/\bauth:\s*(GLOBAL|LOCAL)\b/i)?.[1]?.toUpperCase();
	return [
		{ text: "AUTH", tone: "dim" },
		...(input.accountLabel
			? [{ text: ` ${input.accountLabel}`, tone: "account" as const }]
			: scope ? [
				{ text: " · ", tone: "dim" as const },
				{ text: scope, tone: "account" as const },
			] : []),
	];
}

function bracketed(parts: FooterPart[]): FooterPart[] {
	return [{ text: "[", tone: "dim" }, ...parts, { text: "]", tone: "dim" }];
}

function wrapFooterComponents(
	components: FooterPart[][],
	width: number,
	visibleWidth: VisibleWidth,
): FooterPart[][][] {
	const lines: FooterPart[][][] = [];
	let line: FooterPart[][] = [];
	let lineWidth = 0;
	const separatorWidth = visibleWidth(" ");

	for (const component of components) {
		const componentWidth = component.reduce((total, part) => total + visibleWidth(part.text), 0);
		const nextWidth = lineWidth + (line.length > 0 ? separatorWidth : 0) + componentWidth;
		if (line.length > 0 && nextWidth > width) {
			lines.push(line);
			line = [];
			lineWidth = 0;
		}
		line.push(component);
		lineWidth += (line.length > 1 ? separatorWidth : 0) + componentWidth;
	}
	if (line.length > 0) lines.push(line);
	return lines;
}

function renderFooterLine(components: FooterPart[][], styleText: StyleFooterText): string {
	return components.map((component) => component.map((part) =>
		part.tone ? styleText(part.tone, part.text) : part.text
	).join("")).join(" ");
}

export function buildFooterLines(
	input: FooterInput,
	width: number,
	visibleWidth: VisibleWidth,
	styleText: StyleFooterText = (_tone, text) => text,
): string[] {
	const rawContextPercent = input.contextWindow > 0
		? (finiteNonNegative(input.contextTokens) / input.contextWindow) * 100
		: 0;
	const contextPercent = Math.round(rawContextPercent);
	const components: FooterPart[][] = [
		bracketed([
			{ text: input.modelId || "no-model", tone: "model" },
			...(input.thinkingLevel && input.thinkingLevel !== "off"
				? [{ text: " · ", tone: "dim" as const }, { text: input.thinkingLevel, tone: "thinking" as const }]
				: []),
		]),
		bracketed([
			{ text: `ctx ${contextPercent}%`, tone: contextTone(rawContextPercent) },
			{ text: " · ", tone: "dim" },
			{
				text: `${compactNumber(input.contextTokens)}/${compactNumber(input.contextWindow)}`,
				tone: contextTone(rawContextPercent),
			},
		]),
		bracketed([{ text: `$${finiteNonNegative(input.cost).toFixed(3)}`, tone: "cost" }]),
	];
	if (input.weeklyLimit) {
		const remainingPercent = Math.max(0, 100 - input.weeklyLimit.usedPercent);
		const remaining = trimDecimal(remainingPercent);
		const tone = quotaTone(remainingPercent);
		components.push(bracketed([
			{ text: `Week ${remaining}% rem`, tone },
			{ text: " · ", tone: "dim" },
			{ text: formatResetDistance(input.weeklyLimit.resetAt, input.nowMs), tone },
		]));
	}
	components.push(
		bracketed([
			relayStatus(input.extensionStatuses),
			{ text: " ", tone: "dim" },
			voiceStatus(input.extensionStatuses),
		]),
		bracketed(authStatus(input)),
		bracketed([{ text: ` ${input.gitBranch?.trim() || "—"}`, tone: "branch" }]),
	);
	return wrapFooterComponents(components, width, visibleWidth)
		.map((line) => renderFooterLine(line, styleText));
}
