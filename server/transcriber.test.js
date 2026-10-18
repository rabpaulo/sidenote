import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTranscriber } from './transcriber.js';

// A stand-in for `transcribe.py --serve`, written in Node so the test needs no Python.
function fakeWorker(dir, body) {
  const script = path.join(dir, 'worker.cjs');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(path.join(__dirname, 'starts'), 'x');
let buffer = '';
process.stdin.on('data', (data) => {
  buffer += data;
  let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    fs.appendFileSync(path.join(__dirname, 'files'), request.file + '\\n');
    (${body})(request, (result) => process.stdout.write(JSON.stringify({ id: request.id, ...result }) + '\\n'));
  }
});`);
  return createTranscriber({ python: () => ({ command: process.execPath, args: [] }), script });
}

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interviewai-transcriber-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const read = (dir, name) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8') : '');

test('one worker answers every request, concurrently and by id', async (t) => {
  const dir = scratch(t);
  const transcriber = fakeWorker(dir, `(request, reply) => setTimeout(() => reply({ text: request.language + ':' + require('node:fs').readFileSync(request.file, 'utf8'), language: 'pt-BR' }), request.language === 'slow' ? 80 : 5)`);
  t.after(() => transcriber.close());
  const [slow, fast] = await Promise.all([
    transcriber.transcribe(Buffer.from('a'), 'slow'),
    transcriber.transcribe(Buffer.from('b'), 'pt-BR'),
  ]);
  assert.deepEqual(slow, { text: 'slow:a', language: 'pt-BR' });
  assert.deepEqual(fast, { text: 'pt-BR:b', language: 'pt-BR' });
  assert.equal(read(dir, 'starts'), 'x', 'Python starts once, not once per chunk');
  for (const file of read(dir, 'files').trim().split('\n')) assert.equal(fs.existsSync(file), false);
});

test('a stalled worker returns an error, is replaced, and its temporary audio is removed', async (t) => {
  const dir = scratch(t);
  const transcriber = fakeWorker(dir, `(request, reply) => { if (request.language === 'ok') reply({ text: 'ok' }); }`);
  t.after(() => transcriber.close());
  const result = await transcriber.transcribe(Buffer.alloc(44), 'pt-BR', { timeoutMs: 300 });
  assert.match(result.error || '', /tempo|demorou/i);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const [stalledFile] = read(dir, 'files').trim().split('\n');
  assert.equal(fs.existsSync(stalledFile), false);
  assert.deepEqual(await transcriber.transcribe(Buffer.alloc(44), 'ok'), { text: 'ok' });
  assert.equal(read(dir, 'starts'), 'xx');
});

test('a cancelled request settles at once', async (t) => {
  const dir = scratch(t);
  const transcriber = fakeWorker(dir, `(request, reply) => setTimeout(() => reply({ text: 'late' }), 200)`);
  t.after(() => transcriber.close());
  const controller = new AbortController();
  const pending = transcriber.transcribe(Buffer.alloc(44), 'pt-BR', { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await pending, { error: 'Transcrição cancelada' });
});

test('a missing Python is reported as an error', async () => {
  const transcriber = createTranscriber({ python: () => ({ command: '/nonexistent/python3', args: [] }) });
  const result = await transcriber.transcribe(Buffer.alloc(44), 'pt-BR', { timeoutMs: 2000 });
  assert.ok(result.error);
});

// A worker that reads its --config and behaves per engine: 'google' answers at once,
// 'broken' cannot load, 'flaky' fails each request, 'slow-load' is ready after a delay.
function engineWorker(dir) {
  const script = path.join(dir, 'engines.cjs');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(process.argv[process.argv.indexOf('--config') + 1]);
fs.appendFileSync(path.join(__dirname, 'starts'), config.engine + '\\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let ready = config.engine !== 'slow-load';
if (config.engine === 'broken') {
  send({ event: 'fatal', error: 'modelo ausente', code: 'model_missing' });
  process.exit(3);
}
if (ready) send({ event: 'ready', engine: config.engine, device: 'CPU', loadMs: 1 });
else setTimeout(() => { ready = true; send({ event: 'ready', engine: config.engine, device: 'CPU', loadMs: 300 }); flush(); }, 300);
const queue = [];
function flush() {
  while (ready && queue.length) {
    const request = queue.shift();
    if (config.engine === 'flaky') send({ id: request.id, error: 'falhou', code: 'engine_error' });
    else send({ id: request.id, text: config.engine + ':' + request.language, language: 'pt-BR' });
  }
}
let buffer = '';
process.stdin.on('data', (data) => {
  buffer += data;
  let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (!request.cancel) queue.push(request);
  }
  flush();
});
process.stdin.on('end', () => process.exit(0));`);
  return script;
}

