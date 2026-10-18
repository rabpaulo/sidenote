import readline from 'readline';
import { runCodexAgent, prepareCodexSession, closeCodexSession } from './codex-session.js';
import { runClaudeAgent, prepareClaudeSession, closeClaudeSession } from './claude-session.js';
import { normalizeImages, promptWithImageFiles, writeImageFiles } from './agent-images.js';
import { killProcessTree, resolveCliBin, spawnCli } from './cli-process.js';
import { runOpencodeAgent, prepareOpencodeSession, closeOpencodeSession } from './opencode-session.js';
import { runApiAgent, prepareApiSession } from './api-session.js';
import { isApiProvider } from '../shared/api-providers.js';
export { runCodexAgent, closeCodexSession } from './codex-session.js';
export { runClaudeAgent, closeClaudeSession } from './claude-session.js';

let warmAgySession = null;
// Started processes waiting for a one-shot turn (see takeAgySession).
const AGY_POOL_SIZE = 2;
let agyPool = [];

function disposeAgySession(session) {
  if (!session || session.disposed) return;
  session.disposed = true;
  if (session.active) session.active.done = true;
  session.active = null;
  clearTimeout(session.readyTimer);
  session.rejectReady?.(new Error('Sessão encerrada'));
  session.reader?.close();
  killProcessTree(session.child);
  if (warmAgySession === session) warmAgySession = null;
}

export function closeAgySession() {
  disposeAgySession(warmAgySession);
  for (const session of agyPool) disposeAgySession(session);
  agyPool = [];
}

// A cancelled or failed turn takes its CLI process with it. Starting the
// replacement right away keeps the next question from waiting for a cold start.
function rewarmAgySession(session) {
  if (session.isolated) return;
  setImmediate(() => {
    if (warmAgySession && !warmAgySession.disposed) return;
    try { getAgySession({ ...session.options, conversationId: session.conversationId }, true); } catch {}
  });
}

process.on('exit', closeAgySession);
process.on('exit', closeCodexSession);
process.on('exit', closeClaudeSession);
process.on('exit', closeOpencodeSession);

function agySessionKey({ model = 'gemini-3.8-flash', reasoningEffort = 'high', cwd = process.cwd() }) {
  return JSON.stringify([resolveCliBin('agy'), cwd, model, reasoningEffort]);
}

/** Start the CLI without submitting a model turn. */
// An isolated session serves a single turn and never replaces the warm session.
function getAgySession({ conversationId, model = 'gemini-3.8-flash', reasoningEffort = 'high', cwd = process.cwd(), isolated = false }, reusePrepared = false) {
  const agyBin = resolveCliBin('agy');

  const key = agySessionKey({ model, reasoningEffort, cwd });
  let session = warmAgySession;
  if (isolated || !session || session.disposed || session.active || session.key !== key
    || (conversationId ? session.conversationId !== conversationId : !(reusePrepared || session.prepared))) {
    if (!isolated) disposeAgySession(session);
    const args = [
      '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--dangerously-skip-permissions', '--disable-slash-commands',
    ];
    if (model) args.push('--model', model);
    if (reasoningEffort) args.push('--effort', reasoningEffort);
    if (conversationId) args.push('--conversation', conversationId);
    console.log(`[AGY] Starting streaming session (model=${model}, effort=${reasoningEffort})`);
    const child = spawnCli(agyBin, args, {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PAGER: 'cat' },
    });
    session = { child, key, conversationId, active: null, disposed: false, prepared: true,
      isolated, options: { model, reasoningEffort, cwd } };
    session.ready = new Promise((resolve, reject) => { session.resolveReady = resolve; session.rejectReady = reject; });
    session.ready.catch(() => {});
    if (!isolated) warmAgySession = session;
    const current = session;
    const fail = (error) => {
      if (current.disposed) return;
      const turn = current.active;
      current.rejectReady(error);
      disposeAgySession(current);
      turn?.onError?.(error);
      if (turn) rewarmAgySession(current);
    };
    current.reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    current.reader.on('line', (line) => {
      if (current.disposed || !line.trim()) return;
      let data;
      try { data = JSON.parse(line); }
      catch { data = { event: 'raw_log', text: line }; }
      const id = data.conversation_id || data.step_update?.conversation_id || data.result?.conversation_id;
      if (id) current.conversationId = id;
      if (data.event === 'init') {
        current.started = true;
        clearTimeout(current.readyTimer);
        current.resolveReady({ pid: child.pid, conversationId: current.conversationId });
      }
      const turn = current.active;
      if (!turn) return;
      if (data.event === 'result' && (data.result?.error || data.result?.status !== 'SUCCESS')) {
        fail(new Error(data.result?.error || `Antigravity: ${data.result?.status || 'resultado inválido'}`));
        return;
      }
      if (data.event === 'result') {
        // The CLI reports cumulative session counters. The app displays each
        // response's own time and usage, excluding time spent waiting for input.
        const cumulativeUsage = data.result.usage;
        const usage = cumulativeUsage && Object.fromEntries(Object.entries(cumulativeUsage).map(([name, value]) => [
          name, typeof value === 'number' ? Math.max(0, value - (current.lastUsage?.[name] || 0)) : value,
        ]));
        current.lastUsage = cumulativeUsage;
        data = { ...data, result: { ...data.result, usage, duration_seconds: (Date.now() - turn.startedAt) / 1000 } };
      }
      turn.onMessage?.(data);
      if (data.event === 'result' && current.active === turn) {
        turn.done = true;
        current.active = null;
        turn.onClose?.(0);
      }
    });
    child.stderr.on('data', (chunk) => {
      if (!current.disposed) current.active?.onMessage?.({ event: 'agent_stderr', text: chunk.toString() });
    });
    current.readyTimer = setTimeout(() => fail(new Error('Antigravity demorou demais para iniciar')), 30000);
    current.readyTimer.unref();
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('close', (code) => {
      if (!current.disposed) fail(new Error(`Antigravity encerrou antes de concluir a resposta (código ${code})`));
    });
  } else {
    console.log('[AGY] Reusing streaming session');
  }
  return session;
}

