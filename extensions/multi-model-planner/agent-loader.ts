import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
	TEAM_THINKING_LEVELS,
	type ResolvedAgentDef,
	type TeamThinkingLevel,
	normalizeLookupName,
} from "./types.ts";

export const PROJECT_AGENTS_DIR = path.join(".pi", "agents");

export interface LoadAgentDefinitionsOptions {
	cwd: string;
	allowedToolNames: Iterable<string>;
}

export interface ParsedAgentFrontmatter {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
}

export function isValidThinkingLevel(value: unknown): value is TeamThinkingLevel {
	return typeof value === "string" && (TEAM_THINKING_LEVELS as readonly string[]).includes(value);
}

export function normalizeToolList(tools: string): string[] {
	return Array.from(
		new Set(
			tools
				.split(",")
				.map((toolName) => toolName.trim())
				.filter(Boolean),
		),
	);
}

export async function findNearestProjectAgentsDir(cwd: string): Promise<string | null> {
	let currentDir = path.resolve(cwd);

	while (true) {
		const candidate = path.join(currentDir, PROJECT_AGENTS_DIR);
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

export async function discoverAgentDefinitionFiles(cwd: string): Promise<string[]> {
	const agentsDir = await findNearestProjectAgentsDir(cwd);
	if (!agentsDir) {
		return [];
	}

	const entries = await readdir(agentsDir, { withFileTypes: true });
	return entries
		.filter((entry) => entry.name.endsWith(".md"))
		.filter((entry) => entry.name.toLowerCase() !== "readme.md")
		.filter((entry) => entry.isFile() || entry.isSymbolicLink())
		.map((entry) => path.join(agentsDir, entry.name))
		.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

export async function loadAgentDefinitions(options: LoadAgentDefinitionsOptions): Promise<Map<string, ResolvedAgentDef>> {
	const allowedToolNames = new Set(Array.from(options.allowedToolNames, (name) => normalizeLookupName(name)));
	const files = await discoverAgentDefinitionFiles(options.cwd);
	const agents = new Map<string, ResolvedAgentDef>();

	for (const file of files) {
		const content = await readFile(file, "utf8");
		const agent = parseAgentDefinition(content, file, allowedToolNames);
		const normalizedName = normalizeLookupName(agent.name);
		const existing = agents.get(normalizedName);
		if (existing) {
			throw new Error(
				`Duplicate agent name \"${agent.name}\" in ${file}. Already defined in ${existing.file}.`,
			);
		}
		agents.set(normalizedName, agent);
	}

	return agents;
}

export function parseAgentDefinition(
	content: string,
	file: string,
	allowedToolNames: ReadonlySet<string>,
): ResolvedAgentDef {
	const { frontmatter, body } = parseSimpleFrontmatter(content);

	const name = requireNonEmptyString(frontmatter.name, "name", file);
	const description = requireNonEmptyString(frontmatter.description, "description", file);
	const rawTools = requireNonEmptyString(frontmatter.tools, "tools", file);
	const toolNames = normalizeToolList(rawTools);

	if (toolNames.length === 0) {
		throw new Error(`Agent file ${file} must define at least one tool in frontmatter.tools.`);
	}

	const unknownTools = toolNames.filter((toolName) => !allowedToolNames.has(normalizeLookupName(toolName)));
	if (unknownTools.length > 0) {
		throw new Error(
			`Agent file ${file} references unknown tools: ${unknownTools.join(", ")}. Allowed tools: ${Array.from(allowedToolNames).sort().join(", ")}.`,
		);
	}

	const model = optionalString(frontmatter.model, "model", file);
	const thinking = parseThinking(frontmatter.thinking, file);

	return {
		name,
		description,
		tools: rawTools,
		toolNames,
		model,
		thinking,
		systemPrompt: body,
		file,
	};
}

function parseThinking(value: unknown, file: string): TeamThinkingLevel | undefined {
	if (value === undefined || value === null || value === "") {
		return undefined;
	}
	if (!isValidThinkingLevel(value)) {
		throw new Error(
			`Agent file ${file} has invalid thinking value ${JSON.stringify(value)}. Expected one of: ${TEAM_THINKING_LEVELS.join(", ")}.`,
		);
	}
	return value;
}

function requireNonEmptyString(value: unknown, field: string, file: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`Agent file ${file} is missing required frontmatter field \"${field}\".`);
	}
	return value.trim();
}

function optionalString(value: unknown, field: string, file: string): string | undefined {
	if (value === undefined || value === null || value === "") {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`Agent file ${file} has non-string frontmatter field \"${field}\".`);
	}
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

async function isDirectory(targetPath: string): Promise<boolean> {
	try {
		return (await stat(targetPath)).isDirectory();
	} catch {
		return false;
	}
}

function parseSimpleFrontmatter(content: string): {
	frontmatter: ParsedAgentFrontmatter;
	body: string;
} {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
		return { frontmatter: {}, body: content };
	}

	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) {
		return { frontmatter: {}, body: content };
	}

	const [, rawFrontmatter, body] = match;
	const frontmatter: ParsedAgentFrontmatter = {};

	for (const rawLine of rawFrontmatter.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const separatorIndex = line.indexOf(":");
		if (separatorIndex === -1) continue;
		const key = line.slice(0, separatorIndex).trim();
		const value = line.slice(separatorIndex + 1).trim();
		frontmatter[key as keyof ParsedAgentFrontmatter] = value;
	}

	return { frontmatter, body };
}
