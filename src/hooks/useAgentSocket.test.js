import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Drive the real WebSocket event handlers without opening a browser or server.
function createSocketHarness() {
  const slots = [];
  let cursor = 0;
  let mounted = false;
  const effects = [];
  let socket;
  const sent = [];
  const requests = [];
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Date, setTimeout, clearTimeout,
    fetch(url, options) { requests.push({ url, options }); return Promise.resolve({ json: async () => ({}) }); },
    apiFetch(url, options) { requests.push({ url, options }); return Promise.resolve({ json: async () => ({}) }); },
    backendSocketUrl: () => 'ws://127.0.0.1:3001?token=test',
    window: { location: { protocol: 'http:', hostname: 'localhost', port: '3001', host: 'localhost:3001' } },
    localStorage: { getItem: () => null },
    WebSocket: class {
      static OPEN = 1;
      constructor() { socket = this; }
      send(data) { sent.push(JSON.parse(data)); }
      close() {}
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value) => {
        slots[index] = typeof value === 'function' ? value(slots[index]) : value;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback(callback) { return callback; },
    useEffect(effect) { if (!mounted) effects.push(effect); },
    startSystemLoopback: () => new Promise(() => {}),
  });
  const source = fs.readFileSync(new URL('./useAgentSocket.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export function useAgentSocket', 'function useAgentSocket');
  vm.runInContext(source, context);
  function state() {
    cursor = 0;
    return vm.runInContext('useAgentSocket()', context);
  }
  state();
  effects.forEach((effect) => effect());
  mounted = true;
  return {
    state, sent, requests,
    open() { socket.readyState = 1; socket.onopen(); },
    emit(event) { socket.onmessage({ data: JSON.stringify(event) }); },
  };
}

test('keeps a visible error when the PC transcription notice disappears', () => {
  const app = createSocketHarness();
  app.emit({ type: 'pc_speech_start' });
  app.emit({ type: 'pc_speech_processing' });
  assert.equal(app.state().isTranscribingPc, true);
  app.emit({ type: 'pc_speech_error', error: 'Não foi possível entender o áudio' });
  assert.equal(app.state().isTranscribingPc, false);
  assert.equal(app.state().isPcSpeaking, false);
  assert.equal(app.state().pcAudioError, 'Não foi possível entender o áudio');
});

test('clears a discarded PC speech notice and recovers on a successful transcript', () => {
  const app = createSocketHarness();
  app.emit({ type: 'pc_speech_start' });
  app.emit({ type: 'pc_speech_end' });
  assert.equal(app.state().isPcSpeaking, false);
  assert.equal(app.state().isTranscribingPc, false);
  app.emit({ type: 'pc_speech_error', error: 'Serviço indisponível' });
  app.emit({ type: 'pc_speech_transcribed', text: 'Como resolvo esse problema?' });
  app.emit({ type: 'copilot_started', prompt: 'Como resolvo esse problema?' });
  app.emit({ type: 'copilot_completed', response: 'Aqui está a solução.' });
  const state = app.state();
  assert.equal(state.pcAudioError, null);
  assert.equal(state.isProcessing, false);
  assert.equal(state.messages[0].role, 'interlocutor');
  assert.equal(state.messages[1].text, 'Aqui está a solução.');
  assert.equal(state.messages[1].status, 'done');
});

