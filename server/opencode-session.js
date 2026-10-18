import { randomBytes } from 'node:crypto';
import readline from 'node:readline';
import { normalizeImages, imageDataUrl } from './agent-images.js';
import { AGENT_SYSTEM_PROMPT } from './agent-prompt.js';
import { agentWorkspace, killProcessTree, resolveCliBin, spawnCli } from './cli-process.js';
import { providerKeys } from './provider-keys.js';
import { readSse } from './sse.js';

// OpenCode runs as a local server (`opencode serve`) kept warm between turns: each
// conversation is an OpenCode session, prompts go over HTTP and the reply streams
// back through the server's event feed. Models are "<provider>/<model>" as
// `opencode models` lists them, so every provider configured in OpenCode works,
// plus the ones whose API key was saved in this app.
const START_TIMEOUT_MS = 30000;
const AGENT = 'interviewai';
// OpenCode's own models (opencode/…, the free tier included) only answer requests
// from OpenCode's default agent, so they keep it; every other provider gets a
// text-only agent with the copilot's short system prompt and no tools.
const DEFAULT_AGENT = 'build';
const CONFIG = {
  agent: { [AGENT]: { mode: 'primary', description: 'InterviewAI copilot', prompt: AGENT_SYSTEM_PROMPT, tools: { '*': false } } },
};

let server = null;
let warmSession = null;

/** "<provider>/<model>" → { providerID, modelID }; the model id itself may contain slashes. */
export function parseOpencodeModel(model = '') {
  const index = model.indexOf('/');
  if (index <= 0 || index === model.length - 1) return null;
  return { providerID: model.slice(0, index), modelID: model.slice(index + 1) };
}

export const opencodeAgentFor = (model) => (parseOpencodeModel(model)?.providerID === 'opencode' ? DEFAULT_AGENT : AGENT);

/** Environment for the OpenCode CLI: the saved API keys and the copilot agent. */
export function opencodeEnv(extra = {}) {
  return { ...process.env, ...providerKeys.opencodeEnv(), OPENCODE_CONFIG_CONTENT: JSON.stringify(CONFIG), ...extra };
}

function disposeServer(target, error = new Error('Servidor do OpenCode encerrado')) {
  if (!target || target.disposed) return;
  target.disposed = true;
  target.rejectReady?.(error);
  target.events?.abort();
  target.reader?.close();
  for (const session of target.sessions.values()) session.active?.fail(error);
  target.sessions.clear();
  killProcessTree(target.child);
  if (server === target) server = null;
  if (warmSession?.server === target) warmSession = null;
}

export function closeOpencodeSession() { disposeServer(server); }

function getServer() {
  const keysKey = JSON.stringify(providerKeys.opencodeEnv());
  // New keys need a restart, but never in the middle of an answer.
  if (server && !server.disposed && (server.keysKey === keysKey || [...server.sessions.values()].some((s) => s.active))) return server;
  disposeServer(server);
  const password = randomBytes(24).toString('hex');
  const child = spawnCli(resolveCliBin('opencode'), ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: agentWorkspace(), stdio: ['ignore', 'pipe', 'pipe'], env: opencodeEnv({ OPENCODE_SERVER_PASSWORD: password }),
  });
  const target = { child, keysKey, disposed: false, sessions: new Map(),
    auth: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
  server = target;
  target.ready = new Promise((resolve, reject) => {
    target.rejectReady = reject;
    const timer = setTimeout(() => disposeServer(target, new Error('O OpenCode demorou demais para iniciar')), START_TIMEOUT_MS);
    timer.unref();
    target.reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    target.reader.on('line', (line) => {
      const url = line.match(/listening on (https?:\/\/\S+)/)?.[1];
      if (!url || target.url) return;
      clearTimeout(timer);
      target.url = url.replace(/\/$/, '');
      subscribe(target).then(() => resolve(target), (error) => disposeServer(target, error));
    });
  });
  target.ready.catch(() => {});
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  child.on('error', (error) => disposeServer(target, error));
  child.on('close', (code) => disposeServer(target,
    new Error(`O OpenCode encerrou (código ${code})${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`)));
  return target;
}

