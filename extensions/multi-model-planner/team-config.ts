import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ResolvedAgentDef,
	type ResolvedTeamConfig,
	type ResolvedTeamMember,
	TEAM_THINKING_LEVELS,
	memberKey,
	type TeamConfig,
	type TeamMember,
	type TeamThinkingLevel,
	normalizeLookupName,
} from "./types.ts";

export const PROJECT_TEAMS_DIR = "multi-model-planning-teams";
const PACKAGED_TEAMS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	PROJECT_TEAMS_DIR,
);
const TEAM_FILE_EXTENSIONS = new Set([".yaml", ".yml"]);

export interface LoadTeamConfigsOptions {
	cwd: string;
	agents: ReadonlyMap<string, ResolvedAgentDef>;
}

export interface TeamConfigRegistry {
	byName: Map<string, ResolvedTeamConfig>;
	ordered: ResolvedTeamConfig[];
}

interface ParsedTeamConfigFile {
	name?: unknown;
	description?: unknown;
	agents?: unknown;
	thinking?: unknown;
	consensus?: unknown;
}

interface ParsedThinkingConfig {
	draft?: unknown;
	discussion?: unknown;
	synthesis?: unknown;
}

interface ParsedConsensusConfig {
	model?: unknown;
}

interface ParsedTeamMember {
	name?: unknown;
	model?: unknown;
}

export async function findNearestProjectTeamsDir(cwd: string): Promise<string | null> {
	let currentDir = path.resolve(cwd);

	while (true) {
		const candidate = path.join(currentDir, PROJECT_TEAMS_DIR);
		if (await isDirectory(candidate)) {
			return candidate;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			return null;
		}
		currentDir = parentDir;
	}
}

export async function discoverTeamConfigFiles(cwd: string): Promise<string[]> {
	const teamsDir = (await findNearestProjectTeamsDir(cwd)) ?? (await findPackagedTeamsDir());
	if (!teamsDir) return [];

	const entries = await readdir(teamsDir, { withFileTypes: true });
	return entries
		.filter((entry) => TEAM_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
		.filter((entry) => entry.isFile() || entry.isSymbolicLink())
		.map((entry) => path.join(teamsDir, entry.name))
		.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

async function findPackagedTeamsDir(): Promise<string | null> {
	return (await isDirectory(PACKAGED_TEAMS_DIR)) ? PACKAGED_TEAMS_DIR : null;
}

export async function loadTeamConfigs(options: LoadTeamConfigsOptions): Promise<TeamConfigRegistry> {
	const files = await discoverTeamConfigFiles(options.cwd);
	const ordered: ResolvedTeamConfig[] = [];
	const byName = new Map<string, ResolvedTeamConfig>();

	for (const file of files) {
		const content = await readFile(file, "utf8");
		const team = parseTeamConfig(content, file, options.agents);
		const lookupName = normalizeLookupName(team.name);
		const existing = byName.get(lookupName);
		if (existing) {
			throw new Error(
				`Duplicate team name \"${team.name}\" in ${file}. Already defined in ${existing.file}.`,
			);
		}
		ordered.push(team);
		byName.set(lookupName, team);
	}

	ordered.sort((a, b) => a.name.localeCompare(b.name));
	return { byName, ordered };
}

export function getTeamConfig(registry: TeamConfigRegistry, teamName: string): ResolvedTeamConfig {
	const team = registry.byName.get(normalizeLookupName(teamName));
	if (!team) {
		throw new Error(`Team \"${teamName}\" does not exist.`);
	}
	return team;
}

export function parseTeamConfig(
	content: string,
	file: string,
	agents: ReadonlyMap<string, ResolvedAgentDef>,
): ResolvedTeamConfig {
	const parsed = parseSimpleYaml(content) as ParsedTeamConfigFile;

	const baseConfig: TeamConfig = {
		name: requireNonEmptyString(parsed.name, "name", file),
		description: requireNonEmptyString(parsed.description, "description", file),
		agents: parseTeamMembers(parsed.agents, file),
		thinking: parseThinkingConfig(parsed.thinking, file),
		consensus: parseConsensusConfig(parsed.consensus, file),
		file,
	};

	const members = baseConfig.agents.map((member, index) => resolveTeamMember(member, index, file, agents));
	const consensusModel = resolveConsensusModel(baseConfig.consensus, file);

	return {
		...baseConfig,
		consensus: {
			model: consensusModel,
		},
		members,
	};
}

function parseTeamMembers(value: unknown, file: string): TeamMember[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`Team file ${file} must define a non-empty agents list.`);
	}

	return value.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`Team file ${file} has invalid agents[${index}] entry.`);
		}
		const member = entry as ParsedTeamMember;
		return {
			name: requireNonEmptyString(member.name, `agents[${index}].name`, file),
			model: requireNonEmptyString(member.model, `agents[${index}].model`, file),
		};
	});
}

