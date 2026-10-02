import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { pathToFileURL } from "node:url";

const packageRoot = process.env.PI_PACKAGE_ROOT;
assert.ok(packageRoot, "PI_PACKAGE_ROOT is required");
const fromPackage = (path) => pathToFileURL(resolve(packageRoot, path)).href;

const { getAuthPath } = await import(fromPackage("dist/config.js"));
const { AuthStorage, ReadOnlyAuthStorage, readStoredCredential } = await import(
	fromPackage("dist/core/auth-storage.js")
);

const managedEnv = ["HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_AUTH_FILE"];
let savedEnv;
let root;
let agentDir;
let globalAuthFile;
let projectAuthFile;

function apiKey(key) {
	return { type: "api_key", key };
}

function writeJson(path, value) {
	writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf-8"));
}

beforeEach(() => {
	savedEnv = Object.fromEntries(managedEnv.map((name) => [name, process.env[name]]));
	root = mkdtempSync(join(tmpdir(), "pi-auth-file-"));
	agentDir = join(root, "agent");
	globalAuthFile = join(agentDir, "auth.json");
	projectAuthFile = join(root, "project", ".pi", "local-agent", "auth.json");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(root, "project", ".pi", "local-agent"), { recursive: true });
	writeJson(globalAuthFile, { openai: apiKey("sk-global") });
	writeJson(projectAuthFile, { openai: apiKey("sk-project") });

	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_CODING_AGENT_AUTH_FILE;
});

afterEach(() => {
	for (const [name, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

test("uses the agent directory auth file when the override is unset or empty", async () => {
	for (const value of [undefined, ""]) {
		if (value === undefined) delete process.env.PI_CODING_AGENT_AUTH_FILE;
		else process.env.PI_CODING_AGENT_AUTH_FILE = value;

		assert.equal(getAuthPath(), globalAuthFile);
		assert.deepEqual(await AuthStorage.create().read("openai"), apiKey("sk-global"));
	}
});

test("reads credentials from the override file for default storage", async () => {
	process.env.PI_CODING_AGENT_AUTH_FILE = projectAuthFile;

	assert.equal(getAuthPath(), projectAuthFile);
	assert.deepEqual(await AuthStorage.create().read("openai"), apiKey("sk-project"));
});

test("redirects callers that pass the agent directory auth file explicitly", async () => {
	process.env.PI_CODING_AGENT_AUTH_FILE = projectAuthFile;

	const storage = AuthStorage.create(join(agentDir, "auth.json"));

	assert.deepEqual(await storage.read("openai"), apiKey("sk-project"));
});

test("redirects a home-relative agent directory auth path in every reader", async () => {
	process.env.HOME = join(root, "home");
	delete process.env.PI_CODING_AGENT_DIR;
	const homeAgentDir = join(root, "home", ".pi", "agent");
	mkdirSync(homeAgentDir, { recursive: true });
	writeJson(join(homeAgentDir, "auth.json"), { openai: apiKey("sk-global") });
	process.env.PI_CODING_AGENT_AUTH_FILE = projectAuthFile;
	const tildePath = "~/.pi/agent/auth.json";

	assert.deepEqual(await AuthStorage.create(tildePath).read("openai"), apiKey("sk-project"));
	assert.deepEqual(await new ReadOnlyAuthStorage(tildePath).read("openai"), apiKey("sk-project"));
	assert.deepEqual(readStoredCredential("openai", tildePath), apiKey("sk-project"));
});

test("expands a home-relative override path", async () => {
	process.env.PI_CODING_AGENT_AUTH_FILE = "~/project/.pi/local-agent/auth.json";

	assert.equal(getAuthPath(), projectAuthFile);
	assert.deepEqual(await AuthStorage.create().read("openai"), apiKey("sk-project"));
});

test("writes credentials to the override file and leaves the global file unchanged", async () => {
	process.env.PI_CODING_AGENT_AUTH_FILE = projectAuthFile;
	const globalBefore = readFileSync(globalAuthFile, "utf-8");

	await AuthStorage.create().modify("anthropic", () => apiKey("sk-new-project"));

	assert.deepEqual(readJson(projectAuthFile), {
		openai: apiKey("sk-project"),
		anthropic: apiKey("sk-new-project"),
	});
	assert.equal(readFileSync(globalAuthFile, "utf-8"), globalBefore);
});

test("creates a missing override file with private permissions", async () => {
	const missingAuthFile = join(root, "other-project", ".pi", "local-agent", "auth.json");
	process.env.PI_CODING_AGENT_AUTH_FILE = missingAuthFile;

	await AuthStorage.create().modify("openai", () => apiKey("sk-other"));

	assert.deepEqual(readJson(missingAuthFile), { openai: apiKey("sk-other") });
	assert.equal(statSync(missingAuthFile).mode & 0o777, 0o600);
	assert.deepEqual(readJson(globalAuthFile), { openai: apiKey("sk-global") });
});

test("read-only storage and one-off reads use the override file", async () => {
	process.env.PI_CODING_AGENT_AUTH_FILE = projectAuthFile;

	assert.deepEqual(await new ReadOnlyAuthStorage().read("openai"), apiKey("sk-project"));
	assert.deepEqual(readStoredCredential("openai"), apiKey("sk-project"));
	assert.deepEqual(readStoredCredential("openai", join(agentDir, "auth.json")), apiKey("sk-project"));
});

test("does not redirect other credential files", async () => {
	process.env.PI_CODING_AGENT_AUTH_FILE = projectAuthFile;
	const mcpAuthFile = join(agentDir, "mcp-auth.json");
	writeJson(mcpAuthFile, { server: apiKey("sk-mcp") });

	assert.deepEqual(await AuthStorage.create(mcpAuthFile).read("server"), apiKey("sk-mcp"));
	assert.deepEqual(readStoredCredential("server", mcpAuthFile), apiKey("sk-mcp"));
});