test('a local engine that cannot load is replaced by Google, reported once, until the setting changes', async (t) => {
  const dir = scratch(t);
  let engine = { engine: 'broken' };
  const events = [];
  const transcriber = createTranscriber({
    python: () => ({ command: process.execPath, args: [] }), script: engineWorker(dir),
    config: () => engine, onEvent: (event) => events.push(event),
  });
  t.after(() => transcriber.close());
  assert.deepEqual(await transcriber.transcribe(Buffer.alloc(44), 'pt-BR'), { text: 'google:pt-BR', language: 'pt-BR' });
  assert.deepEqual(await transcriber.transcribe(Buffer.alloc(44), 'en-US'), { text: 'google:en-US', language: 'pt-BR' });
  const fallbacks = events.filter((event) => event.type === 'fallback');
  assert.equal(fallbacks.length, 1, 'warned once');
  assert.equal(fallbacks[0].permanent, true);
  assert.equal(fallbacks[0].engine, 'broken');
  assert.equal(read(dir, 'starts').split('\n').filter((name) => name === 'broken').length, 1, 'the broken engine is not restarted in a loop');
  assert.equal(transcriber.info().status, 'fallback');
  assert.equal(transcriber.concurrency(), 3);

  engine = { engine: 'parakeet' };
  assert.deepEqual(await transcriber.transcribe(Buffer.alloc(44), 'pt-BR'), { text: 'parakeet:pt-BR', language: 'pt-BR' });
  assert.equal(transcriber.concurrency(), 1, 'a local engine runs one request of an utterance at a time');
  assert.equal(transcriber.info().status, 'ready');
});

test('a local engine that fails a request falls back for that request, and is left aside after repeated failures', async (t) => {
  const dir = scratch(t);
  const events = [];
  const transcriber = createTranscriber({
    python: () => ({ command: process.execPath, args: [] }), script: engineWorker(dir),
    config: () => ({ engine: 'flaky' }), onEvent: (event) => events.push(event),
  });
  t.after(() => transcriber.close());
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await transcriber.transcribe(Buffer.alloc(44), 'pt-BR'), { text: 'google:pt-BR', language: 'pt-BR' });
  }
  const fallbacks = events.filter((event) => event.type === 'fallback');
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].permanent, false);
  assert.equal(transcriber.info().status, 'fallback', 'three failures in a row leave it aside');
  transcriber.retry();
  assert.equal(transcriber.info().status, 'ready');
});

test('a model still loading is waited for instead of being taken for a stuck worker', async (t) => {
  const dir = scratch(t);
  const transcriber = createTranscriber({
    python: () => ({ command: process.execPath, args: [] }), script: engineWorker(dir),
    config: () => ({ engine: 'slow-load' }),
  });
  t.after(() => transcriber.close());
  assert.deepEqual(await transcriber.transcribe(Buffer.alloc(44), 'pt-BR', { timeoutMs: 100 }), { text: 'slow-load:pt-BR', language: 'pt-BR' });
});

test('changing the engine lets the old worker finish and starts the new one', async (t) => {
  const dir = scratch(t);
  let engine = { engine: 'parakeet' };
  const transcriber = createTranscriber({
    python: () => ({ command: process.execPath, args: [] }), script: engineWorker(dir), config: () => engine,
  });
  t.after(() => transcriber.close());
  const first = transcriber.transcribe(Buffer.alloc(44), 'pt-BR');
  engine = { engine: 'vosk' };
  const second = transcriber.transcribe(Buffer.alloc(44), 'pt-BR');
  assert.deepEqual(await first, { text: 'parakeet:pt-BR', language: 'pt-BR' });
  assert.deepEqual(await second, { text: 'vosk:pt-BR', language: 'pt-BR' });
});
