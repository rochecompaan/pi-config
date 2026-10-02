import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AuthScope = "GLOBAL" | "LOCAL";

export interface AuthScopeEnvironment {
	agentDir: string | undefined;
	authFile: string | undefined;
	homeDir: string;
	cwd: string;
	/** Resolves symlinks in an existing path; defaults to comparing paths as written. */
	resolveSymlinks?: (filePath: string) => string;
}

export interface AuthScopeStatusTheme {
	fg(color: "success" | "warning", text: string): string;
}

export type AuthScopeEnvironmentReader = () => AuthScopeEnvironment;

function normalizePath(input: string, homeDir: string, cwd: string): string {
	let expanded = input.trim();
	if (expanded === "~") expanded = homeDir;
	else if (expanded.startsWith("~/")) expanded = path.join(homeDir, expanded.slice(2));
	return path.resolve(cwd, expanded);
}

function resolveAuthFile(environment: AuthScopeEnvironment, globalAgentDir: string): string {
	const { homeDir, cwd } = environment;
	const authFile = environment.authFile?.trim();
	if (authFile) return normalizePath(authFile, homeDir, cwd);
	const agentDir = environment.agentDir?.trim();
	return path.join(agentDir ? normalizePath(agentDir, homeDir, cwd) : globalAgentDir, "auth.json");
}

export function classifyAuthScope(environment: AuthScopeEnvironment): AuthScope {
	const globalAgentDir = path.resolve(environment.homeDir, ".pi", "agent");
	const resolveSymlinks = environment.resolveSymlinks ?? ((filePath: string) => filePath);
	return resolveSymlinks(resolveAuthFile(environment, globalAgentDir)) ===
		resolveSymlinks(path.join(globalAgentDir, "auth.json"))
		? "GLOBAL"
		: "LOCAL";
}

export function renderAuthScopeStatus(scope: AuthScope, theme: AuthScopeStatusTheme): string {
	const color = scope === "LOCAL" ? "success" : "warning";
	return theme.fg(color, `auth: ${scope}`);
}

function resolveExistingSymlinks(filePath: string): string {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return filePath;
	}
}

const readEnvironment: AuthScopeEnvironmentReader = () => ({
	agentDir: process.env.PI_CODING_AGENT_DIR,
	authFile: process.env.PI_CODING_AGENT_AUTH_FILE,
	homeDir: os.homedir(),
	cwd: process.cwd(),
	resolveSymlinks: resolveExistingSymlinks,
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
