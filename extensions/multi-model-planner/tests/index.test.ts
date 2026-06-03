import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ResolvedTeamConfig, TeamAvailability } from "../types.ts";

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await ensureRuntimeImportStubs();

const { createMultiModelPlannerExtension } = await import(
	pathToFileURL(path.join(extensionDir, "index.ts")).href,
);

await cleanupRuntimeImportStubs();

async function ensureRuntimeImportStubs(): Promise<void> {
	await Promise.all([
		writeStubPackage("@mariozechner/pi-coding-agent", `
export class DefaultResourceLoader {
	constructor(options) {
		this.options = options;
	}
	async reload() {}
}

export const SessionManager = {
	inMemory() {
		return {};
	},
};

export async function createAgentSession() {
	throw new Error("createAgentSession runtime stub should not be called in index.test.ts");
}
`),
		writeStubPackage("@mariozechner/pi-tui", `
export class Text {
	constructor(text) {
		this.text = text;
	}
	render() {
		return String(this.text).split("\\n");
	}
	invalidate() {}
}
`),
		writeStubPackage("@sinclair/typebox", `
export const Type = {
	Object(properties) {
		return { type: "object", properties };
	},
	String(options = {}) {
		return { type: "string", ...options };
	},
};
`),
	]);
}

async function writeStubPackage(name: string, source: string): Promise<void> {
	const packageDir = path.join(extensionDir, "node_modules", ...name.split("/"));
	await mkdir(packageDir, { recursive: true });
	await Promise.all([
		writeFile(
			path.join(packageDir, "package.json"),
			JSON.stringify({ name, type: "module", exports: "./index.js" }, null, 2),
		),
		writeFile(path.join(packageDir, "index.js"), source.trimStart()),
	]);
}

async function cleanupRuntimeImportStubs(): Promise<void> {
	for (const name of [
		"@mariozechner/pi-coding-agent",
		"@mariozechner/pi-tui",
		"@sinclair/typebox",
	]) {
		await rm(path.join(extensionDir, "node_modules", ...name.split("/")), {
			recursive: true,
			force: true,
		});
	}

	await rm(path.join(extensionDir, "node_modules", "@mariozechner"), {
		recursive: true,
		force: true,
	});
	await rm(path.join(extensionDir, "node_modules", "@sinclair"), {
		recursive: true,
		force: true,
	});
	await rm(path.join(extensionDir, "node_modules"), {
		recursive: true,
		force: true,
	});
}

class FakeText {
	text: string;

	constructor(text: string) {
		this.text = text;
	}

	render(): string[] {
		return this.text.split("\n");
	}
	invalidate(): void {}
}

class FakePi {
	readonly tools: any[] = [];
	readonly commands = new Map<string, any>();
	readonly events = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	readonly appendedEntries: Array<{ customType: string; data: unknown }> = [];

	on(event: string, handler: (event: any, ctx: any) => unknown): void {
		const handlers = this.events.get(event) ?? [];
		handlers.push(handler);
		this.events.set(event, handlers);
	}

	registerTool(definition: any): void {
		this.tools.push(definition);
	}

	registerCommand(name: string, options: any): void {
		this.commands.set(name, options);
	}

	appendEntry(customType: string, data: unknown): void {
		this.appendedEntries.push({ customType, data });
	}
}

function createSchemaStub() {
	return {
		Object(properties: Record<string, unknown>) {
			return { type: "object", properties };
		},
		String(options?: Record<string, unknown>) {
			return { type: "string", ...options };
		},
	};
}

