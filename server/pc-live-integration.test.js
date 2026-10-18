import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// The backend only answers requests with the token of its run.
const TOKEN = 'test-token';
const fetch = (url, init = {}) => globalThis.fetch(url, { ...init, headers: { ...init.headers, 'X-InterviewAI-Token': TOKEN } });

for (const automatic of [true, false]) {
test(`backend preserves complete PC speech in ${automatic ? 'automatic' : 'manual'} mode`, { timeout: 10000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interviewai-pc-live-'));
  const executable = (name, code) => {
    fs.writeFileSync(path.join(dir, name), '#!/usr/bin/env node\n' + code);
    fs.chmodSync(path.join(dir, name), 0o755);
  };
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ version: 1, profile: { notes: 'Experiência real de suporte ao cliente.' } }));
  executable('pactl', "console.log(process.argv.includes('get-default-sink') ? 'test_sink' : '0\\ttest_sink\\ttest');");
  // Stands in for `transcribe.py --serve`: one JSON answer per request line.
  executable('python3', "require('readline').createInterface({ input: process.stdin }).on('line', (line) => console.log(JSON.stringify({ id: JSON.parse(line).id, text: 'Como resolvo esse problema no servidor?' })));");
  executable('parec', "const pcm=Buffer.alloc(1600); for(let i=0;i<pcm.length;i+=2) pcm.writeInt16LE(4000,i); let frames=0; setInterval(()=>process.stdout.write(++frames<=60 ? pcm : Buffer.alloc(1600)),50);");
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const cli = fileURLToPath(new URL('./fixtures/agy-session.cjs', import.meta.url));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url))], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), INTERVIEWAI_TOKEN: TOKEN, PATH: `${dir}:${process.env.PATH}`, AGY_BIN: cli, CODEX_BIN: cli,
      INTERVIEWAI_PROFILE_PATH: path.join(dir, 'profile.json') },
  });
  let socket;
  t.after(async () => {
    socket?.terminate();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  child.stderr.resume();
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { if (chunk.toString().includes('WebSocket ready')) resolve(); });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`Backend exited: ${code}`)));
  });
  socket = new WebSocket(`ws://127.0.0.1:${port}?token=${TOKEN}`);
  const events = [];
  const response = await new Promise((resolve, reject) => {
    socket.on('error', reject);
    socket.on('message', (raw) => {
      const event = JSON.parse(raw);
      events.push(event);
      if (event.type === 'connection_ack') {
        socket.send(JSON.stringify({ type: 'set_auto_respond', autoRespond: automatic }));
        socket.send(JSON.stringify({ type: 'start_pc_capture', options: { sink: 'test_sink' } }));
      }
      if (!automatic && event.type === 'pc_speech_transcribed') {
        socket.send(JSON.stringify({ type: 'trigger_copilot', text: 'E como eu verificaria isso?' }));
      }
      if (event.type === 'copilot_error' || event.type === 'pc_speech_error') reject(new Error(event.error));
      // Automatic mode answers the speech so far; the matching final turns that preview into the answer.
      if (automatic && event.type === 'copilot_finalized') resolve(events.findLast((item) => item.type === 'copilot_completed'));
      if (!automatic && event.type === 'copilot_completed') resolve(event);
    });
  });
  assert.equal(events.some((event) => event.type === 'pc_speech_start'), true);
  assert.equal(events.some((event) => event.type === 'pc_speech_partial'), true);
  assert.equal(events.some((event) => event.type === 'pc_speech_end'), true);
  const started = events.findIndex((event) => event.type === 'copilot_started');
  const transcribed = events.findIndex((event) => event.type === 'pc_speech_transcribed');
  assert.ok(transcribed >= 0 && started >= 0);
  if (automatic) assert.ok(started < transcribed, 'a preview starts while the interlocutor is still speaking');
  else assert.ok(started > transcribed, 'manual mode waits for the complete transcript');
  assert.equal(events.filter((event) => event.type === 'copilot_started').length, 1, 'the matching final reuses the preview');
  assert.equal(response.isPreview, automatic, 'the preview completed before the final transcript');
  assert.match(response.replyId, automatic ? /^copilot-pc-/ : /^copilot-/);
  assert.ok(response.response);
  assert.ok(response.response.includes('Experiência real de suporte ao cliente.'), 'automatic responses must receive candidate context');
  if (!automatic) {
    const recent = JSON.parse(response.response.match(/FALAS RECENTES DA SESSÃO[^\n]*\n([^\n]+)/)[1]);
    assert.deepEqual(recent, [{ role: 'interlocutor', text: 'Como resolvo esse problema no servidor?' }]);
  }
});
}
