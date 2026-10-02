import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { connectMcpToolClient, loadProvider, flush } from './pi-claude-bridge-provider-harness.mjs';

const modulePath = process.env.BRIDGE_PROVIDER_MODULE;
if (!modulePath) throw new Error('BRIDGE_PROVIDER_MODULE is required');
const h = await loadProvider(modulePath);
afterEach(() => h.reset());
after(() => h.dispose());

const user = (text, timestamp) => ({ role: 'user', content: text, timestamp });
const toolCall = (id, timestamp) => ({
  role: 'assistant', provider: h.PROVIDER_ID, api: 'claude-agent-sdk',
  model: 'claude-sonnet-5', stopReason: 'toolUse', timestamp,
  content: [{ type: 'toolCall', id, name: 'read', arguments: { path: 'config.ts' } }],
});
const toolResult = (id, text, timestamp) => ({
  role: 'toolResult', toolCallId: id, toolName: 'read', isError: false,
  content: [{ type: 'text', text }], timestamp,
});
const notice = (id) => user(`[Context paging notice] Evicted historyId: ${id}`, 0);

async function yieldRead(q, id, timestamp, text = 'LATEST_RESULT') {
  q.emit({ type: 'assistant', message: {
    id: `message-${id}`,
    content: [{ type: 'tool_use', id, name: 'mcp__custom-tools__read', input: { path: 'config.ts' } }],
  } });
  await flush();
  return [toolCall(id, timestamp), toolResult(id, text, timestamp + 1)];
}

async function startRead(before, id = 'call-1', timestamp = 300) {
  const initial = h.request(before);
  const query = h.queries[0];
  const exchange = await yieldRead(query, id, timestamp);
  assert.equal((await initial.result()).stopReason, 'toolUse');
  return { initial, query, exchange };
}

async function callToolFor(query) {
  const servers = Object.values(query.args.options.mcpServers ?? {});
  assert.equal(servers.length, 1, 'provider must expose its real MCP server');
  return connectMcpToolClient(servers[0]);
}

function queuedUser(text) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  };
}

test('paging rebuilds an active tool continuation from selected history', async () => {
  const before = [user('EVICTED_PAYLOAD', 100), user('Inspect the current config', 200)];
  const { query: oldQuery, exchange } = await startRead(before);
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
});

test('append-only tool results keep the active SDK query', async () => {
  const before = [user('Inspect config', 100)];
  const { query, exchange } = await startRead(before);
  const callTool = await callToolFor(query);
  const parkedHandler = callTool('read', 'call-1');
  await flush();
  const continuation = h.request([...before, ...exchange]);
  await flush();
  assert.equal(h.queries.length, 1);
  assert.equal(h.root().activeQuery, query);
  assert.equal((await parkedHandler).result.content[0].text, 'LATEST_RESULT');
  query.emit({ type: 'assistant', message: { id: 'answer', content: [{ type: 'text', text: 'APPENDED' }] } });
  query.finish();
  assert.equal((await continuation.result()).content[0].text, 'APPENDED');
});

test('same-timestamp rewritten result rebuilds rather than delivering stale output', async () => {
  const before = [user('Inspect config', 100)];
  const initial = h.request(before);
  const query = h.queries[0];
  const firstExchange = await yieldRead(query, 'call-1', 300, 'ORIGINAL_RESULT');
  assert.equal((await initial.result()).stopReason, 'toolUse');
  const firstContinuation = h.request([...before, ...firstExchange]);
  await flush();
  const secondExchange = await yieldRead(query, 'call-2', 400);
  assert.equal((await firstContinuation.result()).stopReason, 'toolUse');
  const rewritten = { ...firstExchange[1], content: [{ type: 'text', text: 'Recover this output with load_history.' }] };
  h.request([...before, firstExchange[0], rewritten, ...secondExchange]);
  await flush();
  assert.equal(h.queries.length, 2);
  assert.match(JSON.stringify(h.queries[1].prompts), /Recover this output with load_history/);
  assert.doesNotMatch(JSON.stringify(h.queries[1].prompts), /ORIGINAL_RESULT/);
});

