import assert from 'node:assert/strict';
import test from 'node:test';

import { IntelligenceGenerationError, generationDigest, streamGeneration, supportsGeneration, toolName, type GenerationConnection } from '../src/index.js';
import { startStreamingModel } from './support/streaming-model.js';

const SECRET = 'sk-test-0123456789abcdefghij';

async function model() {
  const server = await startStreamingModel();
  const connection = (extra: Partial<GenerationConnection> = {}): GenerationConnection => ({ provider: 'scripted', model: 'scripted-1', endpoint: `${server.url}/v1`, credential: SECRET, ...extra });
  return { server, connection };
}

test('OpenAI protocol: text streams to the caller with usage, and the credential is sent as a bearer token', async (t) => {
  const { server, connection } = await model();
  t.after(() => server.close());
  server.scripts.push({ text: ['Hel', 'lo'], usage: { input: 5, output: 2 } });
  const deltas: string[] = [];
  const result = await streamGeneration('openai-compatible', connection(), { messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }], maxTokens: 50, temperature: 0, onDelta: (d) => deltas.push(d) });
  assert.deepEqual(result, { text: 'Hello', toolCalls: [], finish: 'stop', usage: { inputTokens: 5, outputTokens: 2 } });
  assert.deepEqual(deltas, ['Hel', 'lo']);
  const [request] = server.requests;
  assert.equal(request!.path, '/v1/chat/completions');
  assert.equal(request!.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(request!.body.model, 'scripted-1');
  assert.equal(request!.body.max_tokens, 50);
  assert.equal(request!.body.temperature, 0);
  assert.deepEqual(request!.body.messages, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }]);
});

