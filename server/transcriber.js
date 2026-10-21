import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { killProcessTree, resolvePython } from './cli-process.js';
import { SPEECH_ENGINES } from '../shared/speech-engines.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const scriptPath = path.resolve(__dirname, 'transcribe.py');
const nodeWorkerPath = path.resolve(__dirname, 'parakeet-worker.js');
// Engines that run in Node (the app's own runtime) instead of transcribe.py.
const NODE_ENGINES = new Set(SPEECH_ENGINES.filter((engine) => engine.runtime === 'node').map((engine) => engine.id));

const GOOGLE = { engine: 'google' };
// Answers from a local engine that mean "this engine cannot do it", not "no speech".
const ENGINE_FAILURES = new Set(['engine_error', 'engine_unavailable', 'model_missing', 'package_missing', 'binary_missing', 'timeout']);
// Failures in a row after which a local engine is left aside until the setting changes.
const MAX_LOCAL_FAILURES = 3;

/**
 * Speech recognition through long-lived `transcribe.py --serve` processes, one per
 * engine configuration. Starting Python and loading a model for every chunk would
 * cost far more than the recognition itself; a worker pays it once and answers
 * requests by id. A worker that exits (or never starts) fails its pending requests;
 * the next request starts a new one.
 *
 * `config()` names the engine to use ({ engine: 'google' } or a local one with its
 * model paths). When it changes, the old worker finishes what it was given and
 * exits. When a local engine cannot load or keeps failing, requests go to Google
 * instead, and `onEvent` reports it once, until the configuration changes.
 *
 * A local model holds hundreds of MB, so with `idleMs` the workers exit after that
 * long without requests, unless `keepWarm()` says they are about to be needed.
 */