function createThemeStub() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function createTestPlannerDependencies(
	overrides: Record<string, unknown> = {},
) {
	return {
		schema: createSchemaStub(),
		createTextComponent: (text: string) => new FakeText(text),
		createAgentSession: async () => {
			throw new Error("createAgentSession should be stubbed in this test");
		},
		DefaultResourceLoader: class FakeResourceLoader {
			async reload(): Promise<void> {}
		},
		SessionManager: {
			inMemory() {
				return {};
			},
		},
		getAllowedBuiltInToolNames: () => ["read", "bash", "edit", "write", "grep", "find", "ls"],
		loadAgentDefinitions: async () => new Map(),
		loadTeamConfigs: async () => ({ byName: new Map(), ordered: [] }),
		getTeamConfig: () => {
			throw new Error("getTeamConfig should be stubbed in this test");
		},
		createAvailabilityStore: () => ({ hasChecked: false, cache: undefined }),
		ensureAvailabilityChecked: async ({ store }) => {
			store.hasChecked = true;
			store.cache = { checkedAt: 0, byTeam: {} };
			return store.cache;
		},
		refreshAvailabilityCache: async ({ store }) => {
			store.hasChecked = true;
			store.cache = { checkedAt: 0, byTeam: {} };
			return store.cache;
		},
		checkTeamAvailability: async () => makeAvailability(),
		orchestrateTeamRun: async () => makeOutcome(true),
		resolveBuiltInTools: () => [],
		buildMemberResourceLoaderOptions: ({ cwd, systemPrompt }) => ({
			cwd,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => systemPrompt,
			agentsFilesOverride: () => ({ agentsFiles: [] }),
		}),
		renderTranscriptText: () => "TRANSCRIPT",
		now: () => 0,
		...overrides,
	};
}

function makeTeam(): ResolvedTeamConfig {
	return {
		name: "Planning Team",
		description: "Team",
		agents: [
			{ name: "claude", model: "anthropic/claude-sonnet-4-5", agent: { name: "claude", description: "", tools: "read", toolNames: ["read"], systemPrompt: "Claude prompt", file: "claude.md" } },
			{ name: "codex", model: "openai/gpt-5", agent: { name: "codex", description: "", tools: "read", toolNames: ["read"], systemPrompt: "Codex prompt", file: "codex.md" } },
		],
		thinking: { draft: "highest", discussion: "high", synthesis: "high" },
		consensus: { model: "anthropic/claude-sonnet-4-5" },
		file: "planning.yaml",
		members: [
			{ name: "claude", model: "anthropic/claude-sonnet-4-5", agent: { name: "claude", description: "", tools: "read", toolNames: ["read"], systemPrompt: "Claude prompt", file: "claude.md" } },
			{ name: "codex", model: "openai/gpt-5", agent: { name: "codex", description: "", tools: "read", toolNames: ["read"], systemPrompt: "Codex prompt", file: "codex.md" } },
		],
	};
}

function makeAvailability(team = "Planning Team"): TeamAvailability {
	return {
		team,
		availableMembers: [
			{ name: "claude", model: "anthropic/claude-sonnet-4-5", available: true },
			{ name: "codex", model: "openai/gpt-5", available: true },
		],
		unavailableMembers: [],
		consensusModel: "anthropic/claude-sonnet-4-5",
		consensusModelAvailable: true,
		checkedAt: 123,
	};
}

function makeBlockedAvailability(team = "Planning Team"): TeamAvailability {
	return {
		team,
		availableMembers: [
			{ name: "claude", model: "anthropic/claude-sonnet-4-5", available: true },
			{ name: "codex", model: "openai/gpt-5", available: true },
		],
		unavailableMembers: [
			{ name: "gemini", model: "google/gemini-2.5-pro", available: false, reason: "missing API key" },
		],
		consensusModel: "google/gemini-2.5-pro",
		consensusModelAvailable: false,
		checkedAt: 456,
	};
}

