import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SavingsSummary = {
	savedBytes: number;
	usedBytes: number;
	withoutBytes: number;
	savedTokens: number;
	usedTokens: number;
	withoutTokens: number;
	reductionPercent: number;
};

export type RenderedScope = {
	label: string;
	summary: SavingsSummary;
	projectedCost: number | null;
	inferred: boolean;
};

export type RenderSavingsInput = {
	session: RenderedScope | null;
	worktree: RenderedScope | null;
	skippedDbs: number;
};

function finiteNonNegative(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

function trimOneDecimal(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}

export function bytesToTokens(bytes: number): number {
	return Math.round(finiteNonNegative(bytes) / 4);
}

export function formatShortNumber(value: number): string {
	const rounded = Math.round(finiteNonNegative(value));
	if (rounded >= 1_000_000) return `${trimOneDecimal(rounded / 1_000_000)}M`;
	if (rounded >= 1_000) return `${trimOneDecimal(rounded / 1_000)}k`;
	return rounded.toLocaleString("en-US");
}

export function formatUsd(cost: number | null | undefined): string | null {
	if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) return null;
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost >= 0.1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(4)}`;
}

export function summarizeBytes(savedBytes: number, usedBytes: number): SavingsSummary {
	const saved = finiteNonNegative(savedBytes);
	const used = finiteNonNegative(usedBytes);
	const without = saved + used;
	return {
		savedBytes: saved,
		usedBytes: used,
		withoutBytes: without,
		savedTokens: bytesToTokens(saved),
		usedTokens: bytesToTokens(used),
		withoutTokens: bytesToTokens(without),
		reductionPercent: without > 0 ? Math.round((saved / without) * 100) : 0,
	};
}

export function projectCostSavings(savedTokens: number, actualCost: number, actualTokens: number): number | null {
	if (!Number.isFinite(savedTokens) || savedTokens <= 0) return null;
	if (!Number.isFinite(actualCost) || actualCost <= 0) return null;
	if (!Number.isFinite(actualTokens) || actualTokens <= 0) return null;
	return Math.round(savedTokens * (actualCost / actualTokens) * 1_000_000_000_000) / 1_000_000_000_000;
}

function costSuffix(cost: number | null): string {
	const formatted = formatUsd(cost);
	return formatted ? ` (~${formatted})` : "";
}

function firstLine(scope: RenderedScope): string {
	const saved = `~${formatShortNumber(scope.summary.savedTokens)}`;
	const inferred = scope.inferred ? " inferred" : "";
	if (scope.label === "this session") {
		return `ctx saved ${saved} tokens${costSuffix(scope.projectedCost)} ${scope.label}${inferred}`;
	}
	return `${scope.label}: ${saved} saved${costSuffix(scope.projectedCost)}${inferred}`;
}

function comparisonLine(scope: RenderedScope): string {
	return `${formatShortNumber(scope.summary.usedTokens)} used / ${formatShortNumber(scope.summary.withoutTokens)} without · ${scope.summary.reductionPercent}% reduction`;
}

export function renderSavingsReport(input: RenderSavingsInput): string {
	const sections: string[] = [];
	if (input.session) sections.push(`${firstLine(input.session)}\n${comparisonLine(input.session)}`);
	if (input.worktree) sections.push(`${firstLine(input.worktree)}\n${comparisonLine(input.worktree)}`);
	if (sections.length === 0) return "No context-mode savings data found for this worktree yet.";
	if (input.skippedDbs > 0) sections.push(`Skipped ${input.skippedDbs} unreadable context-mode DB${input.skippedDbs === 1 ? "" : "s"}.`);
	return sections.join("\n\n");
}

export function renderSavingsStatus(scope: RenderedScope): string {
	return `ctx: ${formatShortNumber(scope.summary.usedTokens)} / ${formatShortNumber(scope.summary.withoutTokens)} · saved ${formatShortNumber(scope.summary.savedTokens)}${costSuffix(scope.projectedCost)} · ${scope.summary.reductionPercent}%`;
}

export type RawSavings = {
	savedBytes: number;
	usedBytes: number;
};

export type SessionSavingsRow = {
	sessionId: string;
	projectDir: string;
	lastEventAt: string | null;
	savedBytes: number;
	usedBytes: number;
};

export type ContextModeSavings = {
	sessionRaw: RawSavings | null;
	worktreeRaw: RawSavings | null;
	inferredSession: boolean;
	skippedDbs: number;
	matchedSessions: number;
};

export type CollectContextModeSavingsOptions = {
	cwd: string;
	sessionId: string | null;
	homeDir?: string;
	databaseScope?: "all" | "project";
};

export function normalizeProjectPath(projectPath: string): string {
	const normalized = String(projectPath || "").replace(/\\/g, "/").replace(/\/+$/g, "");
	return normalized || "/";
}

export function deriveContextModeSessionId(ctx: unknown): string | null {
	try {
		const sessionFile = (ctx as any)?.sessionManager?.getSessionFile?.();
		if (typeof sessionFile !== "string" || !sessionFile) return null;
		return createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);
	} catch {
		return null;
	}
}

function addRaw(a: RawSavings | null, b: RawSavings): RawSavings {
	return {
		savedBytes: (a?.savedBytes ?? 0) + finiteNonNegative(b.savedBytes),
		usedBytes: (a?.usedBytes ?? 0) + finiteNonNegative(b.usedBytes),
	};
}

export function aggregateSessionRows(rows: SessionSavingsRow[], cwd: string, sessionId: string | null): ContextModeSavings {
	const target = normalizeProjectPath(cwd);
	const matches = rows.filter((row) => normalizeProjectPath(row.projectDir) === target);
	let worktreeRaw: RawSavings | null = null;
	for (const row of matches) {
		worktreeRaw = addRaw(worktreeRaw, row);
	}

	let inferredSession = false;
	let selected = sessionId ? matches.find((row) => row.sessionId === sessionId) ?? null : null;
	if (!selected && matches.length > 0) {
		selected = [...matches].sort((a, b) => String(b.lastEventAt ?? "").localeCompare(String(a.lastEventAt ?? "")))[0] ?? null;
		inferredSession = true;
	}

	return {
		sessionRaw: selected ? { savedBytes: finiteNonNegative(selected.savedBytes), usedBytes: finiteNonNegative(selected.usedBytes) } : null,
		worktreeRaw,
		inferredSession,
		skippedDbs: 0,
		matchedSessions: matches.length,
	};
}

export type UsageTotals = {
	totalTokens: number;
	totalCost: number;
};

function readNum(value: unknown): number {
	if (typeof value === "number") return Number.isFinite(value) ? value : 0;
	if (typeof value === "string") {
		const n = Number(value);
		return Number.isFinite(n) ? n : 0;
	}
	return 0;
}

export function extractCostTotal(usage: unknown): number {
	const u = usage as any;
	if (!u) return 0;
	const direct = readNum(u.cost);
	if (direct > 0) return direct;
	return readNum(u.cost?.total);
}

export function extractTokensTotal(usage: unknown): number {
	const u = usage as any;
	if (!u) return 0;
	const direct = readNum(u.totalTokens) || readNum(u.total_tokens) || readNum(u.tokenCount) || readNum(u.token_count);
	if (direct > 0) return direct;
	const nested = readNum(u.tokens?.total) || readNum(u.tokens?.totalTokens) || readNum(u.tokens?.total_tokens);
	if (nested > 0) return nested;
	const promptCompletion = readNum(u.promptTokens) + readNum(u.completionTokens) + readNum(u.prompt_tokens) + readNum(u.completion_tokens);
	if (promptCompletion > 0) return promptCompletion;
	return readNum(u.inputTokens) + readNum(u.outputTokens) + readNum(u.input_tokens) + readNum(u.output_tokens) + readNum(u.cacheRead) + readNum(u.cacheWrite);
}

export function collectCurrentSessionUsage(ctx: unknown): UsageTotals {
	let totalTokens = 0;
	let totalCost = 0;
	const entries = (ctx as any)?.sessionManager?.getEntries?.() ?? [];
	for (const entry of entries) {
		if ((entry as any)?.type !== "message") continue;
		const message = (entry as any)?.message;
		if (message?.role !== "assistant") continue;
		const usage = message.usage;
		totalTokens += extractTokensTotal(usage);
		totalCost += extractCostTotal(usage);
	}
	return { totalTokens, totalCost };
}

export function projectedCostForSummary(summary: SavingsSummary, usage: UsageTotals): number | null {
	return projectCostSavings(summary.savedTokens, usage.totalCost, usage.totalTokens);
}

async function walkJsonlFiles(dir: string): Promise<string[]> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await walkJsonlFiles(fullPath)));
		if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
	}
	return files;
}

async function readSessionJsonlUsage(filePath: string, targetCwd?: string): Promise<{ cwd: string | null; usage: UsageTotals } | null> {
	const stream = fs.createReadStream(filePath, { encoding: "utf8" });
	const readline = await import("node:readline");
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
	let cwd: string | null = null;
	let totalTokens = 0;
	let totalCost = 0;

	try {
		let lineNumber = 0;
		for await (const line of rl) {
			lineNumber += 1;
			if (!line.trim()) continue;
			let obj: any;
			try {
				obj = JSON.parse(line);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Failed to parse Pi session JSONL ${filePath}:${lineNumber}: ${message}`);
			}

			if ((obj?.type === "session" || obj?.type === "session_start") && typeof obj.cwd === "string") {
				cwd = obj.cwd;
				if (targetCwd && normalizeProjectPath(cwd) !== targetCwd) return null;
				continue;
			}

			if (obj?.type !== "message") continue;
			const message = obj.message;
			const usage = obj.usage ?? message?.usage;
			const role = message?.role ?? obj.role;
			if (role && role !== "assistant") continue;
			totalTokens += extractTokensTotal(usage);
			totalCost += extractCostTotal(usage);
		}
	} finally {
		rl.close();
		stream.destroy();
	}

	return cwd ? { cwd, usage: { totalTokens, totalCost } } : null;
}

