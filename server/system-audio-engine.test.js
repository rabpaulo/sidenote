import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultAudioSource, SystemAudioEngine } from './system-audio-engine.js';

const chunkDurationMs = 50;

function pcmChunk(amplitude) {
  const chunk = Buffer.alloc(1600);
  for (let offset = 0; offset < chunk.length; offset += 2) {
    chunk.writeInt16LE(amplitude, offset);
  }
  return chunk;
}

async function feedSpeech(engine, durationMs, amplitude = 4000) {
  const speech = pcmChunk(amplitude);
  const frames = Math.ceil(durationMs / chunkDurationMs);
  for (let frame = 0; frame < frames; frame += 1) {
    engine.processPcmChunk(speech);
    await new Promise((resolve) => setTimeout(resolve, chunkDurationMs));
  }
}

async function feedSilence(engine, durationMs) {
  const silence = pcmChunk(0);
  engine.processPcmChunk(silence);
  const timer = setInterval(() => engine.processPcmChunk(silence), chunkDurationMs);
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  clearInterval(timer);
}

test('discards a brief audio spike instead of transcribing the silence tail', async () => {
  const engine = new SystemAudioEngine();
  const segments = [];
  engine.on('speech_segment', (segment) => segments.push(segment));

  await feedSpeech(engine, chunkDurationMs);
  await feedSilence(engine, engine.silenceMsThreshold + 100);

  assert.equal(segments.length, 0);
});

test('keeps a sustained speech segment through the silence pause', async () => {
  const engine = new SystemAudioEngine();
  const segments = [];
  engine.on('speech_segment', (segment) => segments.push(segment));

  await feedSpeech(engine, 900);
  await feedSilence(engine, engine.silenceMsThreshold + 100);

  assert.equal(segments.length, 1);
  assert.ok(segments[0].durationSec >= 0.7);
});

test('keeps quieter speech after a loud onset and returns to idle after a click', () => {
  const engine = new SystemAudioEngine();
  const segments = [];
  let ended = 0;
  engine.on('speech_segment', (segment) => segments.push(segment));
  engine.on('speech_end', () => { ended += 1; });

  // A loud syllable followed by quiet speech must reach transcription.
  engine.processPcmChunk(pcmChunk(1100));
  for (let frame = 0; frame < 20; frame += 1) engine.processPcmChunk(pcmChunk(500));
  engine.finishSpeechSegment();
  assert.equal(segments.length, 1, 'quiet speech was discarded before reaching the model');
  assert.ok(segments[0].durationSec >= 1);

  engine.processPcmChunk(pcmChunk(4000));
  engine.finishSpeechSegment();
  assert.equal(segments.length, 1, 'a lone click must still be discarded');
  assert.equal(ended, 2, 'discarded audio must clear the speaking notice');
});

test('does not let an old parec process mark a newer capture as stopped', async () => {
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interviewai-fake-audio-'));
  const fakeParec = path.join(fakeBinDir, 'parec');
  const originalPath = process.env.PATH;
  fs.writeFileSync(fakeParec, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n');
  fs.chmodSync(fakeParec, 0o755);
  process.env.PATH = `${fakeBinDir}:${originalPath || ''}`;

  const engine = new SystemAudioEngine();
  try {
    assert.equal(engine.startCapture({ sink: 'first-sink' }), true);
    assert.equal(engine.startCapture({ sink: 'second-sink' }), true);
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(engine.getStatus().isCapturing, true);
    assert.equal(engine.getStatus().sink, 'second-sink.monitor');
  } finally {
    engine.stopCapture();
    process.env.PATH = originalPath;
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test('Windows captures in the renderer and the engine segments the PCM it pushes', async () => {
  assert.equal(defaultAudioSource({}, 'win32'), 'renderer');
  assert.equal(defaultAudioSource({}, 'linux'), 'parec');
  assert.equal(defaultAudioSource({ INTERVIEWAI_AUDIO_SOURCE: 'renderer' }, 'linux'), 'renderer');
  assert.equal(SystemAudioEngine.listAudioSinks('renderer').defaultSink, 'loopback');

  const engine = new SystemAudioEngine({ source: 'renderer' });
  const statuses = [];
  const starts = [];
  engine.on('status', (status) => statuses.push(status));
  engine.on('speech_start', (event) => starts.push(event));
  engine.pushPcm(pcmChunk(4000));
  assert.equal(starts.length, 0, 'audio before the capture starts is ignored');

  assert.equal(engine.startCapture(), true);
  assert.deepEqual(statuses.at(-1), { isCapturing: true, sink: 'loopback', source: 'renderer', app: null });
  assert.equal(engine.captureProcess, null, 'no parec process on Windows');
  // Packets of any size are re-cut into 50 ms chunks.
  const speech = Buffer.concat([pcmChunk(4000), pcmChunk(4000)]);
  engine.pushPcm(speech.subarray(0, 1000));
  assert.equal(starts.length, 0);
  engine.pushPcm(speech.subarray(1000));
  assert.equal(starts.length, 1);
  engine.stopCapture();
  assert.equal(engine.getStatus().isCapturing, false);
});