test('OpenAI protocol: tool calls come back as capability names with parsed input, and tool results go back by id', async (t) => {
  const { server, connection } = await model();
  t.after(() => server.close());
  server.scripts.push({ toolCalls: [{ id: 'call_1', name: 'notes_add', args: '{"text":"buy milk"}' }] });
  const result = await streamGeneration('openai', connection(), {
    messages: [{ role: 'user', content: 'Add a note' }],
    tools: [{ name: 'notes.add', description: 'Add a note', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
  });
  assert.equal(result.finish, 'tool_calls');
  assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'notes.add', input: { text: 'buy milk' } }]);
  assert.equal(server.requests[0]!.body.tools[0].function.name, 'notes_add');

  server.scripts.push({ text: ['Done'] });
  await streamGeneration('openai', connection(), {
    messages: [
      { role: 'user', content: 'Add a note' },
      { role: 'assistant', content: '', toolCalls: result.toolCalls },
      { role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' },
    ],
  });
  const sent = server.requests[1]!.body.messages;
  assert.equal(sent[1].tool_calls[0].function.name, 'notes_add');
  assert.deepEqual(sent[2], { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' });
});

test('Anthropic protocol: system prompt, text and tool use, with the key in x-api-key', async (t) => {
  const { server, connection } = await model();
  t.after(() => server.close());
  server.scripts.push({ text: ['Sure'], toolCalls: [{ id: 'toolu_1', name: 'notes_add', args: '{"text":"x"}' }], usage: { input: 9, output: 4 } });
  const result = await streamGeneration('anthropic', connection(), { messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Add x' }], tools: [{ name: 'notes.add', inputSchema: { type: 'object' } }] });
  assert.deepEqual(result, { text: 'Sure', toolCalls: [{ id: 'toolu_1', name: 'notes.add', input: { text: 'x' } }], finish: 'tool_calls', usage: { inputTokens: 9, outputTokens: 4 } });
  const [request] = server.requests;
  assert.equal(request!.path, '/v1/messages');
  assert.equal(request!.headers['x-api-key'], SECRET);
  assert.equal(request!.body.system, 'Be brief.');
  assert.deepEqual(request!.body.messages, [{ role: 'user', content: 'Add x' }]);
});

test('a refused credential is an error that never contains the credential', async (t) => {
  const { server, connection } = await model();
  t.after(() => server.close());
  server.scripts.push({ status: 401 }, { status: 500 });
  await assert.rejects(streamGeneration('openai', connection(), { messages: [{ role: 'user', content: 'Hi' }] }), (error: unknown) => {
    assert.ok(error instanceof IntelligenceGenerationError);
    assert.equal(error.problem, 'credential_refused');
    assert.equal(error.details.status, 401);
    assert.ok(!error.message.includes(SECRET));
    return true;
  });
  await assert.rejects(streamGeneration('openai', connection(), { messages: [{ role: 'user', content: 'Hi' }] }), (error: unknown) => {
    assert.ok(error instanceof IntelligenceGenerationError);
    assert.equal(error.problem, 'provider_error');
    assert.ok(!error.message.includes(SECRET), error.message);
    assert.ok(error.message.includes('[redacted]'));
    return true;
  });
});

test('cancelling returns the text so far with finish "cancelled", and the provider request is aborted', async (t) => {
  const { server, connection } = await model();
  t.after(() => server.close());
  server.scripts.push({ text: ['Partial ', 'never'], hangAfter: 1 });
  const controller = new AbortController();
  const result = await streamGeneration('openai', connection(), { messages: [{ role: 'user', content: 'Hi' }], signal: controller.signal, onDelta: () => controller.abort() });
  assert.deepEqual(result, { text: 'Partial ', toolCalls: [], finish: 'cancelled', usage: { inputTokens: null, outputTokens: null } });
  for (let i = 0; i < 50 && server.closed === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(server.closed, 1);
});

test('a timeout and a dropped connection are errors that keep the partial text', async (t) => {
  const { server, connection } = await model();
  t.after(() => server.close());
  server.scripts.push({ text: ['Slow ', 'never'], hangAfter: 1 }, { text: ['Cut ', 'off'], dropAfter: 1 });
  await assert.rejects(streamGeneration('openai', connection({ timeoutMs: 200 }), { messages: [{ role: 'user', content: 'Hi' }] }), (error: unknown) => {
    assert.ok(error instanceof IntelligenceGenerationError);
    assert.equal(error.problem, 'timeout');
    assert.equal(error.partialText, 'Slow ');
    return true;
  });
  await assert.rejects(streamGeneration('openai', connection(), { messages: [{ role: 'user', content: 'Hi' }] }), (error: unknown) => {
    assert.ok(error instanceof IntelligenceGenerationError);
    assert.equal(error.problem, 'unavailable');
    assert.equal(error.partialText, 'Cut ');
    return true;
  });
});

test('an unreachable endpoint, an unknown protocol and an unusable tool name are explicit errors', async () => {
  await assert.rejects(streamGeneration('openai', { provider: 'nowhere', model: 'm', endpoint: 'http://127.0.0.1:9/v1', credential: SECRET }, { messages: [{ role: 'user', content: 'Hi' }] }), { problem: 'unavailable' });
  await assert.rejects(streamGeneration('gopher', { provider: 'p', model: 'm', endpoint: 'http://127.0.0.1:9' }, { messages: [] }), { problem: 'unknown_protocol' });
  assert.throws(() => toolName('Not A Capability'), { problem: 'unsupported' });
  assert.equal(supportsGeneration('anthropic'), true);
  assert.equal(supportsGeneration('gopher'), false);
});

test('the input digest identifies messages and tool names, not tool schemas', () => {
  const messages = [{ role: 'user' as const, content: 'Hi' }];
  const a = generationDigest({ messages, tools: [{ name: 'notes.add', inputSchema: { type: 'object' } }] });
  const b = generationDigest({ messages, tools: [{ name: 'notes.add', inputSchema: { type: 'object', properties: {} } }] });
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(a, generationDigest({ messages: [{ role: 'user', content: 'Hello' }] }));
});
