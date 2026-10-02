# Claude Bridge Active Paging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make active Claude bridge tool continuations honor the context selected by Pi.

**Architecture:** Compare each tool continuation with the query's last selected history snapshot. Preserve append-only continuations, but retire a stale query and rebuild from the complete selected context after a rewrite. Use a separate replacement QueryContext so old MCP closures cannot change replacement state.

**Tech Stack:** TypeScript, Node.js 24 test runner and module hooks, Claude Agent SDK, Nix buildNpmPackage.

## Global Constraints

- The existing 128,000-token paging budget remains unchanged.
- The saved session remains unchanged.
- Append-only tool continuations keep the same SDK query.
- Late messages, errors, completion handlers, and cleanup from the old query cannot modify the replacement.
- An unrelated active query remains unchanged.
- A user abort still stops the replacement.
- The upstream source revision and dependency lock remain unchanged unless the implementation requires a dependency change.
- Genuine resident-input or protected-context overflow still produces the existing explicit error.
- Deployment to the active Home Manager profile remains a separate user-approved action.

---

## Approved spec and workspace

- Spec: `docs/specs/2026-10-02-claude-bridge-active-paging-design.md`.
- Worktree: `/home/roche/projects/pi/roche-pi/.worktrees/fix-context-paging-bridge`.
- Branch: `fix/context-paging-bridge`.
- Repository base: `8054025`.
- Approved spec commit: `8fdb94d48eae8dd31e0971660f4cf91c5070f43e`.
- Upstream bridge revision: `227f5eb4450a070dfbc083a7fe75b8b35366b941`.
- Upstream source: `/nix/store/b4mw1nqsybf664yfjgbm7di8c2wxczar-source`.
- Existing installed bridge: `/nix/store/3360m9565796lk90pn4v8vq00ryswk7v-pi-claude-bridge-0.8.0-unstable-2026-09-23/lib/node_modules/pi-claude-bridge`.

The current baseline passes 96 context-paging tests and 11 packaged bridge tests.
The full flake check also passes.
The first baseline command failed because Node cannot strip TypeScript inside `node_modules` by default.
The existing install check avoids that restriction with standalone module copies.
The provider tests below use a load hook that strips TypeScript explicitly.

## File responsibilities

The fix is one deliverable, with one test cycle and one review gate.
The source patch and its package tests belong in the same task.
No separate bridge checkout or source pin update is necessary.

| File | Responsibility |
| --- | --- |
| `nix/packages/pi-claude-bridge-active-paging.patch` | Changes to upstream history identity, transcript rendering, QueryContext rotation, and provider continuation. |
| `nix/packages/pi-claude-bridge-provider-harness.mjs` | Test-only SDK control and module loading for provider regressions. |
| `nix/packages/pi-claude-bridge-active-paging.test.mjs` | Behavioral regression cases through the real provider entry point. |
| `nix/packages/pi-claude-bridge-history-identity.test.mjs` | Same-timestamp content-rewrite regression for shared history identity. |
| `nix/packages/pi-deps.nix` | Patch application and install-check registration. |

The upstream `src/index.ts` already exceeds 2,000 lines.
Keep the new decision branch small and use its existing history and query-state modules.
Do not restructure the unrelated provider, configuration, or AskClaude code.

## Task 1: Preserve or rebuild active tool continuations correctly

**Files:**
- Create: `nix/packages/pi-claude-bridge-active-paging.patch`.
- Create: `nix/packages/pi-claude-bridge-provider-harness.mjs`.
- Create: `nix/packages/pi-claude-bridge-active-paging.test.mjs`.
- Modify: `nix/packages/pi-claude-bridge-history-identity.test.mjs`.
- Modify: `nix/packages/pi-deps.nix:65-128`.
- Patch upstream: `src/history-identity.ts`, `src/history-reconstruction.ts`, `src/query-state.ts`, `src/index.ts`.

