import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { AUTO_LANGUAGE, createUtteranceLanguage } from '../../shared/language.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function microphoneHarness({ requestPermission, streamedText = 'Frase completa', pendingFinal = false } = {}) {
  const slots = [];
  const effects = [];
  const sessions = [];
  const submitted = [];
  const requests = [];
  const recorders = [];
  let cursor = 0;
  let mounted = false;
  const stream = { active: true, getTracks: () => [{ stop() {} }] };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, Blob, Uint8Array, AbortController, AUTO_LANGUAGE, createUtteranceLanguage,
    navigator: { mediaDevices: { getUserMedia: requestPermission || (async () => stream) } },
    window: {
      addEventListener() {}, removeEventListener() {},
      AudioContext: class {
        state = 'running';
        createAnalyser() { return { frequencyBinCount: 64, getByteFrequencyData: (bytes) => bytes.fill(4) }; }
        createMediaStreamSource() { return { connect() {} }; }
        close() {}
      },
    },
    document: { activeElement: { tagName: 'BODY' } },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    MediaRecorder: class {
      static isTypeSupported() { return true; }
      mimeType = 'audio/webm';
      state = 'inactive';
      constructor() { recorders.push(this); }
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['backup audio']) });
        this.onstop?.();
      }
    },
    apiFetch: async (_, options) => { requests.push(options); return { json: async () => ({ text: 'Transcrição recuperada' }) }; },
    recordingToWav: async () => new Uint8Array([82, 73, 70, 70]),
    startMicrophoneTranscription: async (_, __, options) => {
      let resolve;
      const done = new Promise((finish) => { resolve = finish; });
      const session = {
        partial: options.onPartial,
        finish() { if (!pendingFinal) resolve(streamedText ? { text: streamedText } : { cancelled: true }); return done; },
        complete(text) { resolve({ text }); },
        cancelled: false,
        cancel() { session.cancelled = true; resolve({ cancelled: true }); },
      };
      sessions.push(session);
      return session;
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback: (callback) => callback,
    useEffect: (effect) => { if (!mounted) effects.push(effect); },
    submit: (text) => submitted.push(text),
  });
  const source = fs.readFileSync(new URL('./useVoiceCopilot.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export function useVoiceCopilot', 'function useVoiceCopilot');
  vm.runInContext(source, context);
  const state = () => { cursor = 0; return vm.runInContext('useVoiceCopilot({onFinalTranscript: submit})', context); };
  state(); effects.forEach((effect) => effect()); mounted = true;
  return { state, sessions, submitted, requests, recorders, stream };
}

test('microphone shows live text and submits the consolidated result only on release', async () => {
  const app = microphoneHarness();
  await app.state().startRecording();
  await tick();
  app.sessions[0].partial('Frase parcial');
  assert.equal(app.state().interimTranscript, 'Frase parcial');
  assert.equal(app.state().isListening, true);
  assert.deepEqual(app.submitted, []);
  await app.state().stopRecording();
  await tick();
  assert.deepEqual(app.submitted, ['Frase completa']);
  assert.equal(app.state().interimTranscript, '');
  assert.equal(app.state().isTranscribing, false);
  assert.equal(app.requests.length, 0, 'successful streaming must not retranscribe the full recording');
});

test('a failed incremental microphone session recovers using the complete recording', async () => {
  const app = microphoneHarness({ streamedText: null });
  await app.state().startRecording();
  await tick();
  await app.state().stopRecording();
  await tick();
  assert.equal(app.requests.length, 1);
  // The recording goes as a WAV the window decoded, which any recognizer reads.
  assert.equal(app.requests[0].headers['Content-Type'], 'audio/wav');
  assert.deepEqual(app.submitted, ['Transcrição recuperada']);
});

test('a new microphone turn cancels old finalization and ignores its late partials', async () => {
  const app = microphoneHarness({ pendingFinal: true });
  await app.state().startRecording(); await tick();
  await app.state().stopRecording();
  await app.state().startRecording(); await tick();
  assert.equal(app.sessions[0].cancelled, true);
  app.sessions[0].partial('Resultado antigo');
  assert.equal(app.state().interimTranscript, '');
  await app.state().stopRecording();
  app.sessions[1].complete('Nova frase');
  await tick();
  assert.deepEqual(app.submitted, ['Nova frase']);
  assert.equal(app.requests.length, 0);
});

test('session reset discards microphone audio without submitting it to the agent', async () => {
  const app = microphoneHarness({ pendingFinal: true });
  await app.state().startRecording(); await tick();
  app.sessions[0].partial('Texto em andamento');
  app.state().cancelRecording();
  app.sessions[0].complete('Resultado antigo');
  await tick();
  assert.equal(app.state().isListening, false);
  assert.equal(app.state().interimTranscript, '');
  assert.deepEqual(app.submitted, []);
  assert.equal(app.sessions[0].cancelled, true);
});

test('release while microphone permission is pending does not start recording later', async () => {
  let grant;
  const app = microphoneHarness({ requestPermission: () => new Promise((resolve) => { grant = resolve; }) });
  const starting = app.state().startRecording();
  await app.state().stopRecording();
  grant(app.stream);
  await starting;
  assert.equal(app.recorders.length, 0);
  assert.equal(app.state().isListening, false);
  assert.deepEqual(app.submitted, []);
});
