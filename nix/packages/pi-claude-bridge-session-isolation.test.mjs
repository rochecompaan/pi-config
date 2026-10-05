import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { connectMcpToolClient, loadProvider, flush } from './pi-claude-bridge-provider-harness.mjs';

const h = await loadProvider(process.env.BRIDGE_PROVIDER_MODULE);
afterEach(() => h.reset());
after(() => h.dispose());
// Older sources have one anonymous mirror; their paging suite covers that contract.
const sessionTest = (name, fn) => test(name, { skip: !h.hasSessionIds }, fn);
const user = (text, timestamp) => ({ role: 'user', content: text, timestamp });
const answer = (text, timestamp) => ({
  role: 'assistant', provider: h.PROVIDER_ID, api: 'claude-agent-sdk',
  model: h.model.id, stopReason: 'stop', timestamp,
  content: [{ type: 'text', text }],
});

async function complete(messages, sessionId) {
  const stream = h.request(messages, undefined, sessionId);
  const query = h.queries.at(-1);
  query.finish();
  await stream.result();
  await flush();
  return query;
}

async function park(messages, sessionId, id, timestamp, signal) {
  const stream = h.request(messages, signal, sessionId);
  const query = h.queries.at(-1);
  query.emit({ type: 'assistant', message: {
    id: `message-${id}`,
    content: [{ type: 'tool_use', id, name: 'mcp__custom-tools__read', input: { path: 'config.ts' } }],
  } });
  await flush();
  assert.equal((await stream.result()).stopReason, 'toolUse');
  const exchange = [{
    ...answer('', timestamp), stopReason: 'toolUse',
    content: [{ type: 'toolCall', id, name: 'read', arguments: { path: 'config.ts' } }],
  }, {
    role: 'toolResult', toolCallId: id, toolName: 'read', isError: false,
    timestamp: timestamp + 1, content: [{ type: 'text', text: `${id}-RESULT` }],
  }];
  return { query, exchange };
}

sessionTest('idle paging replaces only its own mirror and never replays signed Claude history', async () => {
  const parentBefore = [user('PARENT_PAYLOAD', 100)];
  const parent = await complete(parentBefore, 'parent');
  const childBefore = [user('EVICTED_CHILD_PAYLOAD', 200)];
  const child = await complete(childBefore, 'child');
  const selected = [user('[Context paging notice] Child history removed', 0),
    answer('RETAINED_CHILD_ANSWER', 300), user('Continue child', 400)];
  const replacement = await complete(selected, 'child');
  assert.equal(replacement.args.options.resume, undefined);
  assert.notEqual(replacement.sessionId, child.sessionId);
  const prompt = JSON.stringify(replacement.prompts);
  assert.match(prompt, /RETAINED_CHILD_ANSWER/);
  assert.doesNotMatch(prompt, /EVICTED_CHILD_PAYLOAD|PARENT_PAYLOAD/);
  assert.equal(h.sessionState('parent').sessionId, parent.sessionId);
  assert.equal(h.sessionState('child').sessionId, replacement.sessionId);
  const resumedParent = await complete([...parentBefore, answer('Parent answer', 150), user('Next parent', 500)], 'parent');
  assert.equal(resumedParent.args.options.resume, parent.sessionId);
});

sessionTest('AskClaude synchronizes only its calling session and uses ephemeral transcript fallback', async () => {
  const parent = await complete([user('PARENT_PAYLOAD', 100)], 'parent');
  await complete([user('EVICTED_CHILD_PAYLOAD', 200)], 'child');
  const result = h.ask('Inspect the retained answer', {
    piSessionId: 'child', appendSkills: false,
    context: [user('[Context paging notice] Child history removed', 0), answer('RETAINED_CHILD_ANSWER', 300)],
  });
  const query = h.queries.at(-1);
  assert.equal(query.args.options.resume, undefined);
  assert.equal(query.args.options.persistSession, false);
  assert.match(query.args.prompt, /RETAINED_CHILD_ANSWER/);
  assert.doesNotMatch(query.args.prompt, /EVICTED_CHILD_PAYLOAD|PARENT_PAYLOAD/);
  query.emit({ type: 'result', subtype: 'success', result: 'SAFE_ANSWER' });
  query.finish();
  assert.equal((await result).responseText, 'SAFE_ANSWER');
  assert.equal(h.sessionState('parent').sessionId, parent.sessionId);
});