**Interfaces:**
- Consumes: `historyStartsWith(history, keys): boolean`, `sessionHistoryKeys(history, turnStart): string[]`.
- Consumes: `planHistoryReconstruction(messages, providerId)` and `prependHistoryTranscript(transcript, promptText, promptBlocks)`.
- Consumes: `QueryContext`, `ctx()`, `extractAllToolResults(context)`, `contextForToolResults(results)`, `deliverToolResults(...)`.
- Produces: `renderHistoryTranscript(messages: readonly ReconstructionMessage[]): string` in `history-reconstruction.ts`.
- Produces: `rotateCtx(previous: QueryContext): QueryContext` in `query-state.ts`.
- Produces: `QueryContext.historyKeys: string[] | null` and `QueryContext.retireForContextRewrite: (() => void) | null`.
- Extends the private entry point to `streamClaudeAgentRequest(model, context, options?, replacementCtx?: QueryContext)`.
- Preserves the registered provider's public signature and normal request routing.

### Test value gate

These tests prove whether the provider uses the selected messages and stops stale callbacks.
Removing the history comparison, result reconstruction, or retirement guards will break them.
The tests rerun without model credits and cover reusable lifecycle behavior.
Do not add tests that assert patch text, Nix attribute spelling, or documentation text.

- [ ] **Step 1: Prepare an editable copy of the pinned source and existing patches.**

Run from the task worktree:

```sh
worktree=/home/roche/projects/pi/roche-pi/.worktrees/fix-context-paging-bridge
scratch=$(mktemp -d /tmp/claude-bridge-active-paging.XXXXXX)
cp -R /nix/store/b4mw1nqsybf664yfjgbm7di8c2wxczar-source/. "$scratch/"
chmod -R u+w "$scratch"
cd "$scratch"
patch -p1 < "$worktree/nix/packages/pi-claude-bridge-lock-integrity.patch"
patch -p1 < "$worktree/nix/packages/pi-claude-bridge-safe-history-reconstruction.patch"
patch -p1 < "$worktree/nix/packages/pi-claude-bridge-paging-history-sync.patch"
git init -q
git add .
git -c user.name='Bridge patch baseline' -c user.email='bridge-baseline@localhost' \
  commit -qm 'chore: record patched bridge baseline'
ln -s /nix/store/3360m9565796lk90pn4v8vq00ryswk7v-pi-claude-bridge-0.8.0-unstable-2026-09-23/lib/node_modules/pi-claude-bridge/node_modules \
  "$scratch/node_modules"
printf 'Bridge scratch: %s\n' "$scratch"
cd "$worktree"
```

Retain the scratch path for the commands below.
Do not edit the store or the user's bridge configuration.

- [ ] **Step 2: Add controlled provider test support without changing production behavior.**

Create `nix/packages/pi-claude-bridge-provider-harness.mjs`.
Use `registerHooks` and `stripTypeScriptTypes` from `node:module`.
Resolve relative `.js` imports to `.ts` only when the `.js` file is absent.
Strip `.ts` sources in the load hook, including files inside `node_modules`.
This removes the type-stripping restriction without installing development dependencies.

The complete loader implementation appears after the queue and SDK fixture.

The load hook appends this test-only export to `src/index.ts`:

```js
export const __providerHarness = {
  request: streamClaudeAgentRequest,
  activeQueryContexts,
  root: ctx,
};
```

The hook must not alter the provider function body.
Stub only the external SDK query and Pi's transport facade.
Keep the bridge's history, prompt, transcript, MCP, and query-state modules real.
The Pi facade must export the names imported by those modules:

```js
export const calculateCost = () => {};
export const StringEnum = (values) => ({ type: 'string', enum: values });
export const contentText = (content) => typeof content === 'string'
  ? content : (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
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
```

Implement `createAssistantMessageEventStream()` with a FIFO async iterator.
Its `push` records each event, and its `end` ends the iterator.
Its `result()` resolves from a `done` message or an `error` message, as Pi's stream does.
This facade does not simulate query selection or retirement.

