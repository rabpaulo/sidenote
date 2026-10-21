import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliAvailable, findOnPath, killProcessTree, spawnCli } from './cli-process.js';
import { LOCAL_MODEL_CATALOG, LOCAL_PROVIDERS, recommendLocalModels } from '../shared/local-providers.js';
import { scanHardware } from './hardware.js';

// Local runtimes: Ollama (models downloaded and removed from the app) and LM Studio
// (models managed in LM Studio, used through its OpenAI-compatible server).

const home = os.homedir();
const isWindows = process.platform === 'win32';
const PROBE_TIMEOUT_MS = 2500;
const GB = 1e9;

/** OLLAMA_HOST may be "0.0.0.0:11434", "localhost" or a full URL. */
export function ollamaUrl(host = process.env.OLLAMA_HOST) {
  if (!host) return LOCAL_PROVIDERS.ollama.baseUrl;
  let value = host.trim();
  if (!/^https?:\/\//.test(value)) value = `http://${value}`;
  try {
    const url = new URL(value);
    if (url.hostname === '0.0.0.0' || url.hostname === '::' || url.hostname === '[::]') url.hostname = '127.0.0.1';
    if (!url.port && !/^https?:\/\/[^/]+:\d+/.test(value)) url.port = '11434';
    return url.origin;
  } catch {
    return LOCAL_PROVIDERS.ollama.baseUrl;
  }
}

LOCAL_PROVIDERS.ollama.baseUrl = ollamaUrl();
if (process.env.LMSTUDIO_URL) LOCAL_PROVIDERS.lmstudio.baseUrl = process.env.LMSTUDIO_URL.replace(/\/+$/, '');

const OLLAMA_LOCATIONS = isWindows
  ? [path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Ollama', 'ollama.exe')]
  : ['/usr/local/bin/ollama', '/usr/bin/ollama', '/opt/homebrew/bin/ollama', path.join(home, '.local', 'bin', 'ollama'), '/Applications/Ollama.app/Contents/Resources/ollama'];
const LMS_LOCATIONS = [path.join(home, '.lmstudio', 'bin', isWindows ? 'lms.exe' : 'lms'), path.join(home, '.cache', 'lm-studio', 'bin', isWindows ? 'lms.exe' : 'lms')];

const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

export function ollamaBin(env = process.env) {
  if (env.OLLAMA_BIN) return env.OLLAMA_BIN;
  return findOnPath('ollama', { env }) || OLLAMA_LOCATIONS.find(isFile) || null;
}

export function lmsBin(env = process.env) {
  if (env.LMS_BIN) return env.LMS_BIN;
  return findOnPath('lms', { env }) || LMS_LOCATIONS.find(isFile) || null;
}

// LM Studio keeps its data in ~/.lmstudio even when the CLI was never bootstrapped.
const lmstudioInstalled = () => Boolean(lmsBin()) || fs.existsSync(path.join(home, '.lmstudio'));

async function getJson(url, { timeoutMs = PROBE_TIMEOUT_MS, ...init } = {}) {
  const response = await fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(timeoutMs) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body?.error?.message || body?.error || `HTTP ${response.status}`), { status: response.status });
  return body;
}

/** Installed models of the running Ollama, or null when it does not answer. */
export async function ollamaModels() {
  try {
    const body = await getJson(`${LOCAL_PROVIDERS.ollama.baseUrl}/api/tags`);
    return (body.models || []).map((model) => ({
      id: model.name || model.model,
      sizeGb: Math.round(((model.size || 0) / GB) * 10) / 10,
      parameterSize: model.details?.parameter_size || null,
      quantization: model.details?.quantization_level || null,
      // Cloud models run on ollama.com, not here.
      remote: Boolean(model.remote_host) || /-cloud$|:cloud$/.test(model.name || ''),
    })).filter((model) => model.id);
  } catch {
    return null;
  }
}

/** Models loaded in memory and how much of each sits in video memory. */
async function ollamaLoaded() {
  try {
    const body = await getJson(`${LOCAL_PROVIDERS.ollama.baseUrl}/api/ps`);
    return (body.models || []).map((model) => ({
      id: model.name,
      gpuShare: model.size ? Math.round(((model.size_vram || 0) / model.size) * 100) : 0,
    }));
  } catch {
    return [];
  }
}