sessionTest('active child paging leaves the parent query and completed mirror intact', async () => {
  const parentBefore = [user('Parent task', 100)];
  const parentMirror = await complete(parentBefore, 'parent');
  const parentTurn = [...parentBefore, answer('Parent answer', 150), user('Read parent config', 200)];
  const { query: parentQuery } = await park(parentTurn, 'parent', 'parent-call', 250);
  const parentContext = h.root();
  const callTool = await connectMcpToolClient(Object.values(parentQuery.args.options.mcpServers)[0]);
  const parentHandler = callTool('read', 'parent-call');
  await flush();
  const childBefore = [user('EVICTED_CHILD_PAYLOAD', 300), user('Child task', 400)];
  const childController = new AbortController();
  const { query: childQuery, exchange } = await park(childBefore, 'child', 'child-call', 450, childController.signal);
  const continuation = h.request([user('[Context paging notice] Child history removed', 0), childBefore[1], ...exchange], undefined, 'child');
  await flush();
  assert.equal(h.queries.length, 4, 'paging must start a replacement child SDK query');
  const replacement = h.queries.at(-1);
  assert.equal(h.root(), parentContext);
  assert.equal(parentContext.activeQuery, parentQuery);
  assert.equal(parentContext.pendingToolCalls.size, 1);
  assert.equal(h.sessionState('parent').sessionId, parentMirror.sessionId);
  assert.ok(childQuery.closed > 0);
  assert.equal(replacement.args.options.resume, undefined);
  const prompt = JSON.stringify(replacement.prompts);
  assert.doesNotMatch(prompt, /EVICTED_CHILD_PAYLOAD|PARENT_PAYLOAD/);
  assert.equal(prompt.split('child-call-RESULT').length - 1, 1);
  replacement.emit({ type: 'assistant', message: { id: 'child-answer', content: [{ type: 'text', text: 'SAFE_CHILD' }] } });
  replacement.finish();
  assert.equal((await continuation.result()).content[0].text, 'SAFE_CHILD');
  await flush();
  assert.equal(h.sessionState('child').sessionId, replacement.sessionId);
  assert.equal(h.sessionState('parent').sessionId, parentMirror.sessionId);
  const childMirror = h.sessionState('child');
  childController.abort();
  await flush();
  assert.deepEqual(h.sessionState('child'), childMirror, 'a retired query abort must not dirty its replacement mirror');
  childQuery.fail(new Error('STALE_CHILD_ERROR'));
  await flush();
  assert.equal(h.sessionState('child').sessionId, replacement.sessionId);
  assert.equal(parentContext.activeQuery, parentQuery);
  parentQuery.finish();
  await parentHandler;
});

sessionTest('active parent paging leaves a sibling child query alive', async () => {
  const parentBefore = [user('EVICTED_PARENT_PAYLOAD', 100), user('Parent task', 200)];
  const { query: parentQuery, exchange: parentExchange } = await park(parentBefore, 'parent', 'parent-call', 250);
  const { query: childQuery } = await park([user('Child task', 300)], 'child', 'child-call', 350);
  const childContext = [...h.activeQueryContexts].find((c) => c.activeQuery === childQuery);
  const continuation = h.request([user('[Context paging notice] Parent history removed', 0), parentBefore[1], ...parentExchange], undefined, 'parent');
  await flush();
  assert.equal(h.queries.length, 3, 'paging must start a replacement parent SDK query');
  const replacement = h.queries.at(-1);
  assert.ok(parentQuery.closed > 0);
  assert.equal(childQuery.closed, 0);
  assert.equal(childContext.activeQuery, childQuery);
  assert.ok(h.activeQueryContexts.has(childContext));
  assert.equal(replacement.args.options.resume, undefined);
  replacement.finish();
  await continuation.result();
  await flush();
  const parentSessionId = h.sessionState('parent').sessionId;
  childQuery.finish();
  await flush();
  assert.equal(h.sessionState('parent').sessionId, parentSessionId);
  assert.equal(h.sessionState('child').sessionId, childQuery.sessionId);
});