Use this queue for both SDK messages and transport events:

```js
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
```

The SDK stub delegates `query` to a test-owned registry on `globalThis`.
Each controlled query records its arguments and drains the real prompt stream.
A query exposes its received prompts, SDK event queue, and close count:

```js
function controlledSdkQuery(args) {
  const events = controlledQueue();
  const prompts = [];
  const sessionId = args.options.resume ?? randomUUID();
  events.push({ type: 'system', subtype: 'init', session_id: sessionId });
  const q = {
    args,
    sessionId,
    prompts,
    closed: 0,
    emit: (message) => events.push(message),
    finish: () => events.end(),
    fail: (error) => events.end(error),
    interrupt: async () => {},
    close() { this.closed++; },
    [Symbol.asyncIterator]: () => events,
  };
  q.inputDone = (async () => {
    try {
      for await (const message of args.prompt) prompts.push(message);
    } catch {
      // Retirement and abort deliberately fail the input stream.
    }
  })();
  return q;
}
```

Do not make `close()` finish SDK events automatically.
That lets a test release a late event or error after a replacement starts.
Tests must explicitly finish their controlled queries during cleanup.

Add these imports to the harness:

```js
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
```

Store the Pi facade source above as `piFacadeSource`.
Append the following transport implementation to that facade source:

```js
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
```

Complete the harness with this loader:

```js
export function flush() { return new Promise((resolve) => setImmediate(resolve)); }

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
      if (specifier === '@anthropic-ai/claude-agent-sdk') {
        return { url: sdkUrl, shortCircuit: true };
      }
      if (specifier.startsWith('@earendil-works/pi-') || specifier === 'typebox') {
        return { url: facadeUrl, shortCircuit: true };
      }
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
      if (url === providerUrl) {
        source += '\nexport const __providerHarness = { request: streamClaudeAgentRequest, activeQueryContexts, root: ctx };\n';
      }
      return { format: 'module', source: stripTypeScriptTypes(source), shortCircuit: true };
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
  return {
    model, PROVIDER_ID, queries,
    request: (messages, signal) => __providerHarness.request(model, { messages, tools }, { signal }),
    root: __providerHarness.root,
    activeQueryContexts: __providerHarness.activeQueryContexts,
    test: __test,
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
```

Load the provider once per test file.
Use `afterEach(() => h.reset())` and `after(() => h.dispose())` from `node:test`.
This keeps module-level log paths valid throughout the suite.
Do not export test support from production code.

- [ ] **Step 3: Write the first provider regression and same-timestamp identity regression.**

Create `nix/packages/pi-claude-bridge-active-paging.test.mjs`.
Require `BRIDGE_PROVIDER_MODULE` and load it through the harness.
Use these fixtures with `PROVIDER_ID` imported from the bridge's real `convert.ts`:

```js
const user = (text, timestamp) => ({ role: 'user', content: text, timestamp });
const toolCall = (id, timestamp) => ({
  role: 'assistant', provider: PROVIDER_ID, api: 'claude-agent-sdk',
  model: 'claude-sonnet-5', stopReason: 'toolUse', timestamp,
  content: [{ type: 'toolCall', id, name: 'read', arguments: { path: 'config.ts' } }],
});
const toolResult = (id, text, timestamp) => ({
  role: 'toolResult', toolCallId: id, toolName: 'read', isError: false,
  content: [{ type: 'text', text }], timestamp,
});
const notice = (id) => user(`[Context paging notice] Evicted historyId: ${id}`, 0);

async function yieldRead(h, q, id, timestamp) {
  q.emit({ type: 'assistant', message: {
    id: `message-${id}`,
    content: [{ type: 'tool_use', id, name: 'mcp__custom-tools__read', input: { path: 'config.ts' } }],
  } });
  await flush();
  return [toolCall(id, timestamp), toolResult(id, 'LATEST_RESULT', timestamp + 1)];
}
```