/** Chat models the LM Studio server lists, or null when it is not running. */
export async function lmstudioModels() {
  try {
    const body = await getJson(`${LOCAL_PROVIDERS.lmstudio.baseUrl}/models`);
    return (body.data || []).map((model) => model.id).filter((id) => id && !/embed/i.test(id));
  } catch {
    return null;
  }
}

const unavailable = (reason, extra = {}) => ({ status: 'unavailable', reason, ...extra });

/** Provider availability (see server/provider-availability.js) of Ollama. */
export async function checkOllama() {
  const models = await ollamaModels();
  if (!models) {
    if (!ollamaBin()) return unavailable('O Ollama não está instalado neste computador.', { installed: false, setup: 'local' });
    return unavailable('O Ollama está instalado, mas não está rodando. Inicie em Modelos locais.', { installed: true, running: false, setup: 'local' });
  }
  const usable = models.filter((model) => !model.remote);
  if (!usable.length) return unavailable('Nenhum modelo baixado no Ollama. Baixe um em Modelos locais.', { installed: true, running: true, setup: 'local' });
  return {
    status: 'available', installed: true, running: true,
    models: usable.map((model) => model.id),
    catalog: usable.map((model) => ({ id: model.id, name: `${model.id}${model.sizeGb ? ` · ${model.sizeGb} GB` : ''}` })),
  };
}

/** Provider availability of LM Studio. */
export async function checkLmstudio() {
  const models = await lmstudioModels();
  if (!models) {
    if (!lmstudioInstalled()) return unavailable('O LM Studio não está instalado neste computador.', { installed: false, setup: 'local' });
    return unavailable('O LM Studio está instalado, mas o servidor local está desligado. Ligue em Modelos locais ou no LM Studio (Developer → Start Server).',
      { installed: true, running: false, setup: 'local' });
  }
  if (!models.length) return unavailable('Nenhum modelo baixado no LM Studio.', { installed: true, running: true, setup: 'local' });
  return { status: 'available', installed: true, running: true, models, catalog: models.map((id) => ({ id, name: id })) };
}

// Tags the app pulls must look like Ollama names; nothing else reaches the API.
const MODEL_NAME = /^[\w.-]+(\/[\w.-]+)?(:[\w.-]+)?$/;
export const isModelName = (id) => typeof id === 'string' && id.length <= 200 && MODEL_NAME.test(id)
  && !id.includes('..') && !/^[.-]/.test(id);

/**
 * Hardware scan, catalog recommendations, runtime status and Ollama downloads.
 * `onChange` fires on download progress and whenever the installed models change.
 */
