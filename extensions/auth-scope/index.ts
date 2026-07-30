import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import os from "node:os";
import path from "node:path";

export type AuthScope = "GLOBAL" | "LOCAL";

export interface AuthScopeEnvironment {
	agentDir: string | undefined;
	homeDir: string;
	cwd: string;
}

export interface AuthScopeStatusTheme {
	fg(color: "success" | "warning", text: string): string;
}

export type AuthScopeEnvironmentReader = () => AuthScopeEnvironment;

function normalizeAgentDir(input: string, homeDir: string, cwd: string): string {
	let expanded = input.trim();
	if (expanded === "~") expanded = homeDir;
	else if (expanded.startsWith("~/")) expanded = path.join(homeDir, expanded.slice(2));
	return path.resolve(cwd, expanded);
}

export function classifyAuthScope(environment: AuthScopeEnvironment): AuthScope {
	const globalAgentDir = path.resolve(environment.homeDir, ".pi", "agent");
	const configuredAgentDir = environment.agentDir?.trim();
	if (!configuredAgentDir) return "GLOBAL";
	return normalizeAgentDir(configuredAgentDir, environment.homeDir, environment.cwd) === globalAgentDir
		? "GLOBAL"
		: "LOCAL";
}

export function renderAuthScopeStatus(scope: AuthScope, theme: AuthScopeStatusTheme): string {
	const color = scope === "LOCAL" ? "success" : "warning";
	return theme.fg(color, `auth: ${scope}`);
}

const readEnvironment: AuthScopeEnvironmentReader = () => ({
	agentDir: process.env.PI_CODING_AGENT_DIR,
	homeDir: os.homedir(),
	cwd: process.cwd(),
});

export default function registerAuthScope(
	pi: ExtensionAPI,
	getEnvironment: AuthScopeEnvironmentReader = readEnvironment,
): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const scope = classifyAuthScope(getEnvironment());
		ctx.ui.setStatus("auth-scope", renderAuthScopeStatus(scope, ctx.ui.theme));
	});
}
