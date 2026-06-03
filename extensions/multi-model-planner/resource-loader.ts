import { homedir } from "node:os";
import path from "node:path";

export interface MemberResourceLoaderConfig {
	cwd: string;
	agentDir: string;
	noExtensions: true;
	noSkills: true;
	noPromptTemplates: true;
	noThemes: true;
	noContextFiles: true;
	preserveAgentsFiles: false;
	systemPromptOverride: (base: string | undefined) => string | undefined;
}

export interface CreateMemberResourceLoaderConfigInput {
	cwd: string;
	systemPrompt: string;
}

export interface DefaultResourceLoaderLikeOptions {
	cwd: string;
	agentDir: string;
	noExtensions: true;
	noSkills: true;
	noPromptTemplates: true;
	noThemes: true;
	noContextFiles: true;
	systemPromptOverride: (base: string | undefined) => string | undefined;
	agentsFilesOverride: (base: {
		agentsFiles: Array<{ path: string; content: string }>;
	}) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
}

export function createMemberResourceLoaderConfig(
	input: CreateMemberResourceLoaderConfigInput,
): MemberResourceLoaderConfig {
	return {
		cwd: input.cwd,
		agentDir: getDefaultPiAgentDir(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		preserveAgentsFiles: false,
		systemPromptOverride: () => input.systemPrompt,
	};
}

export function buildMemberResourceLoaderOptions(
	input: CreateMemberResourceLoaderConfigInput,
): DefaultResourceLoaderLikeOptions {
	const config = createMemberResourceLoaderConfig(input);
	return {
		cwd: config.cwd,
		agentDir: config.agentDir,
		noExtensions: config.noExtensions,
		noSkills: config.noSkills,
		noPromptTemplates: config.noPromptTemplates,
		noThemes: config.noThemes,
		noContextFiles: config.noContextFiles,
		systemPromptOverride: config.systemPromptOverride,
		agentsFilesOverride: () => ({ agentsFiles: [] }),
	};
}

function getDefaultPiAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(homedir(), ".pi", "agent");
}