function fillAgyPool(options) {
  const key = agySessionKey(options);
  agyPool = agyPool.filter((session) => {
    if (session.disposed) return false;
    if (session.key === key) return true;
    disposeAgySession(session);
    return false;
  });
  while (agyPool.length < AGY_POOL_SIZE) agyPool.push(getAgySession({ ...options, conversationId: null, isolated: true }));
}

// A one-shot turn runs outside the conversation in an already started process, so
// cancelling an outdated answer costs that process instead of a cold start (about
// 4 s) before the next answer can begin.
function takeAgySession(options) {
  const key = agySessionKey(options);
  const usable = agyPool.filter((session) => !session.disposed && session.key === key);
  const session = usable.find((candidate) => candidate.started) || usable[0];
  if (session) agyPool = agyPool.filter((candidate) => candidate !== session);
  setImmediate(() => { try { fillAgyPool(options); } catch {} });
  return session || getAgySession({ ...options, conversationId: null, isolated: true });
}

export function prepareAgySession(options = {}) {
  try { return getAgySession(options, true).ready; }
  catch (error) { return Promise.reject(error); }
}

export function runAgyAgent({ onMessage, onError, onClose, prompt, images, ...options }) {
  let session;
  try {
    // The Antigravity stream accepts only text blocks, so the agent opens image files itself.
    prompt = promptWithImageFiles(prompt, writeImageFiles(normalizeImages(images)));
    session = options.oneShot ? takeAgySession(options) : getAgySession(options);
  }
  catch (error) {
    queueMicrotask(() => onError?.(error));
    return { kill() {} };
  }
  session.prepared = false;
  if (session.isolated) {
    const close = onClose;
    onClose = (code) => { disposeAgySession(session); close?.(code); };
  }
  const turn = { onMessage, onError, onClose, done: false, startedAt: Date.now() };
  session.active = turn;
  session.child.stdin.write(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
  return {
    pid: session.child.pid,
    kill() {
      // An old completed handle must never cancel a newer turn on this process.
      if (turn.done || session.active !== turn) return;
      disposeAgySession(session);
      rewarmAgySession(session);
    },
  };
}

export function prepareAgentSession(options) {
  if (options.provider === 'codex') return prepareCodexSession(options);
  if (options.provider === 'claude') return prepareClaudeSession(options);
  if (options.provider === 'opencode') return prepareOpencodeSession(options);
  if (isApiProvider(options.provider)) return prepareApiSession(options);
  return prepareAgySession(options);
}

// Copilot answers that run as one-shot turns: no conversation to keep, and a
// cancelled answer leaves no cold start behind (warm Antigravity pool, HTTP APIs).
export function runsOneShot(provider) {
  return provider === 'antigravity' || isApiProvider(provider);
}

/** Starts the processes one-shot turns will use, without sending a prompt. */
export function prepareOneShotSessions(options) {
  if (options.provider !== 'antigravity') return;
  try { fillAgyPool(options); } catch {}
}

export function closeAgentSession(provider) {
  if (!provider || provider === 'antigravity') closeAgySession();
  if (!provider || provider === 'codex') closeCodexSession();
  if (!provider || provider === 'claude') closeClaudeSession();
  if (!provider || provider === 'opencode') closeOpencodeSession();
}

/**
 * One prompt in a throwaway CLI process: the warm session and its conversation stay
 * untouched. Resolves with the reply text. `onText` receives the reply so far while it
 * streams; aborting `signal` kills the process and rejects with an AbortError.
 */
export function runIsolatedAgent({ timeoutMs = 120000, onText, signal, ...options }) {
  return new Promise((resolve, reject) => {
    let text = '';
    let finalText = '';
    let settled = false;
    let handle = null;
    const abort = () => finish(Object.assign(new Error('Cancelado'), { name: 'AbortError' }));
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        handle?.kill();
        reject(error);
      } else resolve((finalText || text).trim());
    };
    const timer = setTimeout(() => finish(new Error('O modelo demorou demais para responder.')), timeoutMs);
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort);
    handle = runUnifiedAgent({
      ...options,
      isolated: true,
      onMessage: (data) => {
        if (settled) return;
        const delta = data.step_update?.text_delta ?? data.step_update?.content ?? data.step_update?.text;
        if (typeof delta === 'string' && delta) {
          text += delta;
          onText?.(text);
        }
        if (typeof data.result?.response === 'string') finalText = data.result.response;
      },
      onError: (error) => finish(error),
      onClose: () => finish(),
    });
  });
}

/**
 * Unified runner that dispatches to Antigravity, Codex, Claude Code, OpenCode or an API provider.
 */
export function runUnifiedAgent(options) {
  if (options.provider === 'opencode') return runOpencodeAgent(options);
  if (isApiProvider(options.provider)) return runApiAgent({ ...options, isolated: options.isolated || !!options.oneShot });
  if (options.provider === 'codex') {
    return runCodexAgent(options);
  }
  if (options.provider === 'claude') {
    return runClaudeAgent(options);
  }
  return runAgyAgent(options);
}