function makeOutcome(ok = true) {
	return {
		ok,
		error: ok ? undefined : "synthesis failed",
		result: {
			runId: "planning-team-001",
			team: "Planning Team",
			agents: ["claude", "codex"],
			summary: {
				totalEntries: 4,
				totalTokensIn: 12,
				totalTokensOut: 34,
				totalDurationMs: 56,
			},
			finalOutput: ok ? "Final synthesis" : "",
		},
		details: {
			version: 1,
			ok,
			error: ok ? undefined : "synthesis failed",
			result: {
				runId: "planning-team-001",
				team: "Planning Team",
				agents: ["claude", "codex"],
				summary: {
					totalEntries: 4,
					totalTokensIn: 12,
					totalTokensOut: 34,
					totalDurationMs: 56,
				},
				finalOutput: ok ? "Final synthesis" : "",
			},
			run: {
				runId: "planning-team-001",
				teamName: "Planning Team",
				task: "Design the feature",
				members: {
					claude: { name: "claude", model: "anthropic/claude-sonnet-4-5", status: "done", latestResponse: "Claude" },
					codex: { name: "codex", model: "openai/gpt-5", status: "done", latestResponse: "Codex" },
				},
				draftResponses: { claude: "Claude draft", codex: "Codex draft" },
				discussionRounds: [
					{ round: 1, promptByMember: {}, responses: { claude: "Claude round 1", codex: "Codex round 1" } },
					{ round: 2, promptByMember: {}, responses: { claude: "Claude round 2", codex: "Codex round 2" } },
				],
				synthesis: ok ? "Final synthesis" : undefined,
				startedAt: 1,
				completedAt: 2,
			},
			transcript: {
				teamName: "Planning Team",
				runId: "planning-team-001",
				agentCount: 2,
				leadLine: 'Team lead: Running team "Planning Team".',
				sections: [],
			},
			comm: {
				entries: [],
				summary: {
					totalEntries: 4,
					totalTokensIn: 12,
					totalTokensOut: 34,
					totalDurationMs: 56,
					byPhase: {},
					byAgent: {},
				},
			},
			artifacts: {
				runDir: "/tmp/planning-team-001",
				draftArtifacts: {},
				discussionArtifacts: {},
			},
			availability: makeAvailability(),
		},
	};
}

function createContext() {
	const notifications: Array<{ message: string; level: string }> = [];
	return {
		ctx: {
			cwd: "/workspace",
			modelRegistry: {},
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
			sessionManager: {
				getSessionId() {
					return "session-1";
				},
			},
		},
		notifications,
	};
}

test("registers run_team and /team-check, and only auto-checks availability once per session", async () => {
	const pi = new FakePi();
	const team = makeTeam();
	let ensureCalls = 0;
	const orchestrateCalls: TeamAvailability[] = [];

	const extension = createMultiModelPlannerExtension(createTestPlannerDependencies({
		schema: createSchemaStub(),
		createTextComponent: (text: string) => new FakeText(text),
		getAllowedBuiltInToolNames: () => ["read", "bash", "edit", "write"],
		loadAgentDefinitions: async () => new Map([["claude", team.members[0]!.agent], ["codex", team.members[1]!.agent]]),
		loadTeamConfigs: async () => ({ byName: new Map([["planning team", team]]), ordered: [team] }),
		getTeamConfig: () => team,
		ensureAvailabilityChecked: async ({ store }) => {
			ensureCalls += 1;
			store.hasChecked = true;
			store.cache = { checkedAt: 123, byTeam: { "planning team": makeAvailability() } };
			return store.cache;
		},
		orchestrateTeamRun: async (input) => {
			orchestrateCalls.push(input.availability!);
			return makeOutcome(true);
		},
		renderTranscriptText: () => "TRANSCRIPT",
	}));

	extension(pi as any);

	assert.equal(pi.tools.length, 1);
	assert.equal(pi.commands.has("team-check"), true);
	assert.equal(pi.tools[0]?.name, "run_team");
	assert.match(pi.tools[0]?.promptSnippet ?? "", /multi-model planning\/review teams/i);
	const promptGuidelines = (pi.tools[0]?.promptGuidelines ?? []).join("\n");
	assert.match(promptGuidelines, /team="Review Team"/i);
	assert.match(promptGuidelines, /team="Planning Team"/i);
	assert.match(promptGuidelines, /do not call resolve_agent_team/i);
	assert.deepEqual(Object.keys(pi.tools[0]?.parameters.properties ?? {}), ["task", "team"]);

	const { ctx } = createContext();
	await pi.tools[0].execute("call-1", { task: "Design it", team: "Planning Team" }, undefined, undefined, ctx);
	await pi.tools[0].execute("call-2", { task: "Design it again", team: "Planning Team" }, undefined, undefined, ctx);

	assert.equal(ensureCalls, 1);
	assert.equal(orchestrateCalls.length, 2);
	assert.equal(pi.appendedEntries.length, 2);
	assert.equal(pi.appendedEntries[0]?.customType, "multi-model-planner:comm");
});