The harness serves a real `read` tool schema.
The real `processAssistantMessage` must end the stream and establish result ownership.
Do not write `turnToolCallIds` or `currentPiStream` directly in the provider regression.
Assert the emitted `toolUse` result before requesting the continuation.

The first test has this body:

```js
const before = [user('EVICTED_PAYLOAD', 100), user('Inspect the current config', 200)];
const initial = h.request(before);
const oldQuery = h.queries[0];
const exchange = await yieldRead(h, oldQuery, 'call-1', 300);
assert.equal((await initial.result()).stopReason, 'toolUse');

const selected = [notice('old-turn'), before[1], ...exchange];
const continuation = h.request(selected);
await flush();
assert.equal(h.queries.length, 2, 'paging must start a replacement SDK query');
assert.ok(oldQuery.closed > 0, 'the old query must stop');
const replacement = h.queries[1];
assert.equal(replacement.args.options.resume, undefined);
const prompt = JSON.stringify(replacement.prompts);
assert.doesNotMatch(prompt, /EVICTED_PAYLOAD/);
assert.match(prompt, /Inspect the current config/);
assert.equal(prompt.split('LATEST_RESULT').length - 1, 1);
replacement.emit({ type: 'assistant', message: { id: 'answer', content: [{ type: 'text', text: 'CONTINUED' }] } });
replacement.finish();
assert.equal((await continuation.result()).content[0].text, 'CONTINUED');
```

Add this test to the existing history-identity test file:

```js
test('rewritten tool output with the same timestamp breaks history identity', () => {
  const original = [firstPrompt, firstReply, firstResult];
  const keys = sessionHistoryKeys(original, original.length - 1);
  const replacement = {
    ...firstResult,
    content: [{ type: 'text', text: 'Recover this output with load_history.' }],
  };
  assert.equal(historyStartsWith([firstPrompt, firstReply, replacement], keys), false);
});
```

- [ ] **Step 4: Run the new tests against the unmodified behavior and record RED.**

Run the provider regression with the prepared scratch source:

```sh
BRIDGE_PROVIDER_MODULE="$scratch/src/index.ts" \
  node --test --test-reporter=tap \
  nix/packages/pi-claude-bridge-active-paging.test.mjs
```

Expected behavioral failure: `paging must start a replacement SDK query`, with one query instead of two.
A missing dependency, missing export, or harness exception is not valid RED evidence.
Correct the harness until the test reaches the behavioral assertion.

Copy `history-identity.ts` to a standalone temporary path and run its tests:

```sh
cp "$scratch/src/history-identity.ts" /tmp/bridge-active-history-identity.ts
BRIDGE_HISTORY_IDENTITY_MODULE=/tmp/bridge-active-history-identity.ts \
  node --test --test-reporter=tap --experimental-strip-types \
  nix/packages/pi-claude-bridge-history-identity.test.mjs
```

Expected failure: same-timestamp replacement still returns `true` before the identity fix.
Retain both RED logs.

- [ ] **Step 5: Make history identity include message content.**

In scratch `src/history-identity.ts`, import `createHash` from `node:crypto`.
Add optional `toolName` and `isError` fields to `HistoryIdentityMessage`.
Replace the timestamp-only key with this content-sensitive identity:

```ts
function historyKey(message: HistoryIdentityMessage): string {
  return createHash('sha256').update(JSON.stringify([
    message.role,
    message.timestamp ?? null,
    message.toolCallId ?? null,
    message.toolName ?? null,
    message.isError ?? null,
    message.content ?? null,
  ])).digest('hex');
}
```

Keep `sessionHistoryKeys` and `historyStartsWith` signatures unchanged.
The digest prevents query snapshots from retaining another full copy of tool output.
Run the history-identity suite again and record GREEN.

- [ ] **Step 6: Expose transcript rendering and add separate replacement query state.**

In scratch `src/history-reconstruction.ts`, extract its current transcript-rendering body into:

