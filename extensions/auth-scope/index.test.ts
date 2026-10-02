import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import registerAuthScope, {
	classifyAuthScope,
	renderAuthScopeStatus,
	type AuthScopeEnvironment,
} from "./index.ts";

const homeDir = "/home/tester";
const cwd = "/workspace/project";

function environment(agentDir: string | undefined, authFile?: string): AuthScopeEnvironment {
	return { agentDir, authFile, homeDir, cwd };
}

test("classifies unset and normalized global agent directories as GLOBAL", () => {
	for (const agentDir of [
		undefined,
		"",
		"   ",
		"/home/tester/.pi/agent",
		"/home/tester/.pi/agent/",
		"~/.pi/agent",
	]) {
		assert.equal(classifyAuthScope(environment(agentDir)), "GLOBAL", String(agentDir));
	}
});

test("classifies non-global agent directories as LOCAL", () => {
	for (const agentDir of [
		".pi/local-agent",
		"/workspace/project/.pi/local-agent",
		"~/.pi/local-agent",
	]) {
		assert.equal(classifyAuthScope(environment(agentDir)), "LOCAL", agentDir);
	}
});

test("classifies auth file overrides outside the global agent directory as LOCAL", () => {
	for (const authFile of [
		".pi/local-agent/auth.json",
		"/workspace/project/.pi/local-agent/auth.json",
		"~/.pi/profiles/clubhouse/auth.json",
	]) {
		assert.equal(classifyAuthScope(environment(undefined, authFile)), "LOCAL", authFile);
	}
});

test("classifies auth file overrides naming the global auth file as GLOBAL", () => {
	for (const authFile of ["", "   ", "~/.pi/agent/auth.json", "/home/tester/.pi/agent/auth.json"]) {
		assert.equal(classifyAuthScope(environment(undefined, authFile)), "GLOBAL", authFile);
	}
});

test("lets the auth file override take precedence over the agent directory", () => {
	assert.equal(
		classifyAuthScope(environment("/workspace/project/.pi/local-agent", "~/.pi/agent/auth.json")),
		"GLOBAL",
	);
	assert.equal(
		classifyAuthScope(environment("~/.pi/agent", "/workspace/project/.pi/local-agent/auth.json")),
		"LOCAL",
	);
});

test("renders LOCAL as success and GLOBAL as warning", () => {
	const theme = {
		fg(color: "success" | "warning", text: string) {
			return `[${color}]${text}`;
		},
	};

	assert.equal(renderAuthScopeStatus("LOCAL", theme), "[success]auth: LOCAL");
	assert.equal(renderAuthScopeStatus("GLOBAL", theme), "[warning]auth: GLOBAL");
});

type SessionStartHook = (event: unknown, ctx: any) => Promise<void>;

function createHarness() {
	let sessionStart: SessionStartHook | undefined;
	const pi = {
		on(name: string, handler: SessionStartHook) {
			if (name === "session_start") sessionStart = handler;
		},
	};
	return {
		pi,
		getSessionStart() {
			assert.ok(sessionStart);
			return sessionStart;
		},
	};
}

function createContext(hasUI: boolean) {
	const statusCalls: Array<[string, string | undefined]> = [];
	return {
		ctx: {
			hasUI,
			ui: {
				theme: {
					fg(color: "success" | "warning", text: string) {
						return `[${color}]${text}`;
					},
				},
				setStatus(key: string, value: string | undefined) {
					statusCalls.push([key, value]);
				},
			},
		},
		statusCalls,
	};
}

test("publishes themed LOCAL and GLOBAL statuses in UI sessions", async () => {
	for (const [agentDir, expected] of [
		["/workspace/project/.pi/local-agent", "[success]auth: LOCAL"],
		[undefined, "[warning]auth: GLOBAL"],
	] as const) {
		const harness = createHarness();
		const { ctx, statusCalls } = createContext(true);
		registerAuthScope(harness.pi as any, () => environment(agentDir));

		await harness.getSessionStart()({}, ctx);

		assert.deepEqual(statusCalls, [["auth-scope", expected]]);
	}
});

test("reads the auth file override from the process environment by default", async (t) => {
	const saved = {
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		PI_CODING_AGENT_AUTH_FILE: process.env.PI_CODING_AGENT_AUTH_FILE,
	};
	t.after(() => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	delete process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_AUTH_FILE = "/workspace/project/.pi/local-agent/auth.json";
	const harness = createHarness();
	const { ctx, statusCalls } = createContext(true);
	registerAuthScope(harness.pi as any);

	await harness.getSessionStart()({}, ctx);

	assert.deepEqual(statusCalls, [["auth-scope", "[success]auth: LOCAL"]]);
});

test("classifies an auth file symlink by its target", async (t) => {
	const saved = {
		HOME: process.env.HOME,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		PI_CODING_AGENT_AUTH_FILE: process.env.PI_CODING_AGENT_AUTH_FILE,
	};
	const root = mkdtempSync(path.join(tmpdir(), "auth-scope-"));
	t.after(() => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	mkdirSync(path.join(root, ".pi", "agent"), { recursive: true });
	writeFileSync(path.join(root, ".pi", "agent", "auth.json"), "{}");
	mkdirSync(path.join(root, "project"));
	symlinkSync(path.join(root, ".pi", "agent", "auth.json"), path.join(root, "project", "auth.json"));
	process.env.HOME = root;
	delete process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_AUTH_FILE = path.join(root, "project", "auth.json");
	const harness = createHarness();
	const { ctx, statusCalls } = createContext(true);
	registerAuthScope(harness.pi as any);

	await harness.getSessionStart()({}, ctx);

	assert.deepEqual(statusCalls, [["auth-scope", "[warning]auth: GLOBAL"]]);
});

test("does not read environment or publish status without UI", async () => {
	const harness = createHarness();
	const { ctx, statusCalls } = createContext(false);
	let environmentReads = 0;
	registerAuthScope(harness.pi as any, () => {
		environmentReads++;
		return environment("/workspace/project/.pi/local-agent");
	});

	await harness.getSessionStart()({}, ctx);

	assert.equal(environmentReads, 0);
	assert.deepEqual(statusCalls, []);
});
