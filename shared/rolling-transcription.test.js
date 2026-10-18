import test from 'node:test';
import assert from 'node:assert/strict';
import { RollingAudio, RollingTranscription } from './rolling-transcription.js';

const FRAME = 1600; // 50 ms
const tone = (amplitude) => {
  const pcm = new Uint8Array(FRAME);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < FRAME; i += 2) view.setInt16(i, amplitude, true);
  return pcm;
};
const speech = tone(4000);
const dip = tone(400); // a consonant: about 20 dB below the vowels
const gap = tone(0);
const seconds = (chunk) => chunk.wavBuffer ? (chunk.wavBuffer.length - 44) / 32000 : 0;

function record(frames) {
  const chunks = [];
  const audio = new RollingAudio((chunk) => chunks.push(chunk));
  for (const frame of frames) audio.push(frame);
  return { audio, chunks };
}
const repeat = (frame, count) => Array(count).fill(frame);

test('the open tail is sent after one second, then every second as it grows', () => {
  const { chunks } = record(repeat(speech, 50));
  assert.deepEqual(chunks.map((chunk) => [chunk.kind, chunk.segment, seconds(chunk)]),
    [['tail', 0, 1], ['tail', 0, 2]]);
});

test('a segment closes at a real pause, and the next tail starts after it', () => {
  const { chunks } = record([...repeat(speech, 40), ...repeat(gap, 4), ...repeat(speech, 30)]);
  const commit = chunks.find((chunk) => chunk.kind === 'commit');
  assert.ok(commit, 'the pause allows a cut');
  assert.ok(seconds(commit) > 2 && seconds(commit) < 2.2, `cut at ${seconds(commit)} s, inside the pause`);
  const after = chunks.filter((chunk) => chunk.segment === 1);
  assert.ok(after.length && after.every((chunk) => chunk.kind === 'tail' && seconds(chunk) < 1.5));
});

test('a consonant dip is not a pause: the segment grows until the hard limit', () => {
  const frames = [];
  for (let i = 0; i < 8; i++) frames.push(...repeat(speech, 17), ...repeat(dip, 3));
  const { chunks } = record(frames); // 8 s with a dip every second
  const commits = chunks.filter((chunk) => chunk.kind === 'commit');
  assert.equal(commits.length, 1);
  // At 7 s the latest dip that leaves 250 ms after it is the one near 6 s.
  assert.ok(seconds(commits[0]) > 5.9, 'no cut before the tail reaches 7 s');
});

test('a pause flush is reused by the final when no speech follows it', () => {
  const { audio, chunks } = record(repeat(speech, 30));
  for (const frame of repeat(gap, 6)) audio.push(frame, false);
  assert.equal(audio.flushPending(6 * FRAME), true);
  const flush = chunks.at(-1);
  assert.equal(flush.pause, true);
  assert.equal(seconds(flush), 1.8, 'speech plus 300 ms of the pause, so a quiet last syllable survives');
  for (const frame of repeat(gap, 12)) audio.push(frame, false);
  audio.finish(12 * FRAME);
  const final = chunks.at(-1);
  assert.equal(final.kind, 'final');
  assert.equal(final.wavBuffer, null);
  assert.equal(final.reuse, flush.sequence);
});

test('speech after a flush makes the final send the whole tail again', () => {
  const { audio, chunks } = record(repeat(speech, 30));
  for (const frame of repeat(gap, 6)) audio.push(frame, false);
  audio.flushPending(6 * FRAME);
  for (const frame of repeat(speech, 10)) audio.push(frame);
  for (const frame of repeat(gap, 18)) audio.push(frame, false);
  audio.finish(18 * FRAME);
  const final = chunks.at(-1);
  assert.ok(final.wavBuffer);
  assert.ok(Math.abs(seconds(final) - (1.8 + 0.5 + 0.3)) < 1e-9);
});

