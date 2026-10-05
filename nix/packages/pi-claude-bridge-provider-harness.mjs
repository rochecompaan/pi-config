import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const piFacadeSource = `
export const calculateCost = () => {};
export const StringEnum = (values) => ({ type: 'string', enum: values });
export const contentText = (content) => typeof content === 'string'
  ? content : (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\\n');
export const getCurrentSystemMessage = () => undefined;
export const getCurrentTools = () => [];
export const getModels = () => [];
export const CONFIG_DIR_NAME = '.pi';
export const getAgentDir = () => process.env.HOME + '/.pi/agent';
export const formatSkillsForPrompt = () => '';
export const buildSessionContext = () => { throw new Error('Unexpected session projection in provider test'); };
export const compact = () => { throw new Error('Unexpected compaction in provider test'); };
export const generateBranchSummary = () => { throw new Error('Unexpected branch summary in provider test'); };
export const keyHint = () => '';
export class Text {}
export const Type = {};
export function createAssistantMessageEventStream() {
  const values = [];
  const waiters = [];
  let ended = false;
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  return {
    push(event) {
      if (event.type === 'done') resolveResult(event.message);
      if (event.type === 'error') resolveResult(event.error);
      const waiter = waiters.shift();
      if (waiter) waiter({ value: event, done: false });
      else values.push(event);
    },
    end() {
      ended = true;
      for (const waiter of waiters.splice(0)) waiter({ done: true });
    },
    result: () => result,
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (values.length) return Promise.resolve({ value: values.shift(), done: false });
      if (ended) return Promise.resolve({ done: true });
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}
`;

export function controlledQueue() {
  const values = [];
  const waiters = [];
  let ended = false;
  let failure;
  return {
    push(value) {
      if (ended) return;
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ value, done: false });
      else values.push(value);
    },
    end(error) {
      ended = true;
      failure = error;
      for (const waiter of waiters.splice(0)) {
        if (error) waiter.reject(error);
        else waiter.resolve({ done: true });
      }
    },
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (values.length) return Promise.resolve({ value: values.shift(), done: false });
      if (failure) return Promise.reject(failure);
      if (ended) return Promise.resolve({ done: true });
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    return() { this.end(); return Promise.resolve({ done: true }); },
  };
}

function controlledSdkQuery(args) {
  const events = controlledQueue();
  const prompts = [];
  let releaseInput;
  let inputGate;
  const sessionId = args.options.resume ?? randomUUID();
  events.push({ type: 'system', subtype: 'init', session_id: sessionId });
  const q = {
    args,
    sessionId,
    prompts,
    closed: 0,
    emit: (message) => events.push(message),
    finish() { this.resumeInput(); events.end(); },
    fail(error) { this.resumeInput(); events.end(error); },
    interrupt: async () => {},
    close() { this.closed++; },
    pauseInput() {
      if (!inputGate) inputGate = new Promise((resolve) => { releaseInput = resolve; });
    },
    resumeInput() {
      releaseInput?.();
      releaseInput = undefined;
      inputGate = undefined;
    },
    [Symbol.asyncIterator]: () => events,
  };
  q.inputDone = (async () => {
    try {
      for await (const message of args.prompt) {
        prompts.push(message);
        if (inputGate) await inputGate;
      }
    } catch {
      // Retirement and abort deliberately fail the input stream.
    }
  })();
  return q;
}

export function flush() { return new Promise((resolve) => setImmediate(resolve)); }

export async function connectMcpToolClient(server) {
  const pending = new Map();
  const transport = {
    start: async () => {},
    close: async () => {},
    send: async (message) => pending.get(message.id)?.(message),
  };
  await server.instance.connect(transport);
  let nextId = 0;
  const request = (method, params) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    transport.onmessage({ jsonrpc: '2.0', id, method, params });
  });
  await request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' },
  });
  transport.onmessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return (name, toolUseId) => request('tools/call', {
    name, arguments: {}, _meta: { 'claudecode/toolUseId': toolUseId },
  });
}

export async function loadProvider(modulePath) {
  const home = mkdtempSync(join(tmpdir(), 'bridge-provider-test-'));
  const savedEnv = Object.fromEntries(['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_BRIDGE_DEBUG_PATH', 'CLAUDE_BRIDGE_RECORD_STREAM']
    .map((name) => [name, process.env[name]]));
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
  process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(home, 'bridge.log');
  delete process.env.CLAUDE_BRIDGE_RECORD_STREAM;
  const queries = [];
  const sdkKey = Symbol.for('bridgeProviderTestSdk');
  globalThis[sdkKey] = (args) => {
    const q = controlledSdkQuery(args);
    queries.push(q);
    return q;
  };
  const asModule = (source) => 'data:text/javascript,' + encodeURIComponent(source);
  const facadeUrl = asModule(piFacadeSource);
  const sdkUrl = asModule("export const query = (args) => globalThis[Symbol.for('bridgeProviderTestSdk')](args);");
  const providerUrl = pathToFileURL(modulePath).href;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@anthropic-ai/claude-agent-sdk') return { url: sdkUrl, shortCircuit: true };
      if (specifier.startsWith('@earendil-works/pi-') || specifier === 'typebox') return { url: facadeUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.') || !specifier.endsWith('.js')) throw error;
        const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
        if (!existsSync(fileURLToPath(url))) throw error;
        return { url: url.href, shortCircuit: true };
      }
    },
    load(url, context, nextLoad) {
      if (!url.startsWith('file:') || !url.endsWith('.ts')) return nextLoad(url, context);
      let source = readFileSync(fileURLToPath(url), 'utf8');
      if (url === providerUrl) source += '\nexport const __providerHarness = { request: typeof streamClaudeAgentRequest === "function" ? streamClaudeAgentRequest : streamClaudeAgentSdk, activeQueryContexts, root: ctx, ask: promptAndWait };\n';
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform' }), shortCircuit: true };
    },
  });
  const { __providerHarness, __test } = await import(providerUrl);
  const { PROVIDER_ID } = await import(new URL('./convert.ts', providerUrl));
  const model = {
    provider: PROVIDER_ID, api: 'claude-agent-sdk', id: 'claude-sonnet-5',
    name: 'Test model', contextWindow: 1_000_000, maxTokens: 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const tools = [{
    name: 'read', description: 'Read a test fixture',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  }];
  const reset = async () => {
    for (const q of queries) q.finish();
    await flush();
    await Promise.all(queries.map((q) => q.inputDone));
    queries.splice(0);
    __test.resetSharedSession();
  };
  const hasSessionIds = __test.setSharedSession.length === 2;
  return {
    model, PROVIDER_ID, queries, hasSessionIds,
    request: (messages, signal, sessionId) => __providerHarness.request(model, { messages, tools }, { signal, sessionId }),
    sessionState: (sessionId) => __test.getSharedSession(sessionId),
    ask: (prompt, options) => __providerHarness.ask(prompt, 'read', new Map(), undefined, options),
    root: __providerHarness.root,
    activeQueryContexts: __providerHarness.activeQueryContexts,
    test: hasSessionIds ? {
      ...__test,
      setSharedSession: (state) => __test.setSharedSession(null, state),
    } : __test,
    reset,
    async dispose() {
      await reset();
      hooks.deregister();
      delete globalThis[sdkKey];
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
}
