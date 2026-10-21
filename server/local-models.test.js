import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { LOCAL_PROVIDERS } from '../shared/local-providers.js';
import { checkLmstudio, checkOllama, createLocalModels, ollamaUrl, readNdjson } from './local-models.js';
import { ollamaThink, runApiAgent } from './api-session.js';

// A stand-in for Ollama on a free port; `routes` maps "METHOD /path" to a handler.
async function fakeOllama(t, routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, url: req.url, body: parsed });
      const handler = routes[`${req.method} ${req.url}`];
      if (!handler) { res.writeHead(404).end('{}'); return; }
      handler(res, parsed, requests);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = LOCAL_PROVIDERS.ollama.baseUrl;
  LOCAL_PROVIDERS.ollama.baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    LOCAL_PROVIDERS.ollama.baseUrl = previous;
    server.close();
  });
  return requests;
}

const json = (res, body, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
const ndjson = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  for (const event of events) res.write(`${JSON.stringify(event)}\n`);
  res.end();
};

function chat(options) {
  return new Promise((resolve, reject) => {
    const messages = [];
    runApiAgent({ provider: 'ollama', model: 'qwen3.5:4b', isolated: true, ...options,
      onMessage: (message) => messages.push(message), onError: reject, onClose: () => resolve(messages) });
  });
}

test('OLLAMA_HOST in any of its forms becomes a local URL', () => {
  assert.equal(ollamaUrl(''), LOCAL_PROVIDERS.ollama.baseUrl);
  assert.equal(ollamaUrl('0.0.0.0:11434'), 'http://127.0.0.1:11434');
  assert.equal(ollamaUrl('localhost'), 'http://localhost:11434');
  assert.equal(ollamaUrl('http://192.168.0.5:9000/'), 'http://192.168.0.5:9000');
});