async function request(target, method, path, body) {
  const response = await fetch(`${target.url}${path}`, {
    method,
    headers: { Authorization: target.auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenCode: ${method} ${path} falhou (${response.status})${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
  }
  return response.status === 204 ? null : response.json().catch(() => null);
}

// One event feed per server. Resolves once it is connected, so a prompt sent after
// that never misses the start of its reply.
async function subscribe(target) {
  const controller = new AbortController();
  target.events = controller;
  const response = await fetch(`${target.url}/event`, { headers: { Authorization: target.auth }, signal: controller.signal });
  if (!response.ok) throw new Error(`OpenCode: não foi possível acompanhar os eventos (${response.status})`);
  (async () => {
    try {
      for await (const event of readSse(response.body)) {
        const sessionID = event.properties?.sessionID || event.properties?.info?.sessionID || event.properties?.part?.sessionID;
        target.sessions.get(sessionID)?.active?.handle(event);
      }
      if (!target.disposed) disposeServer(target, new Error('O OpenCode encerrou o feed de eventos'));
    } catch (error) {
      if (!target.disposed) disposeServer(target, error);
    }
  })();
}

// A prepared session (no turn yet) is reused by the next turn with the same model;
// a conversation id resumes that OpenCode session.
async function getSession({ conversationId, model, isolated = false }, reusePrepared = false) {
  if (!parseOpencodeModel(model)) throw new Error('Escolha um modelo do OpenCode no formato provedor/modelo.');
  const target = getServer();
  await target.ready;
  if (!isolated && warmSession && warmSession.server === target && !warmSession.active && warmSession.model === model
    && (conversationId ? warmSession.id === conversationId : (reusePrepared || warmSession.prepared))) return warmSession;
  const id = conversationId || (await request(target, 'POST', '/session', { title: 'InterviewAI' }))?.id;
  if (!id) throw new Error('O OpenCode não retornou o ID da sessão');
  const session = { id, model, server: target, prepared: true, active: null };
  if (!isolated) {
    if (warmSession && !warmSession.active) warmSession.server.sessions.delete(warmSession.id);
    warmSession = session;
  }
  target.sessions.set(id, session);
  return session;
}

export async function prepareOpencodeSession(options = {}) {
  const session = await getSession(options, true);
  return { pid: session.server.child.pid, conversationId: session.id };
}

export function runOpencodeAgent({ prompt, images, onMessage, onError, onClose, ...options }) {
  const turn = { done: false, text: '', startedAt: Date.now(), assistant: new Set(), parts: new Map(), usage: null, session: null };
  const emit = (delta) => {
    turn.text += delta;
    onMessage?.({ event: 'step_update', step_update: { conversation_id: turn.session.id, text_delta: delta } });
  };
  const end = () => {
    turn.done = true;
    if (turn.session?.active === turn) turn.session.active = null;
    if (options.isolated) turn.session?.server.sessions.delete(turn.session.id);
  };
  turn.fail = (error) => {
    if (turn.done) return;
    end();
    onError?.(error);
  };
  turn.handle = (event) => {
    if (turn.done) return;
    const props = event.properties || {};
    if (event.type === 'message.updated' && props.info?.role === 'assistant') {
      turn.assistant.add(props.info.id);
      if (props.info.error) turn.fail(new Error(`OpenCode: ${props.info.error.data?.message || props.info.error.name}`));
      return;
    }
    if (event.type === 'message.part.updated') {
      const part = props.part;
      if (!part || !turn.assistant.has(part.messageID)) return;
      const known = turn.parts.get(part.id) || { type: part.type, length: 0 };
      turn.parts.set(part.id, known);
      // Providers that do not stream deliver the whole text in the final update.
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length > known.length) {
        emit(part.text.slice(known.length));
        known.length = part.text.length;
      }
      if (part.type === 'tool') {
        onMessage?.({ event: 'step_update', step_update: { conversation_id: turn.session.id,
          step_type: part.tool, details: part, state: part.state?.status === 'completed' ? 'completed' : 'active' } });
      }
      if (part.type === 'step-finish' && part.tokens) turn.usage = part.tokens;
      return;
    }
    if (event.type === 'message.part.delta') {
      const known = turn.parts.get(props.partID);
      if (!known || known.type !== 'text' || props.field !== 'text' || typeof props.delta !== 'string') return;
      known.length += props.delta.length;
      emit(props.delta);
      return;
    }
    if (event.type === 'session.error') {
      turn.fail(new Error(`OpenCode: ${props.error?.data?.message || props.error?.name || 'erro na sessão'}`));
      return;
    }
    if (/^(permission|question)\.(asked|updated)$/.test(event.type)) {
      // Unattended voice turns cannot answer an approval prompt.
      request(turn.session.server, 'POST', `/session/${turn.session.id}/abort`).catch(() => {});
      turn.fail(new Error('O OpenCode pediu uma confirmação que o copiloto não pode responder.'));
      return;
    }
    if (event.type === 'session.idle' && turn.assistant.size) {
      const usage = turn.usage;
      onMessage?.({ event: 'result', result: { conversation_id: turn.session.id, response: turn.text,
        duration_seconds: (Date.now() - turn.startedAt) / 1000,
        usage: usage && { input_tokens: usage.input, output_tokens: usage.output, cached_input_tokens: usage.cache?.read,
          total_tokens: usage.total ?? (usage.input || 0) + (usage.output || 0) } } });
      end();
      onClose?.(0);
    }
  };

  (async () => {
    const session = await getSession(options);
    if (turn.done) return;
    if (session.active) throw new Error('O OpenCode ainda está respondendo a pergunta anterior.');
    turn.session = session;
    session.prepared = false;
    session.active = turn;
    onMessage?.({ event: 'session_started', conversation_id: session.id });
    const files = normalizeImages(images).map((image, index) => ({
      type: 'file', mime: image.mimeType, url: imageDataUrl(image), filename: `captura-${index + 1}.${image.mimeType.split('/')[1] || 'png'}`,
    }));
    await request(session.server, 'POST', `/session/${session.id}/prompt_async`, {
      agent: opencodeAgentFor(options.model),
      model: parseOpencodeModel(options.model),
      parts: [...files, { type: 'text', text: prompt }],
    });
  })().catch((error) => turn.fail(error));

  return {
    kill() {
      if (turn.done) return;
      const session = turn.session;
      end();
      if (session) request(session.server, 'POST', `/session/${session.id}/abort`).catch(() => {});
    },
  };
}
