import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmChunker, StreamingTranscription, mergeTranscript } from './streaming-transcription.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('pause flushing preserves spoken samples and reports short overlaps accurately', () => {
  const parts = [];
  const chunker = new PcmChunker((part) => parts.push(part));
  const first = Uint8Array.from({ length: 22400 }, (_, i) => i % 251);
  const next = Uint8Array.from({ length: 128000 }, (_, i) => (i + 17) % 251);
  chunker.push(first);
  chunker.push(new Uint8Array(9600), false);
  assert.equal(chunker.flushPending(9600), true);
  assert.equal(chunker.flushPending(), false, 'processed context is not sent again');
  chunker.push(next);
  chunker.finish();
  assert.equal(parts[1].overlapBytes, first.length);
  const restored = Buffer.concat(parts.map((part) => Buffer.from(part.wavBuffer.subarray(44 + part.overlapBytes))));
  assert.deepEqual(restored, Buffer.concat([Buffer.from(first), Buffer.from(next)]));
});

test('WAV windows cover all samples with overlap, including the final tail', () => {
  const parts = [];
  const chunker = new PcmChunker((part) => parts.push(part));
  const pcm = new Uint8Array(16000 * 2 * 7);
  for (let i = 0; i < pcm.length; i++) pcm[i] = i % 251;
  for (let i = 0; i < pcm.length; i += 1600) chunker.push(pcm.slice(i, i + 1600));
  assert.equal(parts.length, 2);
  assert.equal(parts[0].final, false);
  chunker.finish();
  const audio = parts.map((part) => part.wavBuffer.slice(44));
  assert.equal(audio[0].length, 96000);
  assert.equal(audio[2].length, 83200);
  const restored = new Uint8Array(pcm.length);
  restored.set(audio[0]);
  restored.set(audio[1].slice(25600), audio[0].length);
  restored.set(audio[2].slice(25600), audio[0].length + audio[1].length - 25600);
  assert.deepEqual(restored, pcm);
  const header = new DataView(parts[0].wavBuffer.buffer);
  assert.equal(header.getUint32(24, true), 16000);
  assert.equal(header.getUint16(22, true), 1);
  assert.equal(header.getUint32(40, true), audio[0].length);
});

test('ending exactly on a processed boundary needs no extra recognition request', () => {
  const parts = [];
  const chunker = new PcmChunker((part) => parts.push(part));
  chunker.push(new Uint8Array(96000));
  chunker.push(new Uint8Array(32000), false);
  chunker.finish(32000);
  assert.equal(parts.length, 2);
  assert.equal(parts[1].final, true);
  assert.equal(parts[1].wavBuffer, null);
});

test('overlap handles punctuation and case while preserving repetitions inside a phrase', () => {
  assert.equal(mergeTranscript('Como resolvo esse problema?', 'ESSE problema no servidor?'), 'Como resolvo esse problema? no servidor?');
  assert.equal(mergeTranscript('Preciso testar', 'testar de novo de novo'), 'Preciso testar de novo de novo');
  assert.equal(mergeTranscript('Primeira frase.', 'Segunda frase.'), 'Primeira frase. Segunda frase.');
});

test('partial text arrives before finish, requests stay sequential and the agent gets one final', async () => {
  const requests = [];
  const partials = [];
  const finals = [];
  const session = new StreamingTranscription({
    transcribe: () => new Promise((resolve) => requests.push(resolve)),
    onPartial: (text) => partials.push(text), onFinal: (text) => finals.push(text),
  });
  session.push({ sequence: 0, wavBuffer: new Uint8Array(44) });
  session.push({ sequence: 1, wavBuffer: new Uint8Array(44), final: true });
  assert.equal(requests.length, 1);
  requests[0]({ text: 'Como resolvo esse problema' });
  await tick();
  assert.deepEqual(partials, ['Como resolvo esse problema']);
  assert.equal(finals.length, 0);
  assert.equal(requests.length, 2);
  requests[1]({ text: 'esse problema no servidor?' });
  assert.deepEqual(await session.done, { text: 'Como resolvo esse problema no servidor?' });
  assert.deepEqual(finals, ['Como resolvo esse problema no servidor?']);
});

test('cancelling aborts the request and suppresses late text and final callbacks', async () => {
  let complete;
  let signal;
  const events = [];
  const session = new StreamingTranscription({
    transcribe: (_, inputSignal) => { signal = inputSignal; return new Promise((resolve) => { complete = resolve; }); },
    onPartial: (text) => events.push(text), onFinal: (text) => events.push(text),
  });
  session.push({ sequence: 0, wavBuffer: new Uint8Array(44), final: true });
  session.cancel();
  assert.equal(signal.aborted, true);
  complete({ text: 'stale result' });
  await tick();
  assert.equal(events.length, 0);
});

test('a failed chunk never submits an incomplete final phrase', async () => {
  let count = 0;
  const finals = [];
  const errors = [];
  const session = new StreamingTranscription({
    transcribe: async () => ++count === 1 ? { text: 'Parte inicial' } : { error: 'Serviço indisponível' },
    onFinal: (text) => finals.push(text), onError: (error) => errors.push(error),
  });
  session.push({ sequence: 0, wavBuffer: new Uint8Array(44) });
  await tick();
  session.push({ sequence: 1, wavBuffer: new Uint8Array(44), final: true });
  await session.done;
  assert.deepEqual(errors, ['Serviço indisponível']);
  assert.equal(finals.length, 0);
});

test('backpressure bounds queued audio and reports the stalled service', async () => {
  let complete;
  const errors = [];
  const session = new StreamingTranscription({
    maxPending: 2,
    transcribe: () => new Promise((resolve) => { complete = resolve; }),
    onError: (error) => errors.push(error),
  });
  for (let sequence = 0; sequence < 4; sequence++) session.push({ sequence, wavBuffer: new Uint8Array(44) });
  assert.equal(session.queue.length, 0);
  assert.match(errors[0], /acompanhando/);
  complete({ text: 'late' });
  await session.done;
});

test('a shorter first window preserves all samples and keeps subsequent windows at three seconds', () => {
  const parts = [];
  const chunker = new PcmChunker((part) => parts.push(part), { firstChunkMs: 2000 });
  const pcm = Uint8Array.from({ length: 224000 }, (_, i) => i % 251);
  for (let i = 0; i < pcm.length; i += 1600) chunker.push(pcm.subarray(i, i + 1600));
  chunker.finish();
  assert.equal(parts[0].wavBuffer.length - 44, 64000);
  assert.equal(parts[1].wavBuffer.length - 44, 96000);
  assert.deepEqual(Buffer.concat(parts.filter((part) => part.wavBuffer).map((part) =>
    Buffer.from(part.wavBuffer.subarray(44 + part.overlapBytes)))), Buffer.from(pcm));
});