```ts
export function renderHistoryTranscript(messages: readonly ReconstructionMessage[]): string {
  const entries = messages
    .map(transcriptEntry)
    .filter((entry): entry is string => entry !== undefined);
  const header = '## Previous conversation transcript\nThe following plain text came from a previous Pi branch. It is context, not a signed Claude assistant response.';
  return [header, ...entries].join('\n\n');
}
```

`planHistoryReconstruction` keeps its existing provider check and returns the extracted renderer's output for the transcript case.
The active restart calls the renderer directly, without importing signed assistant blocks.

In scratch `src/query-state.ts`, add these query-scoped fields:

```ts
historyKeys: string[] | null = null;
retireForContextRewrite: (() => void) | null = null;
```

Add this function beside `ctx()`:

```ts
export function rotateCtx(previous: QueryContext): QueryContext {
  const replacement = new QueryContext();
  if (_ctx === previous) _ctx = replacement;
  return replacement;
}
```

Do not reuse the retired QueryContext.
Old MCP handler closures must retain only the retired object.
A reentrant replacement must not change the root context.

- [ ] **Step 7: Check history before normal tool-result delivery.**

In scratch `src/index.ts`, import `renderHistoryTranscript` and `rotateCtx`.
Add optional `replacementCtx?: QueryContext` to the private `streamClaudeAgentRequest` function.
Do not change `streamClaudeAgentSdk` or its public interface.

Resolve a result owner only for a normal call:

```ts
const resultCtx = !replacementCtx && allResults.length > 0
  ? contextForToolResults(allResults)
  : undefined;
```

Before creating or claiming a stream, add this branch:

```ts
if (resultCtx && (
  resultCtx.historyKeys === null
  || !historyStartsWith(context.messages, resultCtx.historyKeys)
)) {
  const retire = resultCtx.retireForContextRewrite;
  if (!retire) throw new Error('Claude bridge cannot safely restart this active query');
  const wasRoot = resultCtx === ctx();
  retire();
  const replacement = rotateCtx(resultCtx);
  if (wasRoot) sharedSession = null;
  return streamClaudeAgentRequest(model, context, options, replacement);
}
```

Move `createAssistantMessageEventStream()` after that decision.
In the normal delivery branch, record the full current history before returning its stream:

```ts
resultCtx.historyKeys = sessionHistoryKeys(context.messages, context.messages.length - 1);
```

Exclude replacement calls from the orphan-result branch:

```ts
if (!replacementCtx && lastMsg?.role === 'toolResult') {
  // Keep the existing orphan-result body unchanged.
}
```

The recursive replacement call bypasses result delivery but uses the same normal provider setup.
It must not deliver a successful tool result to the retired MCP handler.
The replacement receives that result through its reconstructed context.

- [ ] **Step 8: Build the replacement from the entire selected active turn.**

In fresh setup, choose the context explicitly:

```ts
const isReentrant = replacementCtx ? replacementCtx !== ctx() : activeQuery;
const queryCtx = replacementCtx ?? (isReentrant ? new QueryContext() : ctx());
```

Keep existing MCP tool resolution and prompt-capture projection unchanged.
Record the query's full selected history after fresh-state initialization:

```ts
queryCtx.historyKeys = sessionHistoryKeys(context.messages, context.messages.length - 1);
```

Use this sync result for a replacement instead of `syncSharedSession`:

```ts
const syncResult: SyncResult = replacementCtx
  ? {
      sessionId: null,
      preserveSharedSession: isReentrant,
      historyTranscript: renderHistoryTranscript(context.messages),
      historyKeys: sessionHistoryKeys(context.messages, context.messages.length - 1),
    }
  : syncSharedSession(context.messages, cwd, customToolNameToSdk, cliModel);
```

This includes the current user turn and the newest tool results.
Normal `syncSharedSession` excludes the current user turn, so it cannot serve this restart path.
A replacement must never resume the retired session or rewrite its JSONL file.
A reentrant replacement must preserve the parent's shared session.

