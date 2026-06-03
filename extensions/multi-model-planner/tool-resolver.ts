import type { ResolvedAgentDef } from "./types.ts";

export const DEFAULT_PI_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type DefaultPiToolName = (typeof DEFAULT_PI_TOOL_NAMES)[number];

export interface ResolveBuiltInToolsInput {
	agent: Pick<ResolvedAgentDef, "name" | "toolNames">;
}

export function getAllowedBuiltInToolNames(): DefaultPiToolName[] {
	return [...DEFAULT_PI_TOOL_NAMES];
}

export function resolveBuiltInToolNames(toolNames: readonly string[]): DefaultPiToolName[] {
	const normalizedNames = Array.from(
		new Set(toolNames.map((toolName) => toolName.trim().toLowerCase()).filter(Boolean)),
	);
	const unsupported = normalizedNames.filter((toolName) => !DEFAULT_PI_TOOL_NAMES.includes(toolName as DefaultPiToolName));
	if (unsupported.length > 0) {
		throw new Error(`Unsupported built-in tools: ${unsupported.join(", ")}.`);
	}
	return normalizedNames as DefaultPiToolName[];
}

export function resolveBuiltInTools(input: ResolveBuiltInToolsInput): DefaultPiToolName[] {
	return resolveBuiltInToolNames(input.agent.toolNames);
}

export function resolveAgentRole(agent: Pick<ResolvedAgentDef, "name">): "planner" | "review" {
	if (agent.name.toLowerCase().includes("review")) {
		return "review";
	}
	return "planner";
}