export function createTranscriber({ python = () => resolvePython(), script = scriptPath, nodeScript = nodeWorkerPath,
  spawnImpl = spawn, config = () => GOOGLE, onEvent = () => {}, loadTimeoutMs = 180000,
  idleMs = 0, keepWarm = () => false } = {}) {
  const workers = new Map();
  let nextId = 0;
  let idleTimer = null;
  let disabled = null; // { key, error }: a local configuration that is not used anymore
  let failures = 0;
  let warned = null;

  const keyOf = (workerConfig) => JSON.stringify(workerConfig);
  const isLocal = (workerConfig) => workerConfig.engine !== 'google';

  function start(workerConfig, key) {
    // A Node engine runs with this process's executable: Node, or Electron acting as Node.
    const { command, args } = NODE_ENGINES.has(workerConfig.engine)
      ? { command: process.execPath, args: [nodeScript] }
      : { command: python().command, args: [...python().args, script] };
    const child = spawnImpl(command, [...args, '--serve', '--config', key], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Python on Windows defaults stdout to the ANSI code page, which breaks accents in the JSON.
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ELECTRON_RUN_AS_NODE: '1' },
    });
    const state = { child, key, config: workerConfig, pending: new Map(), lastOutput: 0, startedAt: Date.now(), ready: null, failed: null };
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      state.lastOutput = Date.now();
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch {
          console.warn('[Transcriber] Unreadable line from the speech worker:', line.slice(0, 200));
          continue;
        }
        if (message.event === 'ready') {
          state.ready = message;
          if (isLocal(workerConfig)) console.log(`[Transcriber] ${message.engine} ready on ${message.device} in ${message.loadMs} ms`);
          onEvent({ type: 'ready', engine: message.engine, device: message.device, loadMs: message.loadMs });
          continue;
        }
        if (message.event === 'fatal') {
          state.failed = { error: message.error, code: message.code || 'engine_unavailable' };
          console.warn(`[Transcriber] ${workerConfig.engine} could not load: ${message.error}`);
          for (const request of [...state.pending.values()]) request.answer({ error: message.error, code: 'engine_unavailable' });
          continue;
        }
        const { id, ...result } = message;
        state.pending.get(id)?.answer(result);
      }
    });
    child.stderr.on('data', (data) => {
      const text = String(data).trim();
      if (text) console.warn(`[Transcriber] ${workerConfig.engine}:`, text.slice(0, 500));
    });
    child.stdin.on('error', () => {}); // a dead worker is reported by 'close'
    const stop = (reason) => {
      if (workers.get(key) === state) workers.delete(key);
      const code = isLocal(workerConfig) ? 'engine_error' : undefined;
      for (const request of [...state.pending.values()]) request.answer({ error: state.failed?.error || reason, ...(code && { code }) });
    };
    child.on('error', (error) => {
      console.error('[Transcriber] Failed to start the speech worker:', error.message);
      stop(error.message);
    });
    child.on('close', (code) => stop(`O reconhecimento de voz foi encerrado (código ${code})`));
    // An idle worker must not keep the app (or a test) running.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.unref?.();
    return state;
  }

  // Workers of other configurations finish their queue and exit, freeing their model
  // (the Google worker is kept: it is the fallback while a local one is in use).
  function prune(extra = null) {
    const keep = new Set([keyOf(config()), keyOf(GOOGLE), extra]);
    for (const [other, state] of workers) {
      if (keep.has(other)) continue;
      workers.delete(other);
      try { state.child.stdin.end(); } catch {}
    }
  }

  // Workers finish what they were given and exit, freeing their models.
  function release() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (!workers.size) return;
    for (const state of workers.values()) {
      try { state.child.stdin.end(); } catch {}
    }
    workers.clear();
    onEvent({ type: 'released' });
  }

  function touch() {
    if (!idleMs) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const busy = [...workers.values()].some((state) => state.pending.size);
      if (busy || keepWarm()) touch();
      else release();
    }, idleMs);
    idleTimer.unref?.();
  }

  function workerFor(workerConfig) {
    touch();
    const key = keyOf(workerConfig);
    prune(key);
    if (!workers.has(key)) workers.set(key, start(workerConfig, key));
    return workers.get(key);
  }

  function send(state, audioBuffer, language, { timeoutMs, signal }) {
    if (signal?.aborted) return Promise.resolve({ error: 'Transcrição cancelada' });
    const file = path.join(os.tmpdir(), `pc_audio_${Date.now()}_${Math.random().toString(36).substring(7)}.wav`);
    try {
      fs.writeFileSync(file, audioBuffer);
    } catch (error) {
      console.error('[Transcriber] Failed to write temporary audio file:', error);
      return Promise.resolve({ error: error.message });
    }
    const id = ++nextId;
    const sentAt = Date.now();
    const local = isLocal(state.config);

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve(result);
      };
      // The file stays until the worker is done with it, even if the caller gave up.
      state.pending.set(id, {
        answer(result) {
          state.pending.delete(id);
          try { fs.unlinkSync(file); } catch {}
          settle(result);
        },
      });
      const expire = () => {
        // A local model may still be loading; that is not a stuck worker.
        if (local && !state.ready && !state.failed && Date.now() - state.startedAt < loadTimeoutMs) {
          timer = setTimeout(expire, timeoutMs);
          return;
        }
        // Silence since this request was sent means the worker itself is stuck. On Windows the
        // whole tree goes, or a whisper-server it started would outlive it.
        if (state.lastOutput < sentAt) killProcessTree(state.child, 'SIGKILL');
        settle({ error: 'A transcrição demorou demais. Verifique a conexão e tente novamente', ...(local && { code: 'timeout' }) });
      };
      timer = setTimeout(expire, timeoutMs);
      const abort = () => {
        // A local engine drops the request if it is still waiting in its queue.
        if (local) {
          try { state.child.stdin.write(`${JSON.stringify({ cancel: id })}\n`); } catch {}
        }
        settle({ error: 'Transcrição cancelada' });
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (state.failed) {
        state.pending.get(id)?.answer({ error: state.failed.error, code: 'engine_unavailable' });
        return;
      }
      try {
        state.child.stdin.write(`${JSON.stringify({ id, file, language })}\n`);
      } catch (error) {
        state.pending.get(id)?.answer({ error: error.message, ...(local && { code: 'engine_error' }) });
      }
    });
  }

  function useGoogleFor(key, result, permanent) {
    if (permanent) disabled = { key, error: result.error };
    if (warned === key) return;
    warned = key;
    onEvent({ type: 'fallback', engine: JSON.parse(key).engine, error: result.error, code: result.code, permanent });
  }

  /**
   * @param {Buffer} audioBuffer WAV, WEBM, etc.
   * @param {string} language e.g. 'pt-BR', or 'pt-BR,en-US' to detect which one was spoken
   * @returns {Promise<{ text?: string, language?: string, error?: string, code?: string }>}
   */
  async function transcribe(audioBuffer, language = 'pt-BR', { timeoutMs = 30000, signal } = {}) {
    const wanted = config();
    const key = keyOf(wanted);
    if (isLocal(wanted) && disabled?.key !== key) {
      const result = await send(workerFor(wanted), audioBuffer, language, { timeoutMs, signal });
      // A format the engine cannot read says nothing about the engine itself.
      if (result.code === 'unsupported_audio' && !signal?.aborted) {
        return send(workerFor(GOOGLE), audioBuffer, language, { timeoutMs, signal });
      }
      if (!ENGINE_FAILURES.has(result.code) || signal?.aborted) {
        if (result.text) failures = 0;
        return result;
      }
      failures++;
      // A model or package that is missing will not appear by itself; a crash may be a one-off.
      const permanent = (result.code !== 'engine_error' && result.code !== 'timeout') || failures >= MAX_LOCAL_FAILURES;
      console.warn(`[Transcriber] ${wanted.engine} failed (${result.code}): ${result.error}; using Google${permanent ? ' from now on' : ' for this request'}`);
      useGoogleFor(key, result, permanent);
    }
    return send(workerFor(GOOGLE), audioBuffer, language, { timeoutMs, signal });
  }

  const usingLocal = () => isLocal(config()) && disabled?.key !== keyOf(config());

  return {
    transcribe,
    /** Starts the worker ahead of the first utterance. */
    warm() {
      workerFor(usingLocal() ? config() : GOOGLE);
    },
    /** How many requests of one utterance may run at once: a local engine does one at a time. */
    concurrency() {
      return usingLocal() ? 1 : 3;
    },
    /** Uses a local engine that was left aside again (after the user changed or retried it). */
    retry() {
      disabled = null;
      failures = 0;
      warned = null;
      prune();
    },
    info() {
      const wanted = config();
      const state = workers.get(keyOf(wanted));
      const fallback = isLocal(wanted) && disabled?.key === keyOf(wanted);
      return {
        engine: wanted.engine,
        status: fallback ? 'fallback' : state?.failed ? 'failed' : state?.ready ? 'ready' : state ? 'loading' : 'idle',
        device: state?.ready?.device || null,
        loadMs: state?.ready?.loadMs ?? null,
        error: fallback ? disabled.error : state?.failed?.error || null,
      };
    },
    release,
    close() {
      clearTimeout(idleTimer);
      for (const state of workers.values()) killProcessTree(state.child);
      workers.clear();
    },
  };
}