test('partials remain live and do not enter history or trigger agent state', () => {
  const app = createSocketHarness();
  app.emit({ type: 'pc_speech_start', utteranceId: 'a' });
  app.emit({ type: 'pc_speech_partial', utteranceId: 'a', text: 'Texto parcial' });
  assert.equal(app.state().pcLiveTranscripts[0].text, 'Texto parcial');
  assert.equal(app.state().messages.length, 0);
  assert.equal(app.state().isPcSpeaking, true);
  assert.equal(app.state().isProcessing, false);
  app.emit({ type: 'pc_speech_end', utteranceId: 'a' });
  app.emit({ type: 'pc_speech_processing', utteranceId: 'a' });
  app.emit({ type: 'pc_speech_start', utteranceId: 'b' });
  app.emit({ type: 'pc_speech_partial', utteranceId: 'b', text: 'Nova fala' });
  app.emit({ type: 'pc_speech_transcribed', utteranceId: 'a', text: 'Texto final' });
  assert.equal(app.state().isPcSpeaking, true, 'a late final must not hide the newer speaker');
  assert.equal(app.state().pcLiveTranscripts.length, 1);
  assert.equal(app.state().pcLiveTranscripts[0].text, 'Nova fala');
  assert.equal(app.state().messages[0].text, 'Texto final');
});

test('stop and reset clear unfinished live text and processing notices', () => {
  const app = createSocketHarness();
  for (const type of ['pc_capture_status', 'session_reset']) {
    app.emit({ type: 'pc_speech_start', utteranceId: 'a' });
    app.emit({ type: 'pc_speech_partial', utteranceId: 'a', text: 'Texto antigo' });
    app.emit({ type: 'pc_speech_processing', utteranceId: 'a' });
    app.emit({ type, isCapturing: false });
    assert.equal(app.state().pcLiveTranscripts.length, 0);
    assert.equal(app.state().isTranscribingPc, false);
    assert.equal(app.state().isPcSpeaking, false);
  }
});

test('live replies update their own row when another message arrives and finalization needs no duplicate', () => {
  const app = createSocketHarness();
  const replyId = 'copilot-pc-a';
  app.emit({ type: 'copilot_started', replyId, isPreview: true, prompt: 'Pergunta parcial' });
  app.emit({ type: 'copilot_token', replyId, token: 'Primeira', fullText: 'Primeira', isPreview: true });
  app.emit({ type: 'pc_speech_transcribed', utteranceId: 'a', text: 'Pergunta final' });
  app.emit({ type: 'copilot_completed', replyId, response: 'Primeira resposta', isPreview: true });
  app.emit({ type: 'copilot_started', replyId, prompt: 'Pergunta final', isPreview: false });
  assert.equal(app.state().messages.length, 2);
  assert.equal(app.state().messages[0].role, 'interlocutor');
  assert.equal(app.state().messages[1].text, 'Primeira resposta', 'keep the previous suggestion visible during refresh');
  app.emit({ type: 'copilot_token', replyId, token: 'Nova', fullText: 'Nova', isPreview: false });
  app.emit({ type: 'copilot_completed', replyId, response: 'Nova resposta', isPreview: false });
  assert.equal(app.state().messages[1].text, 'Nova resposta', 'replace the old snapshot instead of concatenating it');
  app.emit({ type: 'copilot_finalized', replyId });
  assert.equal(app.state().messages[1].isPreview, false);
  assert.equal(app.state().isProcessing, false);
});

test('reply IDs prevent late tokens from changing a different active response', () => {
  const app = createSocketHarness();
  app.emit({ type: 'copilot_started', replyId: 'a' });
  app.emit({ type: 'copilot_started', replyId: 'b' });
  app.emit({ type: 'copilot_token', replyId: 'a', fullText: 'Resposta A' });
  assert.equal(app.state().messages[0].text, 'Resposta A');
  assert.equal(app.state().messages[1].text, '');
});

test('discarding an older preview does not stop the current response indicator', () => {
  const app = createSocketHarness();
  app.emit({ type: 'copilot_started', replyId: 'a', isPreview: true });
  app.emit({ type: 'copilot_completed', replyId: 'a', response: 'Prévia', isPreview: true });
  app.emit({ type: 'copilot_started', replyId: 'b' });
  app.emit({ type: 'copilot_discarded', replyId: 'a' });
  assert.equal(app.state().isProcessing, true);
  assert.equal(app.state().messages[0].status, 'cancelled');
});