export function createLocalModels({ onChange = () => {}, scan = scanHardware, log = console } = {}) {
  let hardware = null;
  let scanning = null;
  const pulls = new Map();
  let ollamaProcess = null;
  let lastEmit = 0;

  function hardwareScan(force = false) {
    if (hardware && !force) return Promise.resolve(hardware);
    if (!scanning) {
      scanning = scan().then((result) => { hardware = result; return result; })
        .catch((error) => {
          log.warn?.(`[LocalAI] Hardware scan failed: ${error.message}`);
          hardware = { ramGb: Math.round(os.totalmem() / 1024 ** 3), cores: os.cpus().length, gpus: [], error: error.message };
          return hardware;
        })
        .finally(() => { scanning = null; });
    }
    return scanning;
  }

  const pullState = () => Object.fromEntries([...pulls].map(([id, { controller, ...state }]) => [id, state]));

  function emit(force = false) {
    const now = Date.now();
    if (!force && now - lastEmit < 300) return;
    lastEmit = now;
    // A forced update means the installed models may have changed, not just a progress tick.
    onChange({ pulls: pullState(), settled: force });
  }

  async function status({ rescan = false } = {}) {
    const [hw, installed, loaded, lmModels] = await Promise.all([hardwareScan(rescan), ollamaModels(), ollamaLoaded(), lmstudioModels()]);
    const have = new Set((installed || []).map((model) => model.id));
    const catalog = recommendLocalModels(hw, LOCAL_MODEL_CATALOG).map((model) => ({
      ...model, installed: have.has(model.id) || have.has(`${model.id}:latest`),
    }));
    return {
      hardware: hw,
      catalog,
      ollama: {
        installed: Boolean(ollamaBin()) || Boolean(installed),
        running: Boolean(installed),
        url: LOCAL_PROVIDERS.ollama.baseUrl,
        models: (installed || []).map((model) => ({ ...model, gpuShare: loaded.find((entry) => entry.id === model.id)?.gpuShare ?? null })),
        startedByApp: Boolean(ollamaProcess),
      },
      lmstudio: { installed: lmstudioInstalled() || Boolean(lmModels), running: Boolean(lmModels), url: LOCAL_PROVIDERS.lmstudio.baseUrl, models: lmModels || [] },
      pulls: pullState(),
    };
  }

  async function pull(id) {
    if (!isModelName(id)) throw Object.assign(new Error('Nome de modelo inválido.'), { status: 400 });
    if (pulls.get(id)?.status === 'downloading') return;
    const controller = new AbortController();
    pulls.set(id, { status: 'downloading', completed: 0, total: 0, detail: 'Iniciando…', controller });
    emit(true);
    try {
      const response = await fetch(`${LOCAL_PROVIDERS.ollama.baseUrl}/api/pull`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: id, stream: true }), signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      // Each layer reports its own total; the biggest one is the weights, so it drives the bar.
      for await (const event of readNdjson(response.body)) {
        if (event.error) throw new Error(event.error);
        const entry = pulls.get(id);
        if (!entry || entry.controller !== controller) return;
        if (event.total && event.total >= entry.total) Object.assign(entry, { total: event.total, completed: event.completed || 0 });
        entry.detail = event.status || entry.detail;
        emit();
      }
      pulls.delete(id);
      log.log?.(`[LocalAI] Downloaded ${id}`);
    } catch (error) {
      if (pulls.get(id)?.controller !== controller) return;
      if (controller.signal.aborted) pulls.delete(id);
      else {
        log.warn?.(`[LocalAI] Download of ${id} failed: ${error.message}`);
        pulls.set(id, { status: 'error', error: error.cause?.code === 'ECONNREFUSED' ? 'O Ollama não está rodando.' : error.message });
      }
    }
    emit(true);
  }

  function cancel(id) {
    const entry = pulls.get(id);
    entry?.controller?.abort();
    pulls.delete(id);
    emit(true);
  }

  async function remove(id) {
    if (!isModelName(id)) throw Object.assign(new Error('Nome de modelo inválido.'), { status: 400 });
    const response = await fetch(`${LOCAL_PROVIDERS.ollama.baseUrl}/api/delete`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: id }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok && response.status !== 404) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    emit(true);
  }

  /** Starts `ollama serve` (or `lms server start`) and waits until it answers. */
  async function start(runtime) {
    if (runtime === 'lmstudio') {
      const bin = lmsBin();
      if (!bin) throw Object.assign(new Error('Não encontrei o comando "lms". Abra o LM Studio uma vez ou ligue o servidor nele.'), { status: 400 });
      await new Promise((resolve) => {
        const child = spawnCli(bin, ['server', 'start'], { stdio: 'ignore' });
        child.on('error', resolve);
        child.on('close', resolve);
        setTimeout(() => { killProcessTree(child); resolve(); }, 20000).unref();
      });
      if (!(await waitFor(lmstudioModels))) throw new Error('O servidor do LM Studio não respondeu.');
      emit(true);
      return;
    }
    const bin = ollamaBin();
    if (!bin || !cliAvailable(bin)) throw Object.assign(new Error('O Ollama não está instalado.'), { status: 400 });
    if (await ollamaModels()) return;
    if (!ollamaProcess) {
      log.log?.(`[LocalAI] Starting ${bin} serve`);
      const child = spawnCli(bin, ['serve'], { stdio: 'ignore', env: process.env });
      ollamaProcess = child;
      child.on('error', (error) => log.warn?.(`[LocalAI] ollama serve: ${error.message}`));
      child.on('close', () => { if (ollamaProcess === child) ollamaProcess = null; emit(true); });
    }
    if (!(await waitFor(ollamaModels))) throw new Error('O Ollama não respondeu depois de iniciado.');
    emit(true);
  }

  function close() {
    for (const id of [...pulls.keys()]) pulls.get(id)?.controller?.abort();
    killProcessTree(ollamaProcess);
    ollamaProcess = null;
  }

  return { status, hardware: hardwareScan, pull, cancel, remove, start, close };
}

async function waitFor(probe, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/** JSON objects of a newline-delimited stream (Ollama's streaming responses). */
export async function* readNdjson(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try { yield JSON.parse(line); } catch {}
    }
  }
  const rest = (buffer + decoder.decode()).trim();
  if (rest) {
    try { yield JSON.parse(rest); } catch {}
  }
}