test("session lifecycle hooks reset automatic availability behavior", async () => {
	const pi = new FakePi();
	const team = makeTeam();
	let ensureCalls = 0;

	createMultiModelPlannerExtension(createTestPlannerDependencies({
		schema: createSchemaStub(),
		createTextComponent: (text: string) => new FakeText(text),
		getAllowedBuiltInToolNames: () => ["read"],
		loadAgentDefinitions: async () => new Map([["claude", team.members[0]!.agent], ["codex", team.members[1]!.agent]]),
		loadTeamConfigs: async () => ({ byName: new Map([["planning team", team]]), ordered: [team] }),
		getTeamConfig: () => team,
		ensureAvailabilityChecked: async ({ store }) => {
			ensureCalls += 1;
			store.hasChecked = true;
			store.cache = { checkedAt: 123, byTeam: { "planning team": makeAvailability() } };
			return store.cache;
		},
		orchestrateTeamRun: async () => makeOutcome(true),
		renderTranscriptText: () => "TRANSCRIPT",
	}))(pi as any);

	assert.equal(pi.events.has("session_start"), true);
	assert.equal(pi.events.has("session_switch"), false);
	assert.equal(pi.events.has("session_fork"), false);

	const { ctx } = createContext();
	await pi.tools[0].execute("call-1", { task: "Design it", team: "Planning Team" }, undefined, undefined, ctx);
	for (const handler of pi.events.get("session_start") ?? []) {
		await handler({ type: "session_start", reason: "fork", previousSessionFile: "/tmp/previous.jsonl" }, ctx);
	}
	await pi.tools[0].execute("call-2", { task: "Design it", team: "Planning Team" }, undefined, undefined, ctx);

	assert.equal(ensureCalls, 2);
});

test("/team-check refreshes cache and later run_team uses the refreshed availability", async () => {
	const pi = new FakePi();
	const team = makeTeam();
	let refreshCalls = 0;
	let ensureCalls = 0;
	let checkCalls = 0;
	const orchestrateCalls: TeamAvailability[] = [];

	createMultiModelPlannerExtension(createTestPlannerDependencies({
		schema: createSchemaStub(),
		createTextComponent: (text: string) => new FakeText(text),
		getAllowedBuiltInToolNames: () => ["read"],
		loadAgentDefinitions: async () => new Map([["claude", team.members[0]!.agent], ["codex", team.members[1]!.agent]]),
		loadTeamConfigs: async () => ({ byName: new Map([["planning team", team]]), ordered: [team] }),
		getTeamConfig: () => team,
		refreshAvailabilityCache: async ({ store }) => {
			refreshCalls += 1;
			store.hasChecked = true;
			store.cache = { checkedAt: 222, byTeam: { "planning team": makeAvailability() } };
			return store.cache;
		},
		ensureAvailabilityChecked: async () => {
			ensureCalls += 1;
			throw new Error("should not auto-check after manual refresh");
		},
		checkTeamAvailability: async () => {
			checkCalls += 1;
			return makeAvailability();
		},
		orchestrateTeamRun: async (input) => {
			orchestrateCalls.push(input.availability!);
			return makeOutcome(true);
		},
		renderTranscriptText: () => "TRANSCRIPT",
	}))(pi as any);

	const { ctx, notifications } = createContext();
	await pi.commands.get("team-check").handler("", ctx);
	await pi.tools[0].execute("call-1", { task: "Design it", team: "Planning Team" }, undefined, undefined, ctx);

	assert.equal(refreshCalls, 1);
	assert.equal(checkCalls, 0);
	assert.equal(ensureCalls, 0);
	assert.equal(orchestrateCalls.length, 1);
	assert.match(notifications[0]?.message ?? "", /== Planning Team/);
	assert.match(notifications[0]?.message ?? "", /run readiness: READY/i);
	assert.match(notifications[0]?.message ?? "", /consensus model: anthropic\/claude-sonnet-4-5/i);
	assert.match(notifications[0]?.message ?? "", /claude\s+anthropic\/claude-sonnet-4-5/i);
	assert.match(notifications[0]?.message ?? "", /codex\s+openai\/gpt-5/i);
});

