import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// The key store is read at import, so it points at a temporary file first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interviewai-keys-'));
process.env.INTERVIEWAI_KEYS_PATH = path.join(dir, 'api-keys.json');
delete process.env.OPENAI_API_KEY;
const { API_PROVIDERS, chatModels } = await import('../shared/api-providers.js');
const { createProviderKeys, providerKeys } = await import('./provider-keys.js');
const { runApiAgent, listApiModels, resetApiConversations } = await import('./api-session.js');

// A local stand-in for an OpenAI-compatible API that records what it receives.
async function fakeApi(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      handler(req, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = API_PROVIDERS.openai.baseUrl;
  API_PROVIDERS.openai.baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  t.after(() => {
    API_PROVIDERS.openai.baseUrl = previous;
    server.close();
  });
  return requests;
}

function streamReply(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end('data: [DONE]\n\n');
}

function turn(options) {
  return new Promise((resolve, reject) => {
    const messages = [];
    runApiAgent({ provider: 'openai', model: 'gpt-test', ...options,
      onMessage: (message) => messages.push(message), onError: reject, onClose: () => resolve(messages) });
  });
}

test('saved keys never leave the store in full and override the environment', () => {
  const file = path.join(dir, 'other.json');
  const keys = createProviderKeys({ file, env: { OPENAI_API_KEY: 'env-openai-key', GROQ_API_KEY: 'env-key-9999' } });
  assert.equal(keys.get('openai'), 'env-openai-key');
  keys.set('openai', '  saved-key-abcd  ');
  assert.equal(keys.get('openai'), 'saved-key-abcd');
  assert.deepEqual(keys.summary().openai, { configured: true, source: 'saved', hint: '…abcd' });
  assert.deepEqual(keys.summary().groq, { configured: true, source: 'env', hint: '…9999' });
  assert.equal(keys.summary().mistral.configured, false);
  assert.equal(keys.opencodeEnv().OPENAI_API_KEY, 'saved-key-abcd');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(createProviderKeys({ file, env: {} }).get('openai'), 'saved-key-abcd');
  assert.throws(() => keys.set('openai', 'has space'), /não parece válida/);
  assert.throws(() => keys.set('unknown', 'x'), /desconhecido/);
  keys.remove('openai');
  assert.equal(keys.get('openai'), 'env-openai-key');
});

test('an API provider without a key is unavailable and asks for one', async () => {
  const result = await listApiModels('openai');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.needsKey, true);
  await assert.rejects(turn({ prompt: 'oi' }), /Adicione uma API key/);
});

test('OpenAI-compatible turns stream text, keep the history and report usage', async (t) => {
  providerKeys.set('openai', 'test-openai-key');
  t.after(() => { providerKeys.remove('openai'); resetApiConversations(); });
  const requests = await fakeApi(t, (req, res) => streamReply(res, [
    { choices: [{ delta: { content: 'Olá' } }] },
    { choices: [{ delta: { content: ', Ana' } }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
  ]));

  const first = await turn({ prompt: 'Meu nome é Ana', reasoningEffort: 'high' });
  const conversationId = first[0].conversation_id;
  assert.deepEqual(first.filter((m) => m.step_update).map((m) => m.step_update.text_delta), ['Olá', ', Ana']);
  const result = first.at(-1).result;
  assert.equal(result.response, 'Olá, Ana');
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 3, cached_input_tokens: undefined, total_tokens: 15 });
  assert.equal(requests[0].headers.authorization, 'Bearer test-openai-key');
  assert.equal(requests[0].body.reasoning_effort, 'high');
  assert.equal(requests[0].body.messages[0].role, 'system');

  await turn({ prompt: 'Qual é o meu nome?', conversationId, reasoningEffort: 'default', images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }] });
  const second = requests[1].body;
  assert.equal(second.reasoning_effort, undefined);
  assert.deepEqual(second.messages.slice(1, 3), [
    { role: 'user', content: 'Meu nome é Ana' },
    { role: 'assistant', content: 'Olá, Ana' },
  ]);
  assert.equal(second.messages[3].content[0].type, 'image_url');
  assert.equal(second.messages[3].content[1].text, 'Qual é o meu nome?');

  // Isolated turns (the summary) neither read nor extend the conversation.
  await turn({ prompt: 'Resuma', conversationId, isolated: true });
  assert.equal(requests[2].body.messages.length, 2);
});

test('a rejected key reports an invalid key and blocks the provider', async (t) => {
  providerKeys.set('openai', 'wrong-openai-key');
  t.after(() => providerKeys.remove('openai'));
  await fakeApi(t, (req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
  });
  await assert.rejects(turn({ prompt: 'oi' }), /API key inválida.*Incorrect API key/);
  const result = await listApiModels('openai');
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /API key inválida/);
});

test('model listing keeps chat models, newest first, preferred ones on top', async (t) => {
  providerKeys.set('openai', 'test-openai-key');
  t.after(() => providerKeys.remove('openai'));
  await fakeApi(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [
      { id: 'gpt-old', created: 1 }, { id: 'text-embedding-3-large', created: 5 },
      { id: 'gpt-new', created: 9 }, { id: 'gpt-5.5', created: 3 }, { id: 'gpt-4o-realtime-preview', created: 8 },
    ] }));
  });
  const { models } = await listApiModels('openai');
  assert.deepEqual(chatModels('openai', models).map((model) => model.id), ['gpt-5.5', 'gpt-new', 'gpt-old']);
});

test('an aborted turn reports nothing', async (t) => {
  providerKeys.set('openai', 'test-openai-key');
  t.after(() => providerKeys.remove('openai'));
  await fakeApi(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'parcial' } }] })}\n\n`);
  });
  const events = [];
  const handle = runApiAgent({ provider: 'openai', model: 'gpt-test', prompt: 'oi',
    onMessage: (message) => {
      events.push(message.event);
      if (message.step_update) handle.kill();
    },
    onError: () => events.push('error'), onClose: () => events.push('close') });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(events, ['session_started', 'step_update']);
});