Choose the continuation prompt without duplicating retained user text:

```ts
const continuationPrompt = '[Continue the current task using the completed tool results and latest user instructions in the transcript. Do not repeat completed tool calls.]';
let promptText = replacementCtx ? continuationPrompt : extractUserPrompt(context.messages) ?? '';
let promptBlocks = replacementCtx ? null : extractUserPromptBlocks(context.messages);
```

Retain image blocks from selected user messages through the existing converter:

```ts
if (replacementCtx) {
  const images = context.messages
    .filter((message) => message.role === 'user')
    .flatMap((message) => extractUserPromptBlocks([message]) ?? [])
    .filter((block) => block.type === 'image');
  if (images.length > 0) {
    promptBlocks = [{ type: 'text', text: continuationPrompt }, ...images];
  }
}
```

Then use the existing `prependHistoryTranscript` logic.
The transcript carries user text and tool results exactly once.
The image converter carries image data without copying user text into a second prompt block.

- [ ] **Step 9: Retire stale SDK queries and guard their callbacks.**

After creating the SDK query, add `let wasRetired = false` beside `wasAborted`.
After defining `onAbort`, install this retirement function:

```ts
const retireForContextRewrite = () => {
  if (wasRetired) return;
  wasRetired = true;
  options?.signal?.removeEventListener('abort', onAbort);
  promptStream.fail(new Error('Context rewritten'));
  requestAbort();
  queryCtx.releasePendingToolCalls('Context rewritten');
  queryCtx.activeQuery = null;
  queryCtx.retireForContextRewrite = null;
  activeQueryContexts.delete(queryCtx);
};
queryCtx.retireForContextRewrite = retireForContextRewrite;
```

`requestAbort()` keeps its existing interrupt-and-close behavior.
It stops the old process before parked handlers release.
The callback affects only its captured QueryContext and SDK query.

Pass `() => wasAborted || wasRetired` to `consumeQuery`.
Add `if (wasRetired) return;` as the first action in both its `.then` and `.catch` callbacks.
These guards run before shared-session writes, error propagation, and stream finalization.
When a normal query completes, record its most recent full context identity:

```ts
recordCompletedSession(sessionId, cursor, cwd, {
  ...syncResult,
  historyKeys: queryCtx.historyKeys ?? syncResult.historyKeys,
});
```

This preserves the updated snapshot after its last tool continuation.
The existing `.finally` still settles its own prompt stream and closes its own query.
Clear `retireForContextRewrite` in final cleanup only if it still equals this query's retirement callback.

Keep the normal abort listener for the replacement.
Do not turn a context rewrite into a user-visible aborted response.

- [ ] **Step 10: Expand regression coverage with explicit lifecycle assertions.**

Use the same fixtures and real provider entry point for these cases.
Add each new case before its corresponding behavior change if another production change is necessary.

| Case | Procedure | Required assertions |
| --- | --- | --- |
| Append-only results | Continue with `before + exchange`, without a notice. | One SDK query; original context remains active; the matching handler receives the result. |
| Earlier result rewritten | Accept a first exchange, then replace its result content at the same timestamp before the next exchange. | A replacement starts; prompt contains the recovery reference, not the old payload. |
| Repeated paging | Emit a second tool call from the replacement, then change the notice and remove an older exchange. | A third query starts; each retired query closes; latest result appears once. |
| Late error | After restart, call `oldQuery.fail(new Error('STALE_ERROR'))`. | Replacement stream remains open; its answer ends that stream; no stale error reaches it. |
| Late completion | After restart, release an old SDK result and finish the old queue. | Replacement answer remains intact; the old session does not become the shared session. |
| Pending work | Add a parked handler and an unacknowledged input push to the old query before restart. | Both settle; old pending maps empty; replacement maps do not acquire old results. |
| Reentrant query | Park the root query, start a child user request, and page only the child's continuation. | Root QueryContext, SDK query, stream, handlers, and shared session remain unchanged. |
| Replacement abort | Use an AbortController, restart, abort its signal, then finish the controlled replacement SDK queue. | Replacement closes; stream returns `aborted`; retired callbacks cannot overwrite it. |
| Steering and images | Add a trailing user steer with text and an image before restart. | Latest instructions appear once; image data reaches the replacement; normal append-only steering still precedes result delivery. |