test('session readiness stores the thread ID without adding a response or a thinking indicator', () => {
  const app = createSocketHarness();
  app.emit({ type: 'agent_session', status: 'starting', provider: 'codex' });
  app.emit({ type: 'agent_session', status: 'ready', provider: 'codex', conversationId: 'ready-thread' });
  assert.equal(app.state().conversationIds.codex, 'ready-thread');
  assert.equal(app.state().messages.length, 0);
  assert.equal(app.state().isProcessing, false);
});

test('new session sends exactly one reset when WebSocket is available', () => {
  const app = createSocketHarness();
  app.open();
  app.state().resetSession();
  assert.equal(app.sent.filter((e) => e.type === 'reset_session').length, 1);
  assert.equal(app.requests.filter((e) => e.url === '/api/reset-session').length, 0);
});

test('new session uses HTTP while disconnected and sends saved settings when connecting', () => {
  const app = createSocketHarness();
  app.state().resetSession();
  assert.equal(app.requests.filter((e) => e.url === '/api/reset-session').length, 1);
  app.state().syncSettings({ provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'low', fastMode: false });
  app.open();
  const settings = app.sent.find((e) => e.type === 'sync_settings');
  assert.equal(settings.provider, 'codex');
  assert.equal(settings.model, 'gpt-6-luna');
  assert.equal(settings.reasoningEffort, 'low');
  assert.equal(settings.fastMode, false);
});

test('an agent reply keeps streaming into its own message when the interviewer speaks meanwhile', () => {
  const app = createSocketHarness();
  app.emit({ type: 'user_message_acknowledged', turnId: 't1', text: 'Minha pergunta' });
  app.emit({ type: 'agent_stream', turnId: 't1', data: { event: 'step_update', step_update: { text_delta: 'Primeira ' } } });
  app.emit({ type: 'pc_speech_transcribed', utteranceId: 'u1', text: 'O entrevistador falou' });
  app.emit({ type: 'agent_stream', turnId: 't1', data: { event: 'step_update', step_update: { text_delta: 'parte.' } } });
  app.emit({ type: 'agent_done', turnId: 't1' });
  const [user, agent, interlocutor] = app.state().messages;
  assert.equal(user.role, 'user');
  assert.equal(agent.text, 'Primeira parte.');
  assert.equal(agent.status, 'done');
  assert.equal(interlocutor.text, 'O entrevistador falou');
  assert.equal(interlocutor.status, undefined);
});

test('an abort without a turn id stops the reply still streaming', () => {
  const app = createSocketHarness();
  app.emit({ type: 'user_message_acknowledged', turnId: 't1', text: 'Pergunta' });
  app.emit({ type: 'pc_speech_transcribed', utteranceId: 'u1', text: 'Outra fala' });
  app.emit({ type: 'agent_aborted' });
  assert.equal(app.state().messages[1].status, 'aborted');
});

test('summary state, settings and saved files come from the backend', () => {
  const app = createSocketHarness();
  const settings = { auto: false, provider: 'claude', model: 'claude-haiku-5-5', saveOnReset: true };
  app.state().syncSummarySettings(settings);
  app.open();
  assert.deepEqual(app.sent.find((message) => message.type === 'summary_settings'), { type: 'summary_settings', settings },
    'settings are resent on every connection');
  app.state().requestSummary();
  assert.equal(app.sent.at(-1).type, 'summary_request');
  app.emit({ type: 'summary_update', summary: { status: 'idle', text: '## Visão geral', covered: 2, total: 2 } });
  assert.equal(app.state().summary.text, '## Visão geral');
  app.emit({ type: 'summary_saved', file: '/tmp/sessao.md', archived: true });
  assert.deepEqual({ ...app.state().summaryNotice }, { file: '/tmp/sessao.md', archived: true });
  assert.equal(app.state().messages.length, 0, 'the summary never enters the chat');
});