function parseThinkingConfig(value: unknown, file: string): ResolvedTeamConfig["thinking"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Team file ${file} must define a thinking object.`);
	}
	const thinking = value as ParsedThinkingConfig;
	return {
		draft: requireThinkingLevel(thinking.draft, "thinking.draft", file),
		discussion: requireThinkingLevel(thinking.discussion, "thinking.discussion", file),
		synthesis: requireThinkingLevel(thinking.synthesis, "thinking.synthesis", file),
	};
}

function parseConsensusConfig(value: unknown, file: string): ResolvedTeamConfig["consensus"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Team file ${file} must define a consensus object.`);
	}
	const consensus = value as ParsedConsensusConfig;
	return {
		model: requireNonEmptyString(consensus.model, "consensus.model", file),
	};
}

function resolveConsensusModel(
	consensus: ResolvedTeamConfig["consensus"],
	file: string,
): string {
	if (consensus.model) {
		return consensus.model;
	}
	throw new Error(`Team file ${file} is missing required field \"consensus.model\".`);
}

function resolveTeamMember(
	member: TeamMember,
	index: number,
	file: string,
	agents: ReadonlyMap<string, ResolvedAgentDef>,
): ResolvedTeamMember {
	const agent = agents.get(normalizeLookupName(member.name));
	if (!agent) {
		throw new Error(`Team file ${file} references undefined agent \"${member.name}\".`);
	}
	return {
		...member,
		agent,
		key: memberKey(member.name, member.model, index),
	};
}

function requireThinkingLevel(value: unknown, field: string, file: string): TeamThinkingLevel {
	if (typeof value !== "string" || !(TEAM_THINKING_LEVELS as readonly string[]).includes(value)) {
		throw new Error(
			`Team file ${file} has invalid ${field} value ${JSON.stringify(value)}. Expected one of: ${TEAM_THINKING_LEVELS.join(", ")}.`,
		);
	}
	return value;
}

function requireNonEmptyString(value: unknown, field: string, file: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`Team file ${file} is missing required field \"${field}\".`);
	}
	return value.trim();
}

async function isDirectory(targetPath: string): Promise<boolean> {
	try {
		return (await stat(targetPath)).isDirectory();
	} catch {
		return false;
	}
}

function parseSimpleYaml(content: string): unknown {
	const lines = content.replace(/\t/g, "    ").split(/\r?\n/);
	const [value] = parseBlock(lines, 0, 0);
	return value ?? {};
}

function parseBlock(lines: string[], startIndex: number, indent: number): [unknown, number] {
	let index = skipIgnorable(lines, startIndex);
	if (index >= lines.length) return [{}, index];

	const currentIndent = getIndent(lines[index]);
	if (currentIndent < indent) return [{}, index];
	if (trimComment(lines[index]).trimStart().startsWith("- ")) {
		return parseArray(lines, index, indent);
	}
	return parseObject(lines, index, indent);
}

