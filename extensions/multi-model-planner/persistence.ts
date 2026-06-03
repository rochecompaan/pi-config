import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommEntry, CommSummary, PersistedTeamRun, RunArtifactManifest } from "./types.ts";

const SPECS_DIR = path.join(".pi", "specs");
const RUN_ID_PATTERN = /^(.*)-(\d{3})$/;

export interface GenerateNextRunIdOptions {
	cwd: string;
	teamName: string;
}

export interface WriteRunArtifactsOptions {
	cwd: string;
	run: PersistedTeamRun;
}

export interface BuildCommLogPayloadInput {
	runId: string;
	team: string;
	task: string;
	entries: CommEntry[];
	timestamp?: number;
}

export interface CommLogPayload extends BuildCommLogPayloadInput {
	summary: CommSummary;
	timestamp: number;
}

export function slugifyName(value: string): string {
	const slug = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "team";
}

export async function generateNextRunId(options: GenerateNextRunIdOptions): Promise<string> {
	const specsDir = path.join(options.cwd, SPECS_DIR);
	await mkdir(specsDir, { recursive: true });
	const prefix = slugifyName(options.teamName);
	const entries = await readdir(specsDir, { withFileTypes: true });

	let maxIndex = 0;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const match = entry.name.match(RUN_ID_PATTERN);
		if (!match) continue;
		const [, entryPrefix, indexText] = match;
		if (entryPrefix !== prefix) continue;
		const index = Number.parseInt(indexText, 10);
		if (Number.isFinite(index) && index > maxIndex) {
			maxIndex = index;
		}
	}

	return `${prefix}-${String(maxIndex + 1).padStart(3, "0")}`;
}

export async function writeRunArtifacts(options: WriteRunArtifactsOptions): Promise<RunArtifactManifest> {
	const runDir = path.join(options.cwd, SPECS_DIR, options.run.runId);
	await mkdir(runDir, { recursive: true });

	const manifest: RunArtifactManifest = {
		runDir,
		draftArtifacts: {},
		discussionArtifacts: {},
		discussionPromptArtifacts: {},
	};

	for (const [memberKey, member] of Object.entries(options.run.members)) {
		const draft = options.run.draftResponses[memberKey];
		if (!hasContent(draft)) continue;
		const artifactPath = path.join(runDir, `draft-${safeName(memberKey)}.md`);
		await writeFile(artifactPath, ensureTrailingNewline(draft.trim()), "utf8");
		manifest.draftArtifacts[memberKey] = artifactPath;
	}

	for (const round of options.run.discussionRounds) {
		const key = `r${round.round}`;
		manifest.discussionArtifacts[key] = [];
		manifest.discussionPromptArtifacts[key] = [];
		for (const [memberKey, prompt] of Object.entries(round.promptByMember)) {
			if (!hasContent(prompt)) continue;
			const artifactPath = path.join(runDir, `prompt-discuss-r${round.round}-${safeName(memberKey)}.md`);
			await writeFile(artifactPath, ensureTrailingNewline(prompt.trim()), "utf8");
			manifest.discussionPromptArtifacts[key].push(artifactPath);
		}
		for (const [memberKey, content] of Object.entries(round.responses)) {
			if (!hasContent(content)) continue;
			const artifactPath = path.join(runDir, `discuss-r${round.round}-${safeName(memberKey)}.md`);
			await writeFile(artifactPath, ensureTrailingNewline(content.trim()), "utf8");
			manifest.discussionArtifacts[key].push(artifactPath);
		}
	}

	if (hasContent(options.run.synthesis)) {
		manifest.synthesisArtifact = path.join(runDir, `synthesis-${slugifyName(options.run.teamName)}.md`);
		await writeFile(manifest.synthesisArtifact, ensureTrailingNewline(options.run.synthesis!.trim()), "utf8");

		manifest.finalArtifact = path.join(runDir, "final.md");
		await writeFile(manifest.finalArtifact, ensureTrailingNewline(options.run.synthesis!.trim()), "utf8");
	}

	return manifest;
}

export function buildCommSummary(entries: CommEntry[]): CommSummary {
	const summary: CommSummary = {
		totalEntries: entries.length,
		totalTokensIn: 0,
		totalTokensOut: 0,
		totalDurationMs: 0,
		byPhase: {},
		byAgent: {},
	};

	for (const entry of entries) {
		summary.totalTokensIn += entry.tokens.input;
		summary.totalTokensOut += entry.tokens.output;
		summary.totalDurationMs += entry.durationMs;

		const phaseStats = (summary.byPhase[entry.phase] ??= { count: 0, tokensIn: 0, tokensOut: 0 });
		phaseStats.count += 1;
		phaseStats.tokensIn += entry.tokens.input;
		phaseStats.tokensOut += entry.tokens.output;

		const agentStats = (summary.byAgent[entry.from] ??= { count: 0, tokensIn: 0, tokensOut: 0 });
		agentStats.count += 1;
		agentStats.tokensIn += entry.tokens.input;
		agentStats.tokensOut += entry.tokens.output;
	}

	return summary;
}

export function buildCommLogPayload(input: BuildCommLogPayloadInput): CommLogPayload {
	return {
		runId: input.runId,
		team: input.team,
		task: input.task,
		entries: input.entries,
		summary: buildCommSummary(input.entries),
		timestamp: input.timestamp ?? Date.now(),
	};
}

function hasContent(value: string | undefined): boolean {
	return Boolean(value && value.trim().length > 0);
}

function ensureTrailingNewline(value: string): string {
	return `${value}\n`;
}

function safeName(value: string): string {
	return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}
