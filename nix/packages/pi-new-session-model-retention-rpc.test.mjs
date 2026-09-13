import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const piDistDir = process.env.PI_DIST_DIR;
assert.ok(piDistDir, "PI_DIST_DIR must point to the unpacked Pi dist directory");

function withTimeout(promise, label) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out while ${label}`)), 20_000);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function startRpc({ agentDir, cwd, sessionDir }) {
  const child = spawn(
    process.execPath,
    [path.join(piDistDir, "cli.js"), "--mode", "rpc", "--session-dir", sessionDir],
    {
      cwd,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let buffer = "";
  let stderr = "";
  let nextId = 0;
  let stopped = false;
  const pending = new Map();
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      const error = new Error(
        `Pi RPC exited before responding (code=${code}, signal=${signal})\n${stderr}`,
      );
      for (const request of pending.values()) {
        clearTimeout(request.timeout);
        request.reject(error);
      }
      pending.clear();
      resolve({ code, signal });
    });
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        child.kill();
        for (const request of pending.values()) request.reject(error);
        pending.clear();
        return;
      }

      if (message.type !== "response" || !message.id) continue;
      const request = pending.get(message.id);
      if (!request) continue;
      clearTimeout(request.timeout);
      pending.delete(message.id);
      if (message.success) {
        request.resolve(message.data);
      } else {
        request.reject(new Error(`${message.command}: ${message.error}\n${stderr}`));
      }
    }
  });

  return {
    async close() {
      if (stopped) return;
      stopped = true;
      child.stdin.end();
      let result;
      try {
        result = await withTimeout(exitPromise, "stopping Pi RPC");
      } catch (error) {
        child.kill("SIGKILL");
        await exitPromise;
        throw error;
      }
      assert.equal(result.signal, null, stderr);
      assert.equal(result.code, 0, stderr);
    },
    async request(command) {
      const id = `request-${++nextId}`;
      const response = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Pi RPC did not answer ${command.type}\n${stderr}`));
        }, 20_000);
        pending.set(id, { reject, resolve, timeout });
      });
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
      return response;
    },
  };
}

function writeFixtureConfig(agentDir) {
  mkdirSync(agentDir, { recursive: true });
  const settings = `${JSON.stringify(
    {
      defaultProvider: "fixture",
      defaultModel: "startup-model",
      defaultThinkingLevel: "medium",
      defaultProjectTrust: "never",
      enableInstallTelemetry: false,
    },
    null,
    2,
  )}\n`;
  writeFileSync(path.join(agentDir, "settings.json"), settings);
  writeFileSync(
    path.join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          fixture: {
            baseUrl: "https://fixture.invalid/v1",
            api: "openai-completions",
            apiKey: "fixture-key",
            models: [
              { id: "startup-model", reasoning: true },
              { id: "active-model", reasoning: true },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return settings;
}

test("RPC new_session retains runtime selection without changing startup defaults", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-new-session-rpc-test-"));
  const agentDir = path.join(root, "agent");
  const projectDir = path.join(root, "project");
  mkdirSync(projectDir);
  const originalSettings = writeFixtureConfig(agentDir);

  try {
    const first = startRpc({
      agentDir,
      cwd: projectDir,
      sessionDir: path.join(root, "first-sessions"),
    });
    try {
      const startup = await first.request({ type: "get_state" });
      assert.equal(startup.model.provider, "fixture");
      assert.equal(startup.model.id, "startup-model");
      assert.equal(startup.thinkingLevel, "medium");

      await first.request({ type: "set_model", provider: "fixture", modelId: "active-model" });
      await first.request({ type: "set_thinking_level", level: "high" });
      await first.request({ type: "new_session" });

      const replacement = await first.request({ type: "get_state" });
      assert.equal(replacement.model.provider, "fixture");
      assert.equal(replacement.model.id, "active-model");
      assert.equal(replacement.thinkingLevel, "high");

      const { entries } = await first.request({ type: "get_entries" });
      assert.deepEqual(
        entries.map(({ type, provider, modelId, thinkingLevel }) => ({
          type,
          provider,
          modelId,
          thinkingLevel,
        })),
        [
          {
            type: "model_change",
            provider: "fixture",
            modelId: "active-model",
            thinkingLevel: undefined,
          },
          {
            type: "thinking_level_change",
            provider: undefined,
            modelId: undefined,
            thinkingLevel: "high",
          },
        ],
      );
    } finally {
      await first.close();
    }

    assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf8"), originalSettings);

    const second = startRpc({
      agentDir,
      cwd: projectDir,
      sessionDir: path.join(root, "second-sessions"),
    });
    try {
      const freshStartup = await second.request({ type: "get_state" });
      assert.equal(freshStartup.model.provider, "fixture");
      assert.equal(freshStartup.model.id, "startup-model");
      assert.equal(freshStartup.thinkingLevel, "medium");
    } finally {
      await second.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