test("/team-check shows blocked member models and reasons in roster-first output", async () => {
	const pi = new FakePi();
	const team = makeTeam();

	createMultiModelPlannerExtension(createTestPlannerDependencies({
		schema: createSchemaStub(),
		createTextComponent: (text: string) => new FakeText(text),
		getAllowedBuiltInToolNames: () => ["read"],
		loadAgentDefinitions: async () => new Map([["claude", team.members[0]!.agent], ["codex", team.members[1]!.agent]]),
		loadTeamConfigs: async () => ({ byName: new Map([["planning team", team]]), ordered: [team] }),
		getTeamConfig: () => team,
		refreshAvailabilityCache: async ({ store }) => {
			store.hasChecked = true;
			store.cache = { checkedAt: 456, byTeam: { "planning team": makeBlockedAvailability() } };
			return store.cache;
		},
		renderTranscriptText: () => "TRANSCRIPT",
	}))(pi as any);

	const { ctx, notifications } = createContext();
	await pi.commands.get("team-check").handler("", ctx);

	assert.match(notifications[0]?.message ?? "", /run readiness: BLOCKED/i);
	assert.match(notifications[0]?.message ?? "", /consensus model: google\/gemini-2.5-pro/i);
	assert.match(notifications[0]?.message ?? "", /BLOCK\s+gemini\s+google\/gemini-2.5-pro/i);
	assert.match(notifications[0]?.message ?? "", /reason: missing API key/i);
	assert.match(notifications[0]?.message ?? "", /enough members are available to debate, but synthesis cannot run/i);
});

test("renderResult uses structured transcript rendering instead of rebuilding text inline", () => {
	const pi = new FakePi();
	let renderCalls = 0;

	createMultiModelPlannerExtension(createTestPlannerDependencies({
		schema: createSchemaStub(),
		createTextComponent: (text: string) => new FakeText(text),
		renderTranscriptText: (transcript) => {
			renderCalls += 1;
			return `TRANSCRIPT:${transcript.runId}`;
		},
	}))(pi as any);

	const component = pi.tools[0].renderResult(
		{
			content: [{ type: "text", text: "Compact summary" }],
			details: makeOutcome(true).details,
		},
		{ expanded: true, isPartial: false },
		createThemeStub(),
		{},
	);

	assert.equal(renderCalls, 1);
	assert.equal(component.render(120).join("\n"), "TRANSCRIPT:planning-team-001");
});

test("renderResult shows transcript during partial updates so main-window progress is visible immediately", () => {
	const pi = new FakePi();
	let renderCalls = 0;

	createMultiModelPlannerExtension(createTestPlannerDependencies({
		schema: createSchemaStub(),
		createTextComponent: (text: string) => new FakeText(text),
		renderTranscriptText: (transcript) => {
			renderCalls += 1;
			return `LIVE:${transcript.runId}:${transcript.sections[0]?.title ?? ""}`;
		},
	}))(pi as any);

	const component = pi.tools[0].renderResult(
		{
			content: [{ type: "text", text: 'Running team "Planning Team"...' }],
			details: {
				version: 1,
				progress: {
					phase: "draft",
					phaseMembers: ["claude", "codex"],
					liveResponses: {
						draft: { claude: "Live draft" },
						discussion_round_1: {},
						discussion_round_2: {},
						synthesis: {},
					},
				},
				transcript: {
					teamName: "Planning Team",
					runId: "planning-team-001",
					agentCount: 2,
					leadLine: 'Team lead: Running team "Planning Team".',
					sections: [{ phase: "draft", title: "Draft", statusLine: "1 responses complete · 1 running", entries: [] }],
				},
				availability: makeAvailability(),
			},
		},
		{ expanded: false, isPartial: true },
		createThemeStub(),
		{},
	);

	assert.equal(renderCalls, 1);
	assert.equal(component.render(120).join("\n"), "LIVE:planning-team-001:Draft");
});

