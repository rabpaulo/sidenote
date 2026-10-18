import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createBackendAuth } from './backend-auth.js';

test('only the token of the run and the app origins are accepted', () => {
  const auth = createBackendAuth({ token: 'segredo', port: 3001, extraOrigins: ['http://localhost:5173/', 'not a url', ''] });
  assert.ok(auth.valid('segredo'));
  assert.ok(!auth.valid('segred'));
  assert.ok(!auth.valid(undefined));
  assert.ok(!auth.valid(''));
  assert.deepEqual([...auth.origins], ['http://127.0.0.1:3001', 'http://localhost:3001', 'http://localhost:5173']);
  assert.ok(auth.originAllowed(undefined), 'local processes send no Origin');
  assert.ok(!auth.originAllowed('https://evil.example'));
  assert.ok(!auth.originAllowed('http://192.168.0.10:3001'));
  assert.ok(auth.verifySocket({ origin: 'http://localhost:5173', req: { url: '/?token=segredo' } }));
  assert.ok(!auth.verifySocket({ origin: 'https://evil.example', req: { url: '/?token=segredo' } }));
  assert.ok(!auth.verifySocket({ origin: 'http://localhost:5173', req: { url: '/' } }));
  assert.equal(createBackendAuth({ port: 1 }).token.length, 64, 'a backend started by hand makes its own token');
});

test('the backend listens on loopback and refuses requests without the token or from other sites', { timeout: 10000 }, async (t) => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interviewai-auth-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url))], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), INTERVIEWAI_TOKEN: 'token-do-teste',
      INTERVIEWAI_PROFILE_PATH: path.join(profileDir, 'profile.json'), INTERVIEWAI_NOTES_CONFIG: path.join(profileDir, 'notes.json'),
      AGY_BIN: fileURLToPath(new URL('./fixtures/agy-session.cjs', import.meta.url)) },
  });
  t.after(async () => {
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
  const authorized = { 'X-InterviewAI-Token': 'token-do-teste' };

  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  assert.equal((await fetch(`${url}/api/history`)).status, 401);
  assert.equal((await fetch(`${url}/api/history`, { headers: { 'X-InterviewAI-Token': 'outro' } })).status, 401);
  assert.equal((await fetch(`${url}/api/history/x`, { method: 'DELETE' })).status, 401);
  assert.equal((await fetch(`${url}/api/audio-apps`)).status, 401);
  assert.equal((await fetch(`${url}/api/history`, { headers: authorized })).status, 200);
  const foreign = await fetch(`${url}/api/history`, { headers: { ...authorized, Origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);
  const preflight = await fetch(`${url}/api/history/x`, { method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'DELETE' } });
  assert.equal(preflight.headers.get('access-control-allow-origin'), null, 'other sites never pass the preflight');
  const own = await fetch(`${url}/api/history`, { headers: { ...authorized, Origin: url } });
  assert.equal(own.headers.get('access-control-allow-origin'), url);

  const opens = (address, options) => new Promise((resolve) => {
    const socket = new WebSocket(address, options);
    socket.once('open', () => { socket.terminate(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
  assert.equal(await opens(`ws://127.0.0.1:${port}`), false);
  assert.equal(await opens(`ws://127.0.0.1:${port}?token=token-do-teste`, { origin: 'https://evil.example' }), false);
  assert.equal(await opens(`ws://127.0.0.1:${port}?token=token-do-teste`, { origin: url }), true);

  const tokenFile = path.join(profileDir, 'backend-token');
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), 'token-do-teste');
  if (process.platform !== 'win32') assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  const lanAddress = Object.values(os.networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;
  if (lanAddress) {
    const reachable = await new Promise((resolve) => {
      const socket = net.connect(port, lanAddress, () => { socket.destroy(); resolve(true); });
      socket.on('error', () => resolve(false));
    });
    assert.equal(reachable, false, 'not reachable from the network');
  }
});

test('a backend that cannot get the port exits without taking over the running meeting', { timeout: 10000 }, async (t) => {
  const busy = net.createServer();
  await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve));
  t.after(() => busy.close());
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interviewai-busy-'));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const draft = path.join(profileDir, 'history', 'draft.json');
  fs.mkdirSync(path.dirname(draft), { recursive: true });
  fs.writeFileSync(draft, JSON.stringify({ startedAt: 1, entries: [{ role: 'user', text: 'a', at: 1 }, { role: 'user', text: 'b', at: 2 }] }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url))], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, PORT: String(busy.address().port), INTERVIEWAI_TOKEN: 'x',
      INTERVIEWAI_PROFILE_PATH: path.join(profileDir, 'profile.json'), INTERVIEWAI_NOTES_CONFIG: path.join(profileDir, 'notes.json'),
      AGY_BIN: fileURLToPath(new URL('./fixtures/agy-session.cjs', import.meta.url)) },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /already in use/);
  assert.deepEqual(fs.readdirSync(path.dirname(draft)), ['draft.json'], 'the draft stays with the backend that owns it');
  assert.ok(!fs.existsSync(path.join(profileDir, 'backend-token')), 'nor is its token replaced');
});