export async function collectWorktreeUsageFromJsonl(cwd: string, homeDir = os.homedir()): Promise<UsageTotals> {
	const target = normalizeProjectPath(cwd);
	const root = path.join(homeDir, ".pi", "agent", "sessions");
	let totalTokens = 0;
	let totalCost = 0;
	for (const filePath of await walkJsonlFiles(root)) {
		const session = await readSessionJsonlUsage(filePath, target);
		if (!session) continue;
		if (normalizeProjectPath(session.cwd) !== target) continue;
		totalTokens += session.usage.totalTokens;
		totalCost += session.usage.totalCost;
	}
	return { totalTokens, totalCost };
}

export type BuildRenderedSavingsInput = {
	contextMode: ContextModeSavings;
	currentUsage: UsageTotals;
	worktreeUsage: UsageTotals;
};

export function buildRenderedSavings(input: BuildRenderedSavingsInput): { text: string; status: string | null } {
	const sessionSummary = input.contextMode.sessionRaw
		? summarizeBytes(input.contextMode.sessionRaw.savedBytes, input.contextMode.sessionRaw.usedBytes)
		: null;
	const worktreeSummary = input.contextMode.worktreeRaw
		? summarizeBytes(input.contextMode.worktreeRaw.savedBytes, input.contextMode.worktreeRaw.usedBytes)
		: null;

	const session: RenderedScope | null = sessionSummary
		? {
				label: "this session",
				summary: sessionSummary,
				projectedCost: projectedCostForSummary(sessionSummary, input.currentUsage),
				inferred: input.contextMode.inferredSession,
			}
		: null;
	const worktree: RenderedScope | null = worktreeSummary
		? {
				label: "this worktree",
				summary: worktreeSummary,
				projectedCost: projectedCostForSummary(worktreeSummary, input.worktreeUsage),
				inferred: false,
			}
		: null;

	return {
		text: renderSavingsReport({ session, worktree, skippedDbs: input.contextMode.skippedDbs }),
		status: session ? renderSavingsStatus(session) : null,
	};
}
