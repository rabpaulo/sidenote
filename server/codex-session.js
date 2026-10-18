import readline from 'node:readline';
import { imageDataUrl, normalizeImages } from './agent-images.js';
import { AGENT_SYSTEM_PROMPT } from './agent-prompt.js';
import { killProcessTree, resolveCliBin, spawnCli } from './cli-process.js';

let warmSession = null;

function dispose(session, error = new Error('Sessão Codex encerrada')) {
  if (!session || session.disposed) return;
  session.disposed = true;
  if (session.active) session.active.done = true;
  session.active = null;
  for (const pending of session.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  session.pending.clear();
  session.reader?.close();
  killProcessTree(session.child);
  if (warmSession === session) warmSession = null;
}

export function closeCodexSession() { dispose(warmSession); }

// A cancelled or failed turn takes its CLI process with it. Starting the
// replacement right away keeps the next question from waiting for a cold start.
function rewarm(session) {
  if (session.isolated) return;
  setImmediate(() => {
    if (warmSession && !warmSession.disposed) return;
    try { getSession({ ...session.options, conversationId: session.conversationId }, true); } catch {}
  });
}

// An isolated session serves a single turn and never replaces the warm session.
function getSession({ conversationId, model = 'gpt-6-luna', reasoningEffort = 'medium', fastMode = true, cwd = process.cwd(), isolated = false }, reusePrepared = false) {
  const bin = resolveCliBin('codex');
  const key = JSON.stringify([bin, cwd, model, reasoningEffort, fastMode]);
  let session = warmSession;
  if (!isolated) {
    if (session && !session.disposed && !session.active && session.key === key
      && (conversationId ? session.conversationId === conversationId : (reusePrepared || session.prepared))) return session;
    dispose(session);
  }
  const child = spawnCli(bin, ['app-server', '--listen', 'stdio://',
    '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"'], {
    cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PAGER: 'cat' },
  });
  session = { child, key, conversationId, disposed: false, prepared: true, active: null, pending: new Map(), nextId: 0,
    isolated, options: { model, reasoningEffort, fastMode, cwd } };
  if (!isolated) warmSession = session;
  const send = (message) => {
    if (session.disposed) throw new Error('Sessão Codex encerrada');
    child.stdin.write(JSON.stringify(message) + '\n');
  };
  session.rpc = (method, params) => new Promise((resolve, reject) => {
    if (session.disposed) return reject(new Error('Sessão Codex encerrada'));
    const id = ++session.nextId;
    const timer = setTimeout(() => fail(new Error(`Codex: tempo esgotado em ${method}`)), 30000);
    timer.unref();
    session.pending.set(id, { resolve, reject, timer });
    try { send({ id, method, params }); }
    catch (error) { fail(error); }
  });
  const fail = (error) => {
    if (session.disposed) return;
    const turn = session.active;
    dispose(session, error);
    turn?.onError?.(error);
    if (turn) rewarm(session);
  };
  session.reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  session.reader.on('line', (line) => {
    if (session.disposed || !line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && !message.method) {
      const pending = session.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      session.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'Erro no Codex'));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      // Unexpected interactive requests must not hang an unattended voice turn.
      send({ id: message.id, error: { code: -32601, message: 'Interação não disponível no copiloto' } });
      fail(new Error(`Codex requer interação: ${message.method}`));
      return;
    }
    const turn = session.active;
    const params = message.params || {};
    if (!turn || params.threadId !== session.conversationId) return;
    const turnId = params.turnId || params.turn?.id;
    if (turn.id && turnId && turn.id !== turnId) return;
    if (message.method === 'turn/started') turn.id = params.turn.id;
    if (message.method === 'thread/tokenUsage/updated') turn.usage = params.tokenUsage?.last;
    if (message.method === 'item/agentMessage/delta') {
      turn.text += params.delta;
      turn.streamed.add(params.itemId);
      turn.onMessage?.({ event: 'step_update', step_update: { conversation_id: session.conversationId, text_delta: params.delta } });
    }
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = params.item;
      if (item?.type === 'agentMessage') {
        if (message.method === 'item/completed' && item.text && !turn.streamed.has(item.id)) {
          turn.text += item.text;
          turn.onMessage?.({ event: 'step_update', step_update: { conversation_id: session.conversationId, text_delta: item.text } });
        }
      } else if (item && item.type !== 'userMessage') {
        turn.onMessage?.({ event: 'step_update', step_update: { conversation_id: session.conversationId,
          step_type: item.type, details: item, state: message.method === 'item/completed' ? 'completed' : 'active' } });
      }
    }
    if (message.method === 'error' && !params.willRetry) fail(new Error(params.error?.message || 'Erro no Codex'));
    if (message.method !== 'turn/completed') return;
    if (params.turn.status !== 'completed') {
      fail(new Error(params.turn.error?.message || `Codex: ${params.turn.status}`));
      return;
    }
    const usage = turn.usage;
    turn.onMessage?.({ event: 'result', result: { conversation_id: session.conversationId, response: turn.text,
      duration_seconds: (Date.now() - turn.startedAt) / 1000,
      usage: usage && { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
        cached_input_tokens: usage.cachedInputTokens, total_tokens: usage.totalTokens } } });
    if (session.active !== turn || session.disposed) return;
    turn.done = true;
    session.active = null;
    turn.onClose?.(0);
  });
  child.stderr.on('data', (chunk) => {
    if (!session.disposed) session.active?.onMessage?.({ event: 'agent_stderr', text: chunk.toString() });
  });
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('close', (code) => fail(new Error(`Codex encerrou a sessão (código ${code})`)));
  session.ready = (async () => {
    await session.rpc('initialize', { clientInfo: { name: 'interviewai', title: 'InterviewAI', version: '1.0.0' } });
    send({ method: 'initialized', params: {} });
    const result = await session.rpc(conversationId ? 'thread/resume' : 'thread/start', {
      ...(conversationId ? { threadId: conversationId } : {}), model, cwd,
      approvalPolicy: 'never', sandbox: 'danger-full-access', serviceTier: fastMode ? 'fast' : 'default',
      // A short system prompt instead of the coding-agent one: answers are plain text.
      baseInstructions: AGENT_SYSTEM_PROMPT,
      config: { model_reasoning_effort: reasoningEffort },
    });
    if (!result?.thread?.id) throw new Error('Codex não retornou o ID da thread');
    session.conversationId = result.thread.id;
    return { pid: child.pid, conversationId: session.conversationId };
  })();
  session.ready.catch(fail);
  return session;
}