test('repeated paging retires each active query and keeps the latest result once', async () => {
  const before = [user('EVICTED_PAYLOAD', 100), user('Inspect config', 200)];
  const { query: first, exchange: firstExchange } = await startRead(before);
  const firstContinuation = h.request([notice('first'), before[1], ...firstExchange]);
  await flush();
  const second = h.queries[1];
  const secondExchange = await yieldRead(second, 'call-2', 400, 'NEWEST_RESULT');
  assert.equal((await firstContinuation.result()).stopReason, 'toolUse');
  h.request([notice('second'), before[1], ...secondExchange]);
  await flush();
  assert.equal(h.queries.length, 3);
  assert.ok(first.closed > 0);
  assert.ok(second.closed > 0);
  assert.equal(JSON.stringify(h.queries[2].prompts).split('NEWEST_RESULT').length - 1, 1);
});

test('replacement abort ends its stream without reviving the retired query', async () => {
  const before = [user('EVICTED_PAYLOAD', 100), user('Inspect config', 200)];
  const { query: oldQuery, exchange } = await startRead(before);
  const controller = new AbortController();
  const continuation = h.request([notice('old'), before[1], ...exchange], controller.signal);
  await flush();
  const replacement = h.queries[1];
  controller.abort();
  replacement.finish();
  const result = await continuation.result();
  assert.equal(result.stopReason, 'aborted');
  assert.ok(replacement.closed > 0);
  assert.ok(oldQuery.closed > 0);
});

test('late retired query error cannot corrupt replacement stream', async () => {
  const before = [user('EVICTED_PAYLOAD', 100), user('Inspect config', 200)];
  const { query: oldQuery, exchange } = await startRead(before);
  const continuation = h.request([notice('old'), before[1], ...exchange]);
  await flush();
  const replacement = h.queries[1];
  oldQuery.fail(new Error('STALE_ERROR'));
  await flush();
  assert.equal(h.root().activeQuery, replacement);
  replacement.emit({ type: 'assistant', message: { id: 'replacement-answer', content: [{ type: 'text', text: 'SAFE_RESULT' }] } });
  replacement.finish();
  const answer = await continuation.result();
  assert.equal(answer.stopReason, 'stop');
  assert.equal(answer.content[0].text, 'SAFE_RESULT');
  assert.equal(answer.errorMessage, undefined);
});

test('late completion from a retired query cannot replace the new shared session', async () => {
  const before = [user('EVICTED_PAYLOAD', 100), user('Inspect config', 200)];
  const { query: oldQuery, exchange } = await startRead(before);
  const continuation = h.request([notice('old'), before[1], ...exchange]);
  await flush();
  assert.equal(h.queries.length, 2, 'paging must start a replacement SDK query');
  const replacement = h.queries[1];
  oldQuery.emit({ type: 'result', subtype: 'success', result: 'STALE_COMPLETION' });
  oldQuery.finish();
  await flush();
  replacement.emit({ type: 'assistant', message: { id: 'replacement-answer', content: [{ type: 'text', text: 'REPLACEMENT_RESULT' }] } });
  replacement.finish();
  assert.equal((await continuation.result()).content[0].text, 'REPLACEMENT_RESULT');
  await flush();
  assert.equal(h.test.getSharedSession().sessionId, replacement.sessionId);
  assert.notEqual(h.test.getSharedSession().sessionId, oldQuery.sessionId);
});

test('context rewrite settles parked MCP work and an unacknowledged prompt push', async () => {
  const before = [user('EVICTED_PAYLOAD', 100), user('Inspect config', 200)];
  const { query: oldQuery, exchange } = await startRead(before);
  const oldContext = h.root();
  const callTool = await callToolFor(oldQuery);
  const parkedHandler = callTool('read', 'call-1');
  await flush();
  assert.equal(oldContext.pendingToolCalls.size, 1);
  oldQuery.pauseInput();
  const pendingPush = oldContext.promptStream.push(queuedUser('PARKED_INPUT'));
  const pendingPushError = pendingPush.then(
    () => assert.fail('context rewrite must reject an unacknowledged input push'),
    (error) => error,
  );
  await flush();
  const continuation = h.request([notice('old'), before[1], ...exchange]);
  await flush();
  const replacement = h.queries[1];
  assert.equal((await parkedHandler).result.content[0].text, 'Context rewritten');
  assert.match((await pendingPushError).message, /Context rewritten/);
  assert.equal(oldContext.pendingToolCalls.size, 0);
  assert.equal(oldContext.pendingResults.size, 0);
  assert.equal(h.root().activeQuery, replacement);
  assert.equal(h.root().pendingToolCalls.size, 0);
  assert.equal(h.root().pendingResults.size, 0);
  replacement.finish();
  await continuation.result();
});

