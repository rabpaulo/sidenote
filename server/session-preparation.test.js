import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { readCandidateContext } from './candidate-context.js';
import { buildAgentPrompt } from './agent-prompt.js';

// The backend only answers requests with the token of its run.
const TOKEN = 'test-token';
const fetch = (url, init = {}) => globalThis.fetch(url, { ...init, headers: { ...init.headers, 'X-Sidenote-Token': TOKEN } });

const MODELS = { antigravity: 'gemini-3.8-flash', codex: 'gpt-6-luna', claude: 'claude-sonnet-5-5' };

for (const provider of Object.keys(MODELS)) {
  test(`${provider}: backend prepares on startup/settings/reset and the first question uses that thread`, { timeout: 10000 }, async (t) => {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidenote-profile-'));
    const profilePath = path.join(profileDir, 'profile.json');
    const child = spawn(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url))], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), SIDENOTE_TOKEN: TOKEN, SIDENOTE_PROFILE_PATH: profilePath,
        AGY_BIN: fileURLToPath(new URL('./fixtures/agy-session.cjs', import.meta.url)),
        CODEX_BIN: fileURLToPath(new URL('./fixtures/codex-session.cjs', import.meta.url)),
        CLAUDE_BIN: fileURLToPath(new URL('./fixtures/claude-session.cjs', import.meta.url)),
      },
    });
    let socket;
    t.after(async () => {
      socket?.terminate();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
      }
      fs.rmSync(profileDir, { recursive: true, force: true });
    });
    child.stderr.resume();
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { if (chunk.toString().includes('WebSocket ready')) resolve(); });
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`Backend exited: ${code}`)));
    });
    const url = `http://127.0.0.1:${port}`;
    socket = new WebSocket(`ws://127.0.0.1:${port}?token=${TOKEN}`);
    const events = [];
    const listeners = new Set();
    socket.on('message', (raw) => {
      const event = JSON.parse(raw);
      events.push(event);
      for (const listener of listeners) listener(event);
    });
    const waitFor = (predicate, since = 0) => {
      const existing = events.slice(since).find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error(`Missing session event: ${JSON.stringify(events.slice(since))}`));
        }, 2000);
        const listener = (event) => {
          if (!predicate(event)) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(event);
        };
        listeners.add(listener);
      });
    };
    const ready = (event) => event.type === 'agent_session' && event.status === 'ready';
    const post = async (endpoint, body) => {
      const response = await fetch(`${url}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.ok, true);
      return response.json();
    };
    const contextFile = await fetch(`${url}/api/candidate-context/file?path=/etc/passwd`);
    const expectedFile = await readCandidateContext(fileURLToPath(new URL('../', import.meta.url)));
    assert.equal(contextFile.status, expectedFile.status);
    assert.equal(contextFile.headers.get('cache-control'), 'no-store');
    const { status: ignoredStatus, ...expectedBody } = expectedFile;
    assert.deepEqual(await contextFile.json(), expectedBody, 'only the fixed project file can be read');
    const ack = await waitFor((e) => e.type === 'connection_ack');
    // The window's saved settings decide what starts, so no process is started twice.
    assert.equal(ack.agentSession.status, 'starting');
    const settings = { provider, model: MODELS[provider], reasoningEffort: 'medium', fastMode: true };
    socket.send(JSON.stringify({ type: 'sync_settings', ...settings }));
    let prepared = await waitFor((e) => ready(e) && e.provider === provider);
    assert.equal(events.some((e) => ready(e) && e.provider !== provider), false);
    assert.equal(events.some((e) => e.type === 'agent_stream' || e.type === 'copilot_started'), false);
    await post('/api/settings', settings);
    let status = await (await fetch(`${url}/api/status`)).json();
    assert.equal(status.agentSession.pid, prepared.pid, 'settings sent over HTTP and WS must share preparation');
    assert.equal(status.isProcessing, false, 'idle preparation must not show the agent as thinking');
    socket.send(JSON.stringify({ type: 'text_message', text: 'primeira pergunta', ...settings }));
    const completed = await waitFor((e) => e.type === 'agent_done');
    assert.equal(completed.conversationId, prepared.conversationId);
    const answer = events.find((e) => e.type === 'agent_stream' && e.data.event === 'result');
    assert.equal(answer.data.result.response, buildAgentPrompt('primeira pergunta'));
    assert.equal(answer.data.result.usage.input_tokens, 10);
    for (const transport of ['ws', 'http']) {
      const since = events.length;
      if (transport === 'ws') socket.send(JSON.stringify({ type: 'reset_session' }));
      else await post('/api/reset-session', {});
      await waitFor((e) => e.type === 'session_reset', since);
      const fresh = await waitFor(ready, since);
      assert.notEqual(fresh.pid, prepared.pid);
      assert.notEqual(fresh.conversationId, prepared.conversationId);
      prepared = fresh;
    }
    // The fixture echoes the actual provider prompt, so this checks the full
    // settings -> copilot -> provider path without consuming model quota.
    for (const notes of ['Tenho experiência com atendimento e treinamento.', '']) {
      const saved = await fetch(`${url}/api/profile`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: { notes, preferredLanguage: 'TypeScript' } }) });
      assert.equal(saved.ok, true);
      assert.equal(JSON.parse(fs.readFileSync(profilePath, 'utf8')).profile.notes, notes);
      const since = events.length;
      await post('/api/copilot/trigger', { text: 'Me conte um pouco sobre você.', persona: 'interview_hr' });
      const reply = await waitFor((event) => event.type === 'copilot_completed', since);
      assert.equal(reply.response.includes('Tenho experiência com atendimento e treinamento.'), Boolean(notes));
      assert.ok(reply.response.includes('CONTEXTO PESSOAL ATUAL'));
    }
    // Follow-up questions receive actual input through both provider bridges.
    await post('/api/reset-session', {});
    const question = async (text) => {
      const since = events.length;
      await post('/api/copilot/trigger', { text, ...settings });
      const reply = await waitFor((e) => e.type === 'copilot_completed', since);
      return JSON.parse(reply.response.match(/FALAS RECENTES DA SESSÃO[^\n]*\n([^\n]+)/)[1]);
    };
    assert.deepEqual(await question('Estamos desenhando um checkout com pagamentos duplicados.'), []);
    await post('/api/message', { text: 'Eu implementei a validação de pedidos no projeto Loja.', ...settings });
    assert.deepEqual(await question('Como você resolveria isso?'), [
      { role: 'interlocutor', text: 'Estamos desenhando um checkout com pagamentos duplicados.' },
      { role: 'user', text: 'Eu implementei a validação de pedidos no projeto Loja.' },
    ]);
    const sinceUser = events.length;
    socket.send(JSON.stringify({ type: 'voice_message', text: 'Na verdade, minha participação foi só no frontend.', ...settings }));
    await waitFor((e) => e.type === 'agent_done', sinceUser);
    const recent = await question('E qual foi sua participação?');
    assert.equal(recent.at(-1).role, 'user');
    assert.equal(recent.at(-1).text, 'Na verdade, minha participação foi só no frontend.');
    assert.equal(recent.length, 4, 'generated answers must never become candidate facts');
    assert.deepEqual(await question('E qual foi sua participação?'), recent, 'retrying a question must not duplicate it');
    await post('/api/reset-session', {});
    assert.deepEqual(await question('Outro assunto: como funciona um índice SQL?'), [], 'new sessions discard old interview facts');

    // A reset superseded before initialization finishes must never publish an old ID.
    const since = events.length;
    socket.send(JSON.stringify({ type: 'reset_session' }));
    socket.send(JSON.stringify({ type: 'reset_session' }));
    const final = await waitFor(ready, since);
    if (provider === 'claude') {
      // Claude sessions are ready as soon as the process spawns, so each reset may
      // publish its own ready event; the last one published must be the active ID.
      await new Promise((resolve) => setTimeout(resolve, 200));
      status = await (await fetch(`${url}/api/status`)).json();
      assert.equal(status.activeConversationIds[provider], events.slice(since).filter(ready).at(-1).conversationId);
      return;
    }
    status = await (await fetch(`${url}/api/status`)).json();
    assert.equal(status.activeConversationIds[provider], final.conversationId);
    assert.equal(events.slice(since).filter(ready).length, 1);
  });
}