test("run_team streams partial transcript details during execution", async () => {
	const pi = new FakePi();
	const team = makeTeam();

	createMultiModelPlannerExtension(createTestPlannerDependencies({
		schema: createSchemaStub(),
		createTextComponent: (text: string) => new FakeText(text),
		getAllowedBuiltInToolNames: () => ["read"],
		loadAgentDefinitions: async () => new Map([["claude", team.members[0]!.agent], ["codex", team.members[1]!.agent]]),
		loadTeamConfigs: async () => ({ byName: new Map([["planning team", team]]), ordered: [team] }),
		getTeamConfig: () => team,
		ensureAvailabilityChecked: async ({ store }) => {
			store.hasChecked = true;
			store.cache = { checkedAt: 123, byTeam: { "planning team": makeAvailability() } };
			return store.cache;
		},
		orchestrateTeamRun: async (input) => {
			input.onProgress?.({
				run: makeOutcome(true).details.run,
				progress: {
					phase: "draft",
					phaseMembers: ["claude", "codex"],
					liveResponses: {
						draft: { claude: "Live draft text" },
						discussion_round_1: {},
						discussion_round_2: {},
						synthesis: {},
					},
				},
				transcript: {
					teamName: "Planning Team",
					runId: "planning-team-001",
					agentCount: 2,
					leadLine: 'Team lead: Running team "Planning Team".',
					sections: [{ phase: "draft", title: "Draft", statusLine: "0 responses complete · 2 running", entries: [] }],
				},
				availability: makeAvailability(),
			});
			return makeOutcome(true);
		},
		renderTranscriptText: () => "TRANSCRIPT",
	}))(pi as any);

	const updates: any[] = [];
	const { ctx } = createContext();
	await pi.tools[0].execute("call-1", { task: "Design it", team: "Planning Team" }, undefined, (update: any) => updates.push(update), ctx);

	assert.ok(updates.some((update) => update.details?.progress?.phase === "draft"));
	assert.ok(updates.some((update) => update.details?.transcript?.runId === "planning-team-001"));
});

test("failed orchestrator outcomes stay structured and surface failure text without throwing", async () => {
	const pi = new FakePi();
	const team = makeTeam();

	createMultiModelPlannerExtension(createTestPlannerDependencies({
		schema: createSchemaStub(),
		createTextComponent: (text: string) => new FakeText(text),
		getAllowedBuiltInToolNames: () => ["read"],
		loadAgentDefinitions: async () => new Map([["claude", team.members[0]!.agent], ["codex", team.members[1]!.agent]]),
		loadTeamConfigs: async () => ({ byName: new Map([["planning team", team]]), ordered: [team] }),
		getTeamConfig: () => team,
		ensureAvailabilityChecked: async ({ store }) => {
			store.hasChecked = true;
			store.cache = { checkedAt: 123, byTeam: { "planning team": makeAvailability() } };
			return store.cache;
		},
		orchestrateTeamRun: async () => makeOutcome(false),
		renderTranscriptText: () => "TRANSCRIPT",
	}))(pi as any);

	const { ctx } = createContext();
	const result = await pi.tools[0].execute("call-1", { task: "Design it", team: "Planning Team" }, undefined, undefined, ctx);

	assert.match(result.content[0].text, /failed/i);
	assert.equal(result.details.ok, false);
	assert.equal(result.details.error, "synthesis failed");
});
