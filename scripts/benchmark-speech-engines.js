// Explicitly invoked diagnostic: compares the speech recognition engines on the same
// audio. For each engine it starts the real transcribe.py worker, measures how long
// the model takes to load and how much memory the worker uses, then transcribes the
// first 1, 3, 5 and 7 s of every file (the sizes the live pipeline sends) and the
// whole file, one request at a time. A `<audio>.txt` next to a file is its reference
// text, for a word error rate (WER).
//
//   node scripts/benchmark-speech-engines.js [opções] <áudio>...
//     --engines google,parakeet,whisper-turbo,faster-whisper-small,faster-whisper-base,vosk
//     --language auto|pt-BR|en-US     (padrão: auto)
//     --chunks 1,3,5,7                (segundos)
//     --json resultado.json           (grava os números e os textos)
//
// Models come from the app's folder (or INTERVIEWAI_MODELS_DIR); Python from
// PYTHON_BIN or the app's venv; whisper-server from WHISPER_SERVER_BIN or the PATH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createTranscriber } from '../server/transcriber.js';
import { createModelStore } from '../server/speech-models.js';
import { createSpeechSettings } from '../server/speech-settings.js';
import { defaultProfilePath } from '../server/profile-store.js';
import { createWav } from '../shared/streaming-transcription.js';

const ENGINES = {
  google: { engine: 'google' },
  parakeet: { engine: 'parakeet' },
  'whisper-turbo': { engine: 'whisper-turbo' },
  'faster-whisper-small': { engine: 'faster-whisper', variant: 'small' },
  'faster-whisper-base': { engine: 'faster-whisper', variant: 'base' },
  vosk: { engine: 'vosk' },
};

function parseArgs(argv) {
  const options = { engines: Object.keys(ENGINES), language: 'auto', chunks: [1, 3, 5, 7], json: null, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--engines') options.engines = argv[++i].split(',');
    else if (arg === '--language') options.language = argv[++i];
    else if (arg === '--chunks') options.chunks = argv[++i].split(',').map(Number);
    else if (arg === '--json') options.json = argv[++i];
    else options.files.push(arg);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options.files.length || options.engines.some((name) => !ENGINES[name])) {
  console.error(`Uso: node scripts/benchmark-speech-engines.js [--engines ${Object.keys(ENGINES).join(',')}] [--language auto|pt-BR|en-US] [--chunks 1,3,5,7] [--json saida.json] <áudio>...`);
  process.exit(2);
}
const language = options.language === 'auto' ? 'pt-BR,en-US' : options.language;

const decode = (file) => {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ar', '16000', '-ac', '1', '-f', 's16le', '-'], { maxBuffer: 1 << 28 });
  if (result.status !== 0) throw new Error(`ffmpeg falhou em ${file}: ${result.stderr}`);
  return result.stdout;
};

const clips = options.files.map((file) => {
  const pcm = decode(file);
  const referenceFile = `${file}.txt`;
  return {
    file: path.basename(file),
    // The language, for the per-language WER, is guessed from the path ("pt_br/…", "en-1.wav").
    lang: /(^|[\/_.-])pt([\/_.-]|$)/i.test(file) ? 'pt' : /(^|[\/_.-])en([\/_.-]|$)/i.test(file) ? 'en' : null,
    seconds: pcm.length / 32000,
    pcm,
    reference: fs.existsSync(referenceFile) ? fs.readFileSync(referenceFile, 'utf8').trim() : null,
  };
});

const words = (text) => text.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
function wer(reference, hypothesis) {
  const ref = words(reference);
  const hyp = words(hypothesis || '');
  let previous = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const current = [i];
    for (let j = 1; j <= hyp.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return ref.length ? previous[hyp.length] / ref.length : 0;
}

// Resident memory of a process and its children (whisper-server runs under the worker), Linux only.
function residentMb(pid) {
  if (process.platform !== 'linux' || !pid) return null;
  const read = (id) => {
    try {
      const status = fs.readFileSync(`/proc/${id}/status`, 'utf8');
      const kb = Number(status.match(/VmRSS:\s+(\d+)/)?.[1] || 0);
      const children = fs.readdirSync(`/proc/${id}/task`).flatMap((task) => {
        try { return fs.readFileSync(`/proc/${id}/task/${task}/children`, 'utf8').trim().split(/\s+/).filter(Boolean); } catch { return []; }
      });
      return kb + children.reduce((sum, child) => sum + read(child), 0);
    } catch {
      return 0;
    }
  };
  return Math.round(read(pid) / 1024);
}

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const dataDir = path.dirname(defaultProfilePath());
const models = createModelStore({ dir: process.env.INTERVIEWAI_MODELS_DIR || path.join(dataDir, 'models') });

async function run(name) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'interviewai-bench-'));
  const settings = createSpeechSettings({ dataDir: scratch, models });
  settings.save(ENGINES[name]);
  fs.rmSync(scratch, { recursive: true, force: true });
  // The real data folder decides the venv; the scratch folder only holds the choice.
  const python = createSpeechSettings({ dataDir, models }).python;
  const workerConfig = settings.workerConfig();
  let pid = null;
  let ready = null;
  let readyAt = null;
  const fallbacks = [];
  const transcriber = createTranscriber({
    python,
    config: () => workerConfig,
    spawnImpl: (command, args, spawnOptions) => {
      const child = spawn(command, args, spawnOptions);
      if (!pid && args.includes(JSON.stringify(workerConfig))) pid = child.pid;
      return child;
    },
    onEvent: (event) => {
      if (event.type === 'ready' && event.engine === workerConfig.engine) { ready = event; readyAt = performance.now(); }
      if (event.type === 'fallback') fallbacks.push(event.error);
    },
  });
  const startedAt = performance.now();
  transcriber.warm();
  while (!ready && !fallbacks.length && performance.now() - startedAt < 300000) await new Promise((resolve) => setTimeout(resolve, 50));
  const transcribe = async (pcm) => {
    const begin = performance.now();
    const result = await transcriber.transcribe(createWav(pcm, 16000), language, { timeoutMs: 120000 });
    return { ms: Math.round(performance.now() - begin), ...result };
  };
  if (!ready || fallbacks.length) {
    // Asking once surfaces why the engine cannot run.
    const probe = await transcribe(clips[0].pcm.subarray(0, 32000));
    transcriber.close();
    return { name, error: fallbacks[0] || probe.error || 'não carregou' };
  }
  const loadMs = Math.round(readyAt - startedAt);
  const idleMb = residentMb(pid);
  await transcribe(clips[0].pcm.subarray(0, 32000)); // the first request warms caches and the GPU
  const latency = Object.fromEntries(options.chunks.map((seconds) => [seconds, []]));
  const outputs = [];
  for (const clip of clips) {
    for (const seconds of options.chunks) {
      if (clip.seconds < seconds) continue;
      latency[seconds].push((await transcribe(clip.pcm.subarray(0, seconds * 32000))).ms);
    }
    const whole = await transcribe(clip.pcm);
    outputs.push({ file: clip.file, ms: whole.ms, text: whole.text || '', language: whole.language || null, error: whole.text ? null : whole.error,
      wer: clip.reference ? wer(clip.reference, whole.text) : null });
    process.stdout.write('.');
  }
  const busyMb = residentMb(pid);
  transcriber.close();
  return {
    name, device: ready.device, loadMs, idleMb, busyMb, fallbacks,
    latency: Object.fromEntries(Object.entries(latency).map(([seconds, values]) => [seconds, median(values)])),
    outputs,
  };
}

