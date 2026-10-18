import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// The backend only answers requests with the token of its run.
const TOKEN = 'test-token';
const fetch = (url, init = {}) => globalThis.fetch(url, { ...init, headers: { ...init.headers, 'X-Sidenote-Token': TOKEN } });

// The fixture CLI echoes its prompt, so the summary text shows exactly what the model received.
test('summaries use the whole transcript in a separate process, export and survive a new session', { timeout: 15000 }, async (t) => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidenote-summary-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url))], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), SIDENOTE_TOKEN: TOKEN, SIDENOTE_PROFILE_PATH: path.join(profileDir, 'profile.json'),
      SIDENOTE_NOTES_CONFIG: path.join(profileDir, 'notes.json'),
      AGY_BIN: fileURLToPath(new URL('./fixtures/agy-session.cjs', import.meta.url)) },
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
      const timer = setTimeout(() => reject(new Error(`Missing event: ${JSON.stringify(events.slice(since).map((e) => e.type))}`)), 5000);
      const listener = (event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(event);
      };
      listeners.add(listener);
    });
  };
  const post = (endpoint, body) => fetch(`${url}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const ack = await waitFor((e) => e.type === 'connection_ack');
  assert.equal(ack.summary.status, 'idle');
  socket.send(JSON.stringify({ type: 'summary_settings', settings: { auto: false, saveOnReset: true } }));
  assert.equal((await post('/api/summary/export', { target: 'sessions' })).status, 400, 'nothing to export yet');

  let since = events.length;
  await post('/api/copilot/trigger', { text: 'Fale sobre um projeto difícil.' });
  await waitFor((e) => e.type === 'copilot_completed', since);
  since = events.length;
  socket.send(JSON.stringify({ type: 'text_message', text: 'Liderei a migração do checkout.' }));
  const done = await waitFor((e) => e.type === 'agent_done', since);
  const conversationId = done.conversationId;

  since = events.length;
  socket.send(JSON.stringify({ type: 'summary_request' }));
  const summary = (await waitFor((e) => e.type === 'summary_update' && e.summary.status === 'idle' && e.summary.text, since)).summary;
  assert.ok(events.slice(since).some((e) => e.type === 'summary_update' && e.summary.draft), 'a manual summary streams');
  assert.ok(summary.text.includes('Interlocutor: Fale sobre um projeto difícil.'));
  assert.ok(summary.text.includes('Você: Liderei a migração do checkout.'));
  assert.ok(summary.text.includes('Sugestão da IA:'));
  assert.equal(summary.covered, 2);
  assert.equal(summary.stale, false);
  assert.equal(events.slice(since).some((e) => e.type === 'user_message_acknowledged' || e.type === 'agent_stream'), false,
    'the summary never enters the chat');
  const status = await (await fetch(`${url}/api/status`)).json();
  assert.equal(status.activeConversationIds.antigravity, conversationId, 'the live conversation is untouched');

  const vault = await post('/api/summary/export', { target: 'vault' });
  assert.equal(vault.status, 400);
  const exported = await (await post('/api/summary/export', { target: 'sessions' })).json();
  assert.equal(path.dirname(exported.file), path.join(profileDir, 'sessions'));
  const markdown = fs.readFileSync(exported.file, 'utf8');
  assert.ok(markdown.includes(summary.text));
  assert.ok(markdown.includes('## Transcrição'));

  since = events.length;
  socket.send(JSON.stringify({ type: 'reset_session' }));
  const saved = await waitFor((e) => e.type === 'summary_saved', since);
  assert.equal(saved.archived, true);
  assert.notEqual(saved.file, exported.file);
  assert.ok(fs.readFileSync(saved.file, 'utf8').includes(summary.text), 'a current summary is reused, not regenerated');
  const cleared = events.slice(since).find((e) => e.type === 'summary_update');
  assert.equal(cleared.summary.text, '');
  assert.equal(cleared.summary.total, 0);

  // The finished meeting is in the history, searchable by what was said.
  assert.ok(events.slice(since).some((e) => e.type === 'history_changed'));
  const { meetings } = await (await fetch(`${url}/api/history?q=migracao`)).json();
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0].status, 'done');
  assert.match(meetings[0].snippet.text, /migração do checkout/);
  assert.equal((await (await fetch(`${url}/api/history?q=kubernetes`)).json()).meetings.length, 0);
  const { meeting } = await (await fetch(`${url}/api/history/${meetings[0].id}`)).json();
  assert.equal(meeting.summary, summary.text);
  assert.equal(meeting.endedAt, meeting.entries.at(-1).at);
  assert.ok(fs.existsSync(path.join(profileDir, 'history', `${meeting.id}.json`)));
  assert.equal((await fetch(`${url}/api/history/${meeting.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${url}/api/history/${meeting.id}`)).status, 404);
});