test('paging a reentrant child leaves the parent context and session alone', async () => {
  const rootBefore = [user('Root task', 100)];
  const rootInitial = h.request(rootBefore);
  const rootQuery = h.queries[0];
  await yieldRead(rootQuery, 'root-call', 150);
  assert.equal((await rootInitial.result()).stopReason, 'toolUse');
  const rootContext = h.root();
  const rootCallTool = await callToolFor(rootQuery);
  const rootHandler = rootCallTool('read', 'root-call');
  await flush();
  assert.equal(rootContext.pendingToolCalls.size, 1);
  const shared = { sessionId: 'root-session', cursor: 1, cwd: process.cwd(), historyKeys: [] };
  h.test.setSharedSession(shared);

  const childBefore = [user('Child task', 200)];
  const childInitial = h.request(childBefore);
  const childQuery = h.queries[1];
  const childExchange = await yieldRead(childQuery, 'child-call', 250);
  assert.equal((await childInitial.result()).stopReason, 'toolUse');
  const childContinuation = h.request([notice('child-page'), childBefore[0], ...childExchange]);
  await flush();
  const childReplacement = h.queries[2];
  assert.equal(h.root(), rootContext);
  assert.equal(rootContext.activeQuery, rootQuery);
  assert.equal(rootContext.pendingToolCalls.size, 1);
  assert.equal(h.test.getSharedSession(), shared);
  assert.ok(childQuery.closed > 0);
  childReplacement.finish();
  rootQuery.finish();
  await rootHandler;
  await childContinuation.result();
});

test('append-only steering reaches Claude before its parked tool result', async () => {
  const before = [user('Inspect config', 100)];
  const { query, exchange } = await startRead(before);
  const callTool = await callToolFor(query);
  const parkedHandler = callTool('read', 'call-1');
  await flush();
  const continuation = h.request([...before, ...exchange, user('STEER_FIRST', 400)]);
  const response = await parkedHandler;
  assert.equal(response.result.content[0].text, 'LATEST_RESULT');
  assert.equal(h.queries.length, 1);
  const steerPrompt = query.prompts.find((message) => message.priority === 'next');
  assert.match(JSON.stringify(steerPrompt), /STEER_FIRST/);
  query.emit({ type: 'assistant', message: { id: 'answer', content: [{ type: 'text', text: 'STEERED' }] } });
  query.finish();
  assert.equal((await continuation.result()).content[0].text, 'STEERED');
});

test('replacement carries a trailing steer once and preserves its image', async () => {
  const before = [user('EVICTED_PAYLOAD', 100), user('Inspect config', 200)];
  const { query: oldQuery, exchange } = await startRead(before);
  const steer = {
    role: 'user', timestamp: 500,
    content: [
      { type: 'text', text: 'LATEST_INSTRUCTION' },
      { type: 'image', data: 'BASE64_IMAGE', mimeType: 'image/png' },
    ],
  };
  const continuation = h.request([notice('old'), before[1], ...exchange, steer]);
  await flush();
  assert.equal(h.queries.length, 2, 'paging must start a replacement SDK query');
  const replacement = h.queries[1];
  const prompt = JSON.stringify(replacement.prompts);
  assert.equal(prompt.split('LATEST_INSTRUCTION').length - 1, 1);
  assert.equal(prompt.split('BASE64_IMAGE').length - 1, 1);
  assert.ok(oldQuery.closed > 0);
  replacement.emit({ type: 'assistant', message: { id: 'answer', content: [{ type: 'text', text: 'IMAGE_SAFE' }] } });
  replacement.finish();
  assert.equal((await continuation.result()).content[0].text, 'IMAGE_SAFE');
});