const results = [];
for (const name of options.engines) {
  process.stdout.write(`${name} `);
  const result = await run(name);
  results.push(result);
  console.log(result.error ? ` erro: ${result.error}` : ` ok (${result.device})`);
}

const groupOf = (file) => clips.find((clip) => clip.file === file);
const meanWer = (result, test) => {
  const values = result.outputs.filter((output) => output.wer !== null && test(groupOf(output.file))).map((output) => output.wer);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
};
const percent = (value) => (value === null ? '—' : `${Math.round(value * 100)}%`);
const seconds = (ms) => (ms === null || ms === undefined ? '—' : (ms / 1000).toFixed(2));

console.log(`\n| Motor | Dispositivo | Carga (s) | RAM (MB) | ${options.chunks.map((s) => `${s} s`).join(' | ')} | WER pt | WER en |`);
console.log(`|---|---|---|---|${options.chunks.map(() => '---|').join('')}---|---|`);
for (const result of results) {
  if (result.error) {
    console.log(`| ${result.name} | erro: ${result.error} |`);
    continue;
  }
  console.log(`| ${result.name} | ${result.device} | ${seconds(result.loadMs)} | ${result.busyMb ?? '—'} | ${options.chunks.map((s) => seconds(result.latency[s])).join(' | ')} | ${percent(meanWer(result, (clip) => clip.lang === 'pt'))} | ${percent(meanWer(result, (clip) => clip.lang === 'en'))} |`);
}

for (const clip of clips) {
  console.log(`\n${clip.file} (${clip.seconds.toFixed(1)} s)${clip.reference ? `\n  referência: ${clip.reference}` : ''}`);
  for (const result of results.filter((entry) => !entry.error)) {
    const output = result.outputs.find((entry) => entry.file === clip.file);
    console.log(`  ${result.name.padEnd(20)} ${output.text || `(${output.error})`}${output.wer !== null ? `  [WER ${percent(output.wer)}]` : ''}`);
  }
}

if (options.json) {
  fs.writeFileSync(options.json, JSON.stringify({ date: new Date().toISOString(), language, chunks: options.chunks,
    clips: clips.map(({ pcm, ...clip }) => clip), results }, null, 2));
  console.log(`\nResultados em ${options.json}`);
}
process.exit(0);