function consumer(results) {
  const partials = [];
  const finals = [];
  const errors = [];
  const calls = [];
  const session = new RollingTranscription({
    transcribe: (wav, signal, chunk) => new Promise((resolve) => calls.push({ chunk, resolve: (result) => resolve(result) })),
    onPartial: (text) => partials.push(text),
    onFinal: (text) => finals.push(text),
    onError: (error) => errors.push(error),
    ...results,
  });
  return { session, partials, finals, errors, calls };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const wav = new Uint8Array(46);

test('a late answer for an older tail never replaces a newer one', async () => {
  const { session, partials, finals, calls } = consumer();
  session.push({ kind: 'tail', segment: 0, sequence: 0, wavBuffer: wav });
  session.push({ kind: 'tail', segment: 0, sequence: 1, wavBuffer: wav });
  await tick();
  calls[1].resolve({ text: 'Como resolvo esse problema' });
  await tick();
  calls[0].resolve({ text: 'Como' });
  await tick();
  assert.deepEqual(partials, ['Como resolvo esse problema']);
  session.push({ kind: 'final', final: true, segment: 0, sequence: 2, wavBuffer: null, reuse: 1 });
  await tick();
  assert.deepEqual(finals, ['Como resolvo esse problema']);
});

test('segments are joined in order; a failed commit keeps its last tail text', async () => {
  const { session, finals, calls } = consumer();
  session.push({ kind: 'tail', segment: 0, sequence: 0, wavBuffer: wav });
  session.push({ kind: 'commit', segment: 0, sequence: 1, wavBuffer: wav });
  session.push({ kind: 'tail', segment: 1, sequence: 2, wavBuffer: wav });
  session.push({ kind: 'commit', segment: 1, sequence: 3, wavBuffer: wav });
  session.push({ kind: 'final', final: true, segment: 2, sequence: 4, wavBuffer: wav });
  await tick();
  const answer = (sequence, result) => calls.find((call) => call.chunk.sequence === sequence).resolve(result);
  answer(4, { text: 'no banco?' });
  answer(2, { text: 'quando os dados' });
  answer(0, { text: 'como você organiza' });
  answer(3, { error: 'Sem conexão' });
  await tick();
  assert.deepEqual(finals, [], 'the final waits for every commit');
  answer(1, { text: 'como você organizaria o cache' });
  await tick();
  assert.deepEqual(finals, ['como você organizaria o cache quando os dados no banco?']);
});

test('an utterance with no recognized words fails once', async () => {
  const { session, finals, errors, calls } = consumer();
  session.push({ kind: 'tail', segment: 0, sequence: 0, wavBuffer: wav });
  session.push({ kind: 'final', final: true, segment: 0, sequence: 1, wavBuffer: wav });
  await tick();
  calls[0].resolve({ error: 'x', code: 'unrecognized' });
  calls[1].resolve({ error: 'x', code: 'unrecognized' });
  await tick();
  assert.deepEqual(finals, []);
  assert.deepEqual(errors, ['Não foi possível entender o áudio']);
});

test('at most three tails run at once; the newest waiting one replaces the others', async () => {
  const { session, calls } = consumer();
  for (let sequence = 0; sequence < 6; sequence++) session.push({ kind: 'tail', segment: 0, sequence, wavBuffer: wav });
  await tick();
  assert.deepEqual(calls.map((call) => call.chunk.sequence), [0, 1, 2]);
  calls[0].resolve({ text: 'a' });
  await tick();
  assert.deepEqual(calls.map((call) => call.chunk.sequence), [0, 1, 2, 5]);
});

test('with a local engine one request runs at a time: waiting tails collapse to the newest, commits and finals always run', async () => {
  const { session, finals, calls } = consumer({ maxInFlight: 1 });
  for (let sequence = 0; sequence < 4; sequence++) session.push({ kind: 'tail', segment: 0, sequence, wavBuffer: wav });
  await tick();
  assert.deepEqual(calls.map((call) => call.chunk.sequence), [0], 'no tail is queued behind the one in flight');
  session.push({ kind: 'commit', segment: 0, sequence: 4, wavBuffer: wav });
  await tick();
  assert.deepEqual(calls.map((call) => call.chunk.sequence), [0, 4], 'a commit is never held back or dropped');
  session.push({ kind: 'tail', segment: 1, sequence: 5, wavBuffer: wav });
  calls[0].resolve({ text: 'como' });
  await tick();
  assert.deepEqual(calls.map((call) => call.chunk.sequence), [0, 4], 'the waiting tail waits for the commit too');
  calls[1].resolve({ text: 'como você organiza' });
  await tick();
  assert.deepEqual(calls.map((call) => call.chunk.sequence), [0, 4, 5], 'then only the newest audio is sent');
  session.push({ kind: 'final', final: true, segment: 1, sequence: 6, wavBuffer: wav });
  await tick();
  assert.deepEqual(calls.map((call) => call.chunk.sequence), [0, 4, 5, 6], 'the final is sent at once');
  calls[2].resolve({ text: 'o cache' });
  calls[3].resolve({ text: 'o cache?' });
  await tick();
  assert.deepEqual(finals, ['como você organiza o cache?']);
});

test('a period a punctuating recognizer put at a segment cut is dropped when the sentence goes on', async () => {
  const { session, finals, calls } = consumer();
  session.push({ kind: 'commit', segment: 0, sequence: 0, wavBuffer: wav });
  session.push({ kind: 'commit', segment: 1, sequence: 1, wavBuffer: wav });
  session.push({ kind: 'final', final: true, segment: 2, sequence: 2, wavBuffer: wav });
  await tick();
  calls[0].resolve({ text: 'A parte central é o Deity Yoga.' });
  calls[1].resolve({ text: 'através da visualização. Os canais são limpos.' });
  calls[2].resolve({ text: 'Os chakras são ativados.' });
  await tick();
  assert.deepEqual(finals, ['A parte central é o Deity Yoga através da visualização. Os canais são limpos. Os chakras são ativados.']);
});
