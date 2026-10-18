// Parakeet TDT 0.6B v3 (int8) through sherpa-onnx's Node addon: local speech
// recognition without Python. Speaks the same protocol as `transcribe.py --serve`
// (see server/transcriber.js), so the transcriber runs it like any other worker:
//
//   node server/parakeet-worker.js --serve --config '{"engine":"parakeet","modelDir":"..."}'
//
// Writes {"event":"ready",...} once the model is loaded, or {"event":"fatal",...} and
// exits. Then reads one JSON request per line, {"id","file","language"}, and answers
// each with one line carrying the same id; {"cancel": id} drops a queued request.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 16000;

// Frequent function words. Parakeet does not report the language, so the text's
// vocabulary decides between the requested ones.
const STOPWORDS = {
  pt: new Set(['de', 'que', 'o', 'a', 'os', 'as', 'do', 'da', 'em', 'um', 'uma', 'para', 'com', 'não',
    'é', 'eu', 'você', 'isso', 'se', 'na', 'no', 'mais', 'como', 'mas', 'por', 'ele', 'ela',
    'tem', 'meu', 'minha', 'sua', 'seu', 'está', 'foi', 'são', 'também', 'então', 'aqui']),
  en: new Set(['the', 'and', 'is', 'you', 'to', 'of', 'it', 'in', 'that', 'what', 'i', 'a', 'an', 'do',
    'this', 'are', 'was', 'for', 'with', 'have', 'how', 'can', 'your', 'my', 'we', 'be',
    'not', 'on', 'about', 'would', 'so', 'me', 'there', 'they', 'tell', 'why', 'will']),
};

const baseLanguage = (language) => language.split('-')[0].toLowerCase();

function stopwordRatio(language, text) {
  const words = text.toLowerCase().match(/\p{L}+/gu) || [];
  const vocabulary = STOPWORDS[baseLanguage(language)] || new Set();
  return words.length ? words.filter((word) => vocabulary.has(word)).length / words.length : 0;
}

/** The requested language whose function words fill more of the text; the first one on ties. */
export function languageByVocabulary(text, languages) {
  let best = languages[0];
  let bestRatio = -1;
  for (const language of languages) {
    const ratio = stopwordRatio(language, text);
    if (ratio > bestRatio) {
      best = language;
      bestRatio = ratio;
    }
  }
  return best;
}

/**
 * Samples of a PCM16 WAV as 16 kHz mono floats in [-1, 1]. The app sends 16 kHz mono;
 * other rates and channel counts are mixed down and resampled linearly.
 */
export function readWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('O áudio não é um WAV.');
  }
  let format = null;
  let data = null;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = { code: buffer.readUInt16LE(body), channels: buffer.readUInt16LE(body + 2),
        rate: buffer.readUInt32LE(body + 4), bits: buffer.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      // A stream still being written may declare a larger size than it has.
      data = buffer.subarray(body, Math.min(body + size, buffer.length));
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!format || !data) throw new Error('WAV sem áudio.');
  if (format.code !== 1 || format.bits !== 16) throw new Error('O WAV precisa ser PCM de 16 bits.');
  const frames = Math.floor(data.length / (2 * format.channels));
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < format.channels; channel++) sum += data.readInt16LE((frame * format.channels + channel) * 2);
    mono[frame] = sum / format.channels / 32768;
  }
  if (format.rate === SAMPLE_RATE) return mono;
  const length = Math.floor(frames * SAMPLE_RATE / format.rate);
  const resampled = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * format.rate / SAMPLE_RATE;
    const left = Math.floor(position);
    const right = Math.min(left + 1, frames - 1);
    resampled[i] = mono[left] + (mono[right] - mono[left]) * (position - left);
  }
  return resampled;
}

function findOne(dir, pattern) {
  const match = fs.readdirSync(dir).filter((name) => pattern.test(name)).sort()[0];
  if (!match) {
    throw Object.assign(new Error(`Arquivo ${pattern.source} não encontrado em ${dir}. Baixe o modelo de novo.`), { code: 'model_missing' });
  }
  return path.join(dir, match);
}

// Half the logical CPUs (the physical cores, usually), leaving room for the app.
const cpuThreads = () => Math.max(1, Math.min(8, Math.floor(os.cpus().length / 2)));

function loadRecognizer(modelDir) {
  if (!modelDir || !fs.existsSync(modelDir)) {
    throw Object.assign(new Error('O modelo Parakeet não está instalado. Baixe-o em Menu → Reconhecimento de voz.'), { code: 'model_missing' });
  }
  let sherpa;
  try {
    sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
  } catch (error) {
    throw Object.assign(new Error(`O sherpa-onnx não carregou neste sistema: ${error.message}`), { code: 'engine_unavailable' });
  }
  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: findOne(modelDir, /^encoder.*\.onnx$/),
        decoder: findOne(modelDir, /^decoder.*\.onnx$/),
        joiner: findOne(modelDir, /^joiner.*\.onnx$/),
      },
      tokens: findOne(modelDir, /^tokens\.txt$/),
      numThreads: cpuThreads(),
      provider: 'cpu',
      modelType: 'nemo_transducer',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  });
}

export function transcribeFile(recognizer, file, language = 'pt-BR') {
  const languages = String(language).split(',').map((item) => item.trim()).filter(Boolean);
  if (!languages.length) languages.push('pt-BR');
  let samples;
  try {
    samples = readWav(fs.readFileSync(file));
  } catch (error) {
    // Not a WAV (a recording the window could not decode): Google's worker converts it.
    return { error: `Áudio ilegível: ${error.message}`, code: 'unsupported_audio' };
  }
  try {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    recognizer.decode(stream);
    const text = recognizer.getResult(stream).text.trim();
    if (!text) return { error: 'Não foi possível entender o áudio', code: 'unrecognized' };
    return { text, language: languageByVocabulary(text, languages) };
  } catch (error) {
    return { error: error.message, code: 'engine_error' };
  }
}

function serve(config) {
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const started = Date.now();
  let recognizer;
  try {
    recognizer = loadRecognizer(config.modelDir);
  } catch (error) {
    write({ event: 'fatal', error: error.message, code: error.code || 'engine_error' });
    process.exitCode = 3;
    return;
  }
  write({ event: 'ready', engine: 'parakeet', device: 'CPU', loadMs: Date.now() - started });

  // Requests are decoded one at a time, in arrival order; decoding blocks this
  // process only, and reading the next lines waits until it is done.
  const cancelled = new Set();
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (request.cancel !== undefined) {
      cancelled.add(request.cancel);
      return;
    }
    // A cancel sent before this request was read still applies once it is read.
    setImmediate(() => {
      if (cancelled.delete(request.id)) {
        write({ id: request.id, error: 'Transcrição cancelada', code: 'cancelled' });
        return;
      }
      write({ id: request.id, ...transcribeFile(recognizer, request.file, request.language || 'pt-BR') });
    });
  });
  lines.on('close', () => setImmediate(() => process.exit(0)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args[0] === '--serve') {
    serve(args[1] === '--config' && args[2] ? JSON.parse(args[2]) : {});
  } else if (args[0]) {
    // One file, for trying the engine by hand: parakeet-worker.js <model dir> <audio.wav> [languages]
    console.log(JSON.stringify(transcribeFile(loadRecognizer(args[0]), args[1], args[2])));
  }
}