The stale-error test uses the following sequence:

```js
oldQuery.fail(new Error('STALE_ERROR'));
await flush();
assert.equal(h.root().activeQuery, replacement);
replacement.emit({ type: 'assistant', message: {
  id: 'replacement-answer', content: [{ type: 'text', text: 'SAFE_RESULT' }],
} });
replacement.finish();
const answer = await continuation.result();
assert.equal(answer.stopReason, 'stop');
assert.equal(answer.content[0].text, 'SAFE_RESULT');
assert.equal(answer.errorMessage, undefined);
```

For queued MCP work, use the real `buildMcpServers` through the existing `__test` API.
The MCP request must include `_meta['claudecode/toolUseId']`.
Do not simulate pairing by arrival order.
For handler settlement assertions, control acknowledgments with explicit promises rather than sleeps.

Run all new provider tests and the existing packaged bridge tests:

```sh
BRIDGE_PROVIDER_MODULE="$scratch/src/index.ts" \
  node --test --test-reporter=tap nix/packages/pi-claude-bridge-active-paging.test.mjs
modules=$(mktemp -d /tmp/bridge-regression-modules.XXXXXX)
cp "$scratch/src/history-reconstruction.ts" "$modules/history-reconstruction.ts"
cp "$scratch/src/request-router.ts" "$modules/request-router.ts"
cp "$scratch/src/history-identity.ts" "$modules/history-identity.ts"
BRIDGE_HISTORY_MODULE="$modules/history-reconstruction.ts" \
BRIDGE_DIRECT_COMPLETION_MODULE="$modules/request-router.ts" \
BRIDGE_HISTORY_IDENTITY_MODULE="$modules/history-identity.ts" \
  node --test --test-reporter=tap --experimental-strip-types \
  nix/packages/pi-claude-bridge-history-reconstruction.test.mjs \
  nix/packages/pi-claude-bridge-direct-completion.test.mjs \
  nix/packages/pi-claude-bridge-history-identity.test.mjs
```

Expected result: all pass, with no API call and no unresolved stream.

- [ ] **Step 11: Generate and register the package patch.**

From the scratch source, generate the patch against its patched baseline:

```sh
git -C "$scratch" diff -- src/history-identity.ts src/history-reconstruction.ts src/query-state.ts src/index.ts \
  > nix/packages/pi-claude-bridge-active-paging.patch
```

In `nix/packages/pi-deps.nix`, add:

```nix
piClaudeBridgeActivePagingPatch = ./pi-claude-bridge-active-paging.patch;
piClaudeBridgeActivePagingTest = ./pi-claude-bridge-active-paging.test.mjs;
piClaudeBridgeProviderHarness = ./pi-claude-bridge-provider-harness.mjs;
```

Append the patch after the existing paging-history patch:

```nix
patch -p1 < ${piClaudeBridgeActivePagingPatch}
```

In the existing install-check phase, copy the provider test and harness together.
Their relative import must resolve inside the Nix build directory:

```nix
mkdir -p "$TMPDIR/bridge-provider-tests"
cp ${piClaudeBridgeActivePagingTest} "$TMPDIR/bridge-provider-tests/pi-claude-bridge-active-paging.test.mjs"
cp ${piClaudeBridgeProviderHarness} "$TMPDIR/bridge-provider-tests/pi-claude-bridge-provider-harness.mjs"
BRIDGE_PROVIDER_MODULE="$out/lib/node_modules/pi-claude-bridge/src/index.ts" \
  ${pkgs.nodejs}/bin/node --test \
  "$TMPDIR/bridge-provider-tests/pi-claude-bridge-active-paging.test.mjs"
```