function parseObject(lines: string[], startIndex: number, indent: number): [Record<string, unknown>, number] {
	const result: Record<string, unknown> = {};
	let index = startIndex;

	while (index < lines.length) {
		index = skipIgnorable(lines, index);
		if (index >= lines.length) break;

		const line = trimComment(lines[index]);
		const currentIndent = getIndent(line);
		if (currentIndent < indent) break;
		if (currentIndent > indent) {
			throw new Error(`Invalid indentation near line ${index + 1}.`);
		}
		if (line.trimStart().startsWith("- ")) break;

		const trimmed = line.trim();
		const separatorIndex = trimmed.indexOf(":");
		if (separatorIndex === -1) {
			throw new Error(`Invalid YAML mapping near line ${index + 1}.`);
		}

		const key = trimmed.slice(0, separatorIndex).trim();
		const rawValue = trimmed.slice(separatorIndex + 1).trim();
		if (rawValue !== "") {
			result[key] = parseScalar(rawValue);
			index += 1;
			continue;
		}

		const nextIndex = skipIgnorable(lines, index + 1);
		if (nextIndex >= lines.length) {
			result[key] = {};
			index = nextIndex;
			continue;
		}

		const nextIndent = getIndent(lines[nextIndex]);
		if (nextIndent <= currentIndent) {
			result[key] = {};
			index = nextIndex;
			continue;
		}

		const [child, endIndex] = parseBlock(lines, nextIndex, nextIndent);
		result[key] = child;
		index = endIndex;
	}

	return [result, index];
}

function parseArray(lines: string[], startIndex: number, indent: number): [unknown[], number] {
	const items: unknown[] = [];
	let index = startIndex;

	while (index < lines.length) {
		index = skipIgnorable(lines, index);
		if (index >= lines.length) break;

		const rawLine = trimComment(lines[index]);
		const currentIndent = getIndent(rawLine);
		if (currentIndent < indent) break;
		if (currentIndent !== indent) {
			throw new Error(`Invalid array indentation near line ${index + 1}.`);
		}

		const trimmed = rawLine.trim();
		if (!trimmed.startsWith("- ")) break;
		const itemText = trimmed.slice(2).trim();

		if (itemText === "") {
			const nextIndex = skipIgnorable(lines, index + 1);
			if (nextIndex >= lines.length) {
				items.push({});
				index = nextIndex;
				continue;
			}
			const nextIndent = getIndent(lines[nextIndex]);
			const [child, endIndex] = parseBlock(lines, nextIndex, nextIndent);
			items.push(child);
			index = endIndex;
			continue;
		}

		if (itemText.includes(":")) {
			const objectValue = parseInlineMapping(itemText, index + 1);
			index += 1;

			const nextIndex = skipIgnorable(lines, index);
			if (nextIndex < lines.length) {
				const nextIndent = getIndent(trimComment(lines[nextIndex]));
				if (nextIndent > currentIndent) {
					const [child, endIndex] = parseObject(lines, nextIndex, nextIndent);
					items.push({ ...objectValue, ...child });
					index = endIndex;
					continue;
				}
			}

			items.push(objectValue);
			continue;
		}

		items.push(parseScalar(itemText));
		index += 1;
	}

	return [items, index];
}

function parseInlineMapping(itemText: string, lineNumber: number): Record<string, unknown> {
	const separatorIndex = itemText.indexOf(":");
	if (separatorIndex === -1) {
		throw new Error(`Invalid YAML mapping near line ${lineNumber}.`);
	}

	const key = itemText.slice(0, separatorIndex).trim();
	const rawValue = itemText.slice(separatorIndex + 1).trim();
	return {
		[key]: rawValue === "" ? {} : parseScalar(rawValue),
	};
}

function parseScalar(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function skipIgnorable(lines: string[], startIndex: number): number {
	let index = startIndex;
	while (index < lines.length) {
		const trimmed = trimComment(lines[index]).trim();
		if (trimmed !== "") return index;
		index += 1;
	}
	return index;
}

function trimComment(line: string): string {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < line.length; i += 1) {
		const char = line[i];
		if (char === '"' && !inSingle) inDouble = !inDouble;
		else if (char === "'" && !inDouble) inSingle = !inSingle;
		else if (char === "#" && !inSingle && !inDouble) return line.slice(0, i);
	}
	return line;
}

function getIndent(line: string): number {
	let indent = 0;
	while (indent < line.length && line[indent] === " ") indent += 1;
	return indent;
}
