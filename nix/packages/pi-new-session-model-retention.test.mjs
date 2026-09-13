import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const piDistDir = process.env.PI_DIST_DIR;
assert.ok(piDistDir, "PI_DIST_DIR must point to the unpacked Pi dist directory");

const { AgentSessionRuntime } = await import(
  pathToFileURL(path.join(piDistDir, "core/agent-session-runtime.js")).href
);

const activeModel = {
  id: "active-model",
  name: "Active Model",
  api: "openai-completions",
  provider: "active-provider",
  baseUrl: "https://active.invalid",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128_000,
  maxTokens: 16_000,
};

const startupModel = {
  ...activeModel,
  id: "startup-model",
  name: "Startup Model",
  provider: "startup-provider",
  baseUrl: "https://startup.invalid",
};

function createHarness(options = {}) {
  const model = Object.hasOwn(options, "model") ? options.model : activeModel;
  const thinkingLevel = options.thinkingLevel ?? "high";
  const cancel = options.cancel ?? false;
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-new-session-test-"));
  const services = { cwd, agentDir: cwd };
  const lifecycle = { aborted: false, disposed: false, replacements: 0 };
  const currentSession = {
    model,
    thinkingLevel,
    sessionFile: path.join(cwd, "current.jsonl"),
    sessionManager: {
      getSessionDir: () => cwd,
      isPersisted: () => false,
    },
    extensionRunner: {
      hasHandlers: (event) => cancel && event === "session_before_switch",
      emit: async () => ({ cancel: true }),
    },
    abort: async () => {
      lifecycle.aborted = true;
    },
    dispose: () => {
      lifecycle.disposed = true;
    },
  };
  const createRuntime = async (options) => {
    lifecycle.replacements += 1;
    return {
      session: {
        model: options.model ?? startupModel,
        thinkingLevel: options.thinkingLevel ?? "medium",
      },
      services,
      diagnostics: [],
    };
  };
  const runtime = new AgentSessionRuntime(currentSession, services, createRuntime);

  return {
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
    currentSession,
    lifecycle,
    runtime,
  };
}

test("new session retains the active model and thinking level", async () => {
  const harness = createHarness();

  try {
    await harness.runtime.newSession();

    assert.deepEqual(harness.runtime.session.model, activeModel);
    assert.equal(harness.runtime.session.thinkingLevel, "high");
    assert.equal(harness.lifecycle.replacements, 1);
  } finally {
    harness.cleanup();
  }
});

test("cancelled new session leaves the active runtime unchanged", async () => {
  const harness = createHarness({ cancel: true });

  try {
    const result = await harness.runtime.newSession();

    assert.deepEqual(result, { cancelled: true });
    assert.equal(harness.runtime.session, harness.currentSession);
    assert.equal(harness.lifecycle.replacements, 0);
    assert.equal(harness.lifecycle.aborted, false);
    assert.equal(harness.lifecycle.disposed, false);
  } finally {
    harness.cleanup();
  }
});

test("new session without an active model keeps startup selection", async () => {
  const harness = createHarness({ model: undefined, thinkingLevel: "off" });

  try {
    await harness.runtime.newSession();

    assert.deepEqual(harness.runtime.session.model, startupModel);
    assert.equal(harness.runtime.session.thinkingLevel, "medium");
  } finally {
    harness.cleanup();
  }
});
