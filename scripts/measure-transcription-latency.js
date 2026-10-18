// Explicitly invoked diagnostic: plays a recording through the real PC pipeline
// (voice detection, rolling segments, the transcribe.py worker and the recognizer)
// at real-time pace, and prints when each partial and the final transcript appear,
// relative to the audio. The engine is Google unless another one is named; a local
// one uses the models downloaded by the app (see benchmark-speech-engines.js).
//
//   node scripts/measure-transcription-latency.js gravacao.wav [auto|pt-BR|en-US] [google|parakeet|whisper-turbo|faster-whisper|vosk] [small|base]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { SystemAudioEngine } from '../server/system-audio-engine.js';
import { wirePcTranscription } from '../server/pc-transcription.js';
import { createTranscriber } from '../server/transcriber.js';
import { createModelStore } from '../server/speech-models.js';
import { createSpeechSettings } from '../server/speech-settings.js';
import { defaultProfilePath } from '../server/profile-store.js';

const [file, language = 'auto', speechEngine = 'google', variant = 'small'] = process.argv.slice(2);
if (!file) {
  console.error('Uso: node scripts/measure-transcription-latency.js <áudio> [auto|pt-BR|en-US] [motor] [small|base]');
  process.exit(2);
}
const dataDir = path.dirname(defaultProfilePath());
const models = createModelStore({ dir: process.env.INTERVIEWAI_MODELS_DIR || path.join(dataDir, 'models') });
// The choice is kept in a scratch folder, so the app's own setting is not touched.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'interviewai-latency-'));
const choice = createSpeechSettings({ dataDir: scratch, models });
choice.save({ engine: speechEngine, variant });
fs.rmSync(scratch, { recursive: true, force: true });
const workerConfig = choice.workerConfig();
const transcriber = createTranscriber({
  python: createSpeechSettings({ dataDir, models }).python,
  config: () => workerConfig,
  onEvent: (event) => { if (event.type === 'fallback') console.log(`Usando o Google: ${event.error}`); },
});
const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ar', '16000', '-ac', '1', '-f', 's16le', '-'], { maxBuffer: 1 << 28 });
if (decoded.status !== 0) {
  console.error(String(decoded.stderr) || 'ffmpeg falhou');
  process.exit(2);
}
const FRAME = 1600; // 50 ms, the capture's frame size
// Two seconds of silence afterwards, so the pause ends the utterance as it would live.
const pcm = Buffer.concat([decoded.stdout, Buffer.alloc(64000)]);
const audioSec = decoded.stdout.length / 32000;

transcriber.warm();
// The model loads before the audio starts, as it does when the capture is turned on.
const loading = performance.now();
while (['loading', 'idle'].includes(transcriber.info().status) && workerConfig.engine !== 'google' && performance.now() - loading < 180000) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
await new Promise((resolve) => setTimeout(resolve, 500));
console.log(`Motor: ${transcriber.info().engine} (${transcriber.info().device || 'online'})`);

const engine = new SystemAudioEngine();
let started = 0;
const at = () => ((performance.now() - started) / 1000).toFixed(2).padStart(6);
const partials = [];
const finals = [];
wirePcTranscription(engine, {
  transcribe: transcriber.transcribe,
  concurrency: () => transcriber.concurrency(),
  getLanguage: () => language,
  broadcast(event) {
    const now = (performance.now() - started) / 1000;
    if (event.type === 'pc_speech_partial') {
      partials.push(now);
      console.log(`${at()} s  parcial: ${event.text}`);
    } else if (event.type === 'pc_speech_end') {
      console.log(`${at()} s  fim da fala${event.discarded ? ' (descartada)' : ''}`);
    } else if (event.type === 'pc_speech_transcribed') {
      finals.push({ at: now, text: event.text });
      console.log(`${at()} s  FINAL (${event.language}): ${event.text}`);
    } else if (event.type === 'pc_speech_error') console.log(`${at()} s  erro: ${event.error}`);
  },
  onFinal() {},
});
engine.isCapturing = true;
started = performance.now();
for (let offset = 0, frame = 0; offset < pcm.length; offset += FRAME, frame++) {
  engine.processPcmChunk(pcm.subarray(offset, offset + FRAME));
  const due = started + (frame + 1) * 50;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - performance.now())));
}
// Let the last recognition finish.
await new Promise((resolve) => setTimeout(resolve, 3000));

const gaps = partials.slice(1).map((time, i) => time - partials[i]);
console.log(JSON.stringify({
  audioSec: Number(audioSec.toFixed(1)),
  firstPartialSec: partials.length ? Number(partials[0].toFixed(2)) : null,
  partials: partials.length,
  meanGapSec: gaps.length ? Number((gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2)) : null,
  lastFinalAfterSpeechSec: finals.length ? Number((finals.at(-1).at - audioSec).toFixed(2)) : null,
  finals: finals.map((final) => final.text),
}, null, 2));
process.exit(finals.length ? 0 : 1);