Keep the existing three bridge tests and CLI binary check.
Do not change `npmDepsHash`, `npmInstallFlags`, or the source revision.
The test loader supplies omitted peer facades, while real runtime dependencies remain in the packaged node_modules.

- [ ] **Step 12: Verify patch application from a fresh upstream copy.**

Create a second temporary copy of the upstream source.
Apply the lock, safe-history, paging-history, and active-paging patches in package order.
Run the provider regression suite against that fresh copy with installed runtime dependencies linked beside it.

```sh
fresh=$(mktemp -d /tmp/claude-bridge-active-paging-check.XXXXXX)
cp -R /nix/store/b4mw1nqsybf664yfjgbm7di8c2wxczar-source/. "$fresh/"
chmod -R u+w "$fresh"
for name in lock-integrity safe-history-reconstruction paging-history-sync active-paging; do
  patch -d "$fresh" -p1 < "nix/packages/pi-claude-bridge-$name.patch"
done
ln -s /nix/store/3360m9565796lk90pn4v8vq00ryswk7v-pi-claude-bridge-0.8.0-unstable-2026-09-23/lib/node_modules/pi-claude-bridge/node_modules \
  "$fresh/node_modules"
BRIDGE_PROVIDER_MODULE="$fresh/src/index.ts" \
  node --test --test-reporter=tap nix/packages/pi-claude-bridge-active-paging.test.mjs
```

Expected result: all four patches apply without rejected hunks, and the provider tests pass.

- [ ] **Step 13: Stage new package inputs and run final verification.**

Stage the new referenced files before normal git-backed flake checks:

```sh
git add nix/packages/pi-claude-bridge-active-paging.patch \
  nix/packages/pi-claude-bridge-provider-harness.mjs \
  nix/packages/pi-claude-bridge-active-paging.test.mjs \
  nix/packages/pi-claude-bridge-history-identity.test.mjs \
  nix/packages/pi-deps.nix
git diff --cached --check
node --test --test-reporter=tap --experimental-strip-types extensions/context-paging/*.test.ts
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

The explicit extension-load check and full flake check are both required.
The packaged bridge install check must run the new provider regressions.
Existing context-paging tests must still pass without budget or usage-tracker changes.
Inspect complete failure logs if any command fails.
Do not claim success from evaluation or `pi --help` alone.

- [ ] **Step 14: Review the complete deliverable and commit the fix.**

Review against every acceptance criterion in the approved spec.
Verify that the diff contains no saved-session, budget, configuration, lockfile, or source-pin changes.
If delegated execution was selected, the parent dispatches the canonical `reviewer` with fresh context.
Pass the spec, this plan, base `8fdb94d`, final head, verification evidence, and the staged diff when relevant.
Do not let a writing child launch its own reviewer.
For inline execution, perform the same focused review directly unless the user authorizes a separate reviewer.

Read the commit skill before committing.
Then commit only the verified task files:

```sh
git commit -m 'fix(claude-bridge): rebuild paged active tool queries'
```

Do not push or deploy.
Report the red-green evidence, final test counts, package checks, branch, and commit.
When the user chooses local integration, offer a squash merge into `main`, not a regular merge.

## Spec coverage map

| Approved requirement | Plan steps |
| --- | --- |
| Full content identity and same-timestamp rewrites | 3–5, 7, 10 |
| Append-only reuse | 7, 10 |
| Entire active turn and newest results | 6, 8, 10 |
| No orphaned-result response or duplicate tool execution | 7–8, 10 |
| Repeated paging | 7–10 |
| Old SDK events, errors, completion, and cleanup | 6, 9–10 |
| Pending prompt and MCP settlement | 9–10 |
| Parent and reentrant ownership | 6–10 |
| User abort and normal steering | 9–10 |
| Images and retained instructions | 8, 10 |
| Package integration and runtime extension loading | 11–13 |
| Budget, saved session, and real-overflow behavior unchanged | 13–14 |
