import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { normalizeImages } from './agent-images.js';
import { AGENT_SYSTEM_PROMPT } from './agent-prompt.js';
import { killProcessTree, resolveCliBin, spawnCli } from './cli-process.js';

let warmSession = null;
// IDs assigned with --session-id that have not received a turn yet. Claude only
// persists a session after its first message, so these cannot be resumed.
const unstartedIds = new Set();

function dispose(session, error = new Error('Sessão Claude Code encerrada')) {
  if (!session || session.disposed) return;
  session.disposed = true;
  session.rejectReady?.(error);
  if (session.active) session.active.done = true;
  session.active = null;
  session.reader?.close();
  killProcessTree(session.child);
  if (warmSession === session) warmSession = null;
}

export function closeClaudeSession() { dispose(warmSession); }

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
function getSession({ conversationId, model = 'claude-sonnet-5-5', reasoningEffort = 'medium', cwd = process.cwd(), isolated = false }, reusePrepared = false) {
  const bin = resolveCliBin('claude');
  const key = JSON.stringify([bin, cwd, model, reasoningEffort]);
  let session = warmSession;
  if (!isolated) {
    if (session && !session.disposed && !session.active && session.key === key
      && (conversationId ? session.conversationId === conversationId : (reusePrepared || session.prepared))) return session;
    dispose(session);
  }
  const id = conversationId || randomUUID();
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--dangerously-skip-permissions',
    // Answers are plain text: no tools, MCP servers, plugins, skills or CLAUDE.md,
    // and a short system prompt instead of the coding-agent one, so each turn starts faster.
    '--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--tools', '',
    '--system-prompt', AGENT_SYSTEM_PROMPT];
  if (model) args.push('--model', model);
  if (reasoningEffort) args.push('--effort', reasoningEffort);
  if (conversationId && !unstartedIds.has(id)) args.push('--resume', id);
  else {
    args.push('--session-id', id);
    if (!isolated) unstartedIds.add(id);
  }
  console.log(`[Claude] Starting streaming session (model=${model}, effort=${reasoningEffort})`);
  // An API key in the environment overrides the CLI's subscription login, so drop it.
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...env } = process.env;
  const child = spawnCli(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, PAGER: 'cat' } });
  session = { child, key, conversationId: id, disposed: false, prepared: true, active: null,
    isolated, options: { model, reasoningEffort, cwd } };
  if (!isolated) warmSession = session;
  const current = session;
  const fail = (error) => {
    if (current.disposed) return;
    const turn = current.active;
    dispose(current, error);
    turn?.onError?.(error);
    if (turn) rewarm(current);
  };
  // The CLI prints nothing until it receives input, so a spawned process is ready.
  current.ready = new Promise((resolve, reject) => {
    current.rejectReady = reject;
    child.once('spawn', () => resolve({ pid: child.pid, conversationId: id }));
  });
  current.ready.catch(() => {});
  current.reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  current.reader.on('line', (line) => {
    if (current.disposed || !line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.session_id) {
      current.conversationId = message.session_id;
      unstartedIds.delete(message.session_id);
    }
    const turn = current.active;
    if (!turn) return;
    const conversation_id = current.conversationId;
    if (message.type === 'stream_event') {
      const delta = message.event?.delta;
      if (message.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) {
        turn.text += delta.text;
        turn.onMessage?.({ event: 'step_update', step_update: { conversation_id, text_delta: delta.text } });
      }
      return;
    }
    if (message.type === 'assistant') {
      for (const block of message.message?.content || []) {
        if (block.type === 'tool_use') {
          turn.onMessage?.({ event: 'step_update', step_update: { conversation_id,
            step_type: block.name, details: block, state: 'active' } });
        }
      }
      return;
    }
    if (message.type !== 'result') return;
    if (message.is_error || message.subtype !== 'success') {
      fail(new Error(`Claude Code: ${message.result || message.errors?.join('; ') || message.subtype}`));
      return;
    }
    const usage = message.usage;
    turn.onMessage?.({ event: 'result', result: { conversation_id, response: turn.text || message.result || '',
      duration_seconds: (Date.now() - turn.startedAt) / 1000,
      usage: usage && { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
        cached_input_tokens: usage.cache_read_input_tokens,
        total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) } } });
    if (current.active !== turn || current.disposed) return;
    turn.done = true;
    current.active = null;
    turn.onClose?.(0);
  });
  child.stderr.on('data', (chunk) => {
    if (!current.disposed) current.active?.onMessage?.({ event: 'agent_stderr', text: chunk.toString() });
  });
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('close', (code) => fail(new Error(`Claude Code encerrou a sessão (código ${code})`)));
  return session;
}

export function prepareClaudeSession(options = {}) {
  try { return getSession(options, true).ready; }
  catch (error) { return Promise.reject(error); }
}

export function runClaudeAgent({ prompt, images, onMessage, onError, onClose, ...options }) {
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
  const turn = { onMessage, onError, onClose, done: false, text: '', startedAt: Date.now() };
  session.active = turn;
  session.ready.then(() => {
    if (session.disposed || session.active !== turn) return;
    onMessage?.({ event: 'session_started', conversation_id: session.conversationId });
    const attached = normalizeImages(images);
    const content = attached.length ? [...attached.map(({ mimeType, data }) => ({
      type: 'image', source: { type: 'base64', media_type: mimeType, data } })), { type: 'text', text: prompt }] : prompt;
    session.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  }).catch((error) => {
    if (turn.done || session.disposed) return;
    dispose(session, error);
    onError?.(error);
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
