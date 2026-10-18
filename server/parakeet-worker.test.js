import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { languageByVocabulary, readWav, transcribeFile } from './parakeet-worker.js';

const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'parakeet-worker.js');

function wav(samples, { rate = 16000, channels = 1 } = {}) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => data.writeInt16LE(sample, i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test('reads 16 kHz mono as is and mixes down and resamples anything else', () => {
  assert.deepEqual([...readWav(wav([16384, -16384]))], [0.5, -0.5]);
  // Stereo 32 kHz: each frame is averaged, then every other frame is kept.
  const stereo = readWav(wav([16384, 0, 16384, 0, -16384, 0, -16384, 0], { rate: 32000, channels: 2 }));
  assert.deepEqual([...stereo], [0.25, -0.25]);
  assert.throws(() => readWav(Buffer.from('OggS not a wav at all')), /não é um WAV/);
});

test('picks the requested language whose common words fill the text', () => {
  assert.equal(languageByVocabulary('Como você faria isso no projeto?', ['pt-BR', 'en-US']), 'pt-BR');
  assert.equal(languageByVocabulary('How would you do this in the project?', ['pt-BR', 'en-US']), 'en-US');
  assert.equal(languageByVocabulary('Kubernetes', ['en-US', 'pt-BR']), 'en-US');
});

test('audio that is not a WAV is handed back for another worker to convert', (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'parakeet-worker-')), 'gravacao.webm');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  fs.writeFileSync(file, 'webm');
  assert.equal(transcribeFile({}, file, 'pt-BR').code, 'unsupported_audio');
});

test('without the model the worker reports it and exits', async () => {
  const child = spawn(process.execPath, [worker, '--serve', '--config', JSON.stringify({ engine: 'parakeet', modelDir: null })]);
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 3);
  assert.equal(JSON.parse(output).code, 'model_missing');
});