export function prepareCodexSession(options = {}) {
  try { return getSession(options, true).ready; }
  catch (error) { return Promise.reject(error); }
}

export function runCodexAgent({ prompt, images, onMessage, onError, onClose, ...options }) {
  let session;
  try { session = getSession(options); }
  catch (error) {
    queueMicrotask(() => onError?.(error));
    return { kill() {} };
  }
  session.prepared = false;
  if (options.isolated) {
    const close = onClose;
    onClose = (code) => { dispose(session); close?.(code); };
  }
  const turn = { onMessage, onError, onClose, done: false, text: '', streamed: new Set(), startedAt: Date.now() };
  session.active = turn;
  session.ready.then(async () => {
    if (session.disposed || session.active !== turn) return;
    onMessage?.({ event: 'session_started', conversation_id: session.conversationId });
    const result = await session.rpc('turn/start', { threadId: session.conversationId,
      input: [...normalizeImages(images).map((image) => ({ type: 'image', url: imageDataUrl(image) })),
        { type: 'text', text: prompt }], effort: options.reasoningEffort || 'medium' });
    if (session.active === turn && !turn.done) turn.id = result.turn.id;
  }).catch((error) => {
    if (turn.done || session.disposed) return;
    dispose(session, error);
    onError?.(error);
    rewarm(session);
  });
  return {
    pid: session.child.pid,
    kill() {
      if (turn.done || session.active !== turn) return;
      dispose(session);
      rewarm(session);
    },
  };
}