test('newline-delimited JSON is read across chunk boundaries', async () => {
  async function* chunks() {
    const encoder = new TextEncoder();
    yield encoder.encode('{"a":1}\n{"b"');
    yield encoder.encode(':2}\n\nnot json\n{"c":3}');
  }
  const events = [];
  for await (const event of readNdjson(chunks())) events.push(event);
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test('Ollama is available with its local models; cloud models are left out', async (t) => {
  await fakeOllama(t, {
    'GET /api/tags': (res) => json(res, { models: [
      { name: 'qwen3.5:4b', size: 3_400_000_000, details: { parameter_size: '4B' } },
      { name: 'gpt-oss:120b-cloud', size: 0, remote_host: 'https://ollama.com' },
    ] }),
  });
  const entry = await checkOllama();
  assert.equal(entry.status, 'available');
  assert.deepEqual(entry.models, ['qwen3.5:4b']);
  assert.equal(entry.catalog[0].name, 'qwen3.5:4b · 3.4 GB');
});

test('a running Ollama without models asks for a download', async (t) => {
  await fakeOllama(t, { 'GET /api/tags': (res) => json(res, { models: [] }) });
  const entry = await checkOllama();
  assert.equal(entry.status, 'unavailable');
  assert.equal(entry.installed, true);
  assert.equal(entry.setup, 'local');
});

test('LM Studio that is not running is reported, never blocks the check', async () => {
  const previous = LOCAL_PROVIDERS.lmstudio.baseUrl;
  LOCAL_PROVIDERS.lmstudio.baseUrl = 'http://127.0.0.1:9/v1';
  try {
    const entry = await checkLmstudio();
    assert.equal(entry.status, 'unavailable');
    assert.equal(entry.setup, 'local');
  } finally {
    LOCAL_PROVIDERS.lmstudio.baseUrl = previous;
  }
});

test('chat streams from Ollama with reasoning off and a bigger context', async (t) => {
  const requests = await fakeOllama(t, {
    'POST /api/chat': (res) => ndjson(res, [
      { message: { role: 'assistant', content: 'Olá' }, done: false },
      { message: { role: 'assistant', content: ', tudo bem?' }, done: false },
      { message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 12, eval_count: 5 },
    ]),
  });
  const messages = await chat({ prompt: 'Oi', reasoningEffort: 'off' });
  const result = messages.find((message) => message.event === 'result').result;
  assert.equal(result.response, 'Olá, tudo bem?');
  assert.equal(result.usage.total_tokens, 17);
  const body = requests[0].body;
  assert.equal(body.think, false);
  assert.ok(body.options.num_ctx >= 8192);
  assert.equal(body.messages.at(-1).content, 'Oi');
});

test('a model without reasoning mode is retried without the setting', async (t) => {
  const requests = await fakeOllama(t, {
    'POST /api/chat': (res, body) => (body.think !== undefined
      ? json(res, { error: '"gemma" does not support thinking' }, 400)
      : ndjson(res, [{ message: { content: 'ok' }, done: true }])),
  });
  const messages = await chat({ prompt: 'Oi', reasoningEffort: 'high' });
  assert.equal(messages.find((message) => message.event === 'result').result.response, 'ok');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.think, undefined);
});

test('reasoning levels map to what each model accepts', () => {
  assert.equal(ollamaThink('qwen3.5:4b', 'off'), false);
  assert.equal(ollamaThink('qwen3.5:4b', 'medium'), true);
  assert.equal(ollamaThink('gpt-oss:20b', 'off'), 'low');
  assert.equal(ollamaThink('gpt-oss:20b', 'high'), 'high');
  assert.equal(ollamaThink('qwen3.5:4b', 'default'), undefined);
});

test('a download reports the weights layer progress and refreshes when done', async (t) => {
  await fakeOllama(t, {
    // Spaced out like a real download, so the throttled progress updates go through.
    'POST /api/pull': async (res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (const event of [
        { status: 'pulling manifest' },
        { status: 'pulling abc', digest: 'abc', total: 1000, completed: 500 },
        { status: 'pulling def', digest: 'def', total: 10, completed: 10 },
        { status: 'success' },
      ]) {
        res.write(`${JSON.stringify(event)}\n`);
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      res.end();
    },
  });
  const updates = [];
  const local = createLocalModels({ onChange: (update) => updates.push(update), scan: async () => ({ ramGb: 16, gpus: [] }), log: {} });
  await local.pull('qwen3.5:4b');
  assert.ok(updates.some((update) => update.pulls['qwen3.5:4b']?.total === 1000));
  // The small layer never shrinks the bar.
  assert.ok(!updates.some((update) => update.pulls['qwen3.5:4b']?.total === 10));
  assert.deepEqual(updates.at(-1), { pulls: {}, settled: true });
});

test('a failed download keeps its error for the screen', async (t) => {
  await fakeOllama(t, { 'POST /api/pull': (res) => json(res, { error: 'pull model manifest: file does not exist' }, 500) });
  const local = createLocalModels({ scan: async () => ({ ramGb: 16, gpus: [] }), log: {} });
  await local.pull('nao-existe:1b');
  const { pulls } = await local.status();
  assert.equal(pulls['nao-existe:1b'].status, 'error');
  assert.match(pulls['nao-existe:1b'].error, /does not exist/);
  await assert.rejects(local.pull('../etc'), /inválido/);
});

test('status rates the catalog for the scanned hardware and marks installed models', async (t) => {
  await fakeOllama(t, {
    'GET /api/tags': (res) => json(res, { models: [{ name: 'qwen3.5:4b', size: 3_400_000_000 }] }),
    'GET /api/ps': (res) => json(res, { models: [{ name: 'qwen3.5:4b', size: 4000, size_vram: 3000 }] }),
  });
  const local = createLocalModels({ scan: async () => ({ ramGb: 16, gpus: [] }), log: {} });
  const status = await local.status();
  assert.equal(status.ollama.running, true);
  assert.equal(status.ollama.models[0].gpuShare, 75);
  assert.equal(status.catalog.find((model) => model.id === 'qwen3.5:4b').installed, true);
  assert.equal(status.catalog.filter((model) => model.recommended).length, 1);
});
