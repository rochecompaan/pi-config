import test from "node:test";
import assert from "node:assert/strict";

import registerAuthScope, {
	classifyAuthScope,
	renderAuthScopeStatus,
	type AuthScopeEnvironment,
} from "./index.ts";

const homeDir = "/home/tester";
const cwd = "/workspace/project";

function environment(agentDir: string | undefined): AuthScopeEnvironment {
	return { agentDir, homeDir, cwd };
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
		"~/.pi/agent-jailed",
	]) {
		assert.equal(classifyAuthScope(environment(agentDir)), "LOCAL", agentDir);
	}
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
