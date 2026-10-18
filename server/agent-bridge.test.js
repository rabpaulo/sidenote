import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as bridge from './agent-bridge.js';

function fixture(t) {
  const previous = process.env.AGY_BIN;
  const previousCodex = process.env.CODEX_BIN;
  const previousClaude = process.env.CLAUDE_BIN;
  process.env.AGY_BIN = fileURLToPath(new URL('./fixtures/agy-session.cjs', import.meta.url));
  process.env.CODEX_BIN = fileURLToPath(new URL('./fixtures/codex-session.cjs', import.meta.url));
  process.env.CLAUDE_BIN = fileURLToPath(new URL('./fixtures/claude-session.cjs', import.meta.url));
  t.after(() => {
    bridge.closeAgentSession();
    if (previous === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = previous;
    if (previousCodex === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previousCodex;
    if (previousClaude === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousClaude;
  });
}

function turn(options) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const handle = bridge.runAgyAgent({
      ...options, onMessage: (message) => messages.push(message),
      onError: reject, onClose: (code) => {
        if (code !== 0) return reject(new Error(`Exit: ${code}`));
        const result = messages.find((m) => m.event === 'result')?.result;
        if (!result) return reject(new Error(`Missing result: ${JSON.stringify(messages)}`));
        resolve({ handle, messages, result });
      },
    });
  });
}

test('consecutive responses reuse the initialized process and complete each turn separately', { timeout: 3000 }, async (t) => {
  fixture(t);
  const first = await turn({ prompt: 'primeira resposta' });
  const second = await turn({ prompt: 'segunda resposta', conversationId: first.result.conversation_id });
  assert.equal(second.handle.pid, first.handle.pid, 'continuing the conversation must skip process startup');
  assert.equal(first.result.response, 'primeira resposta');
  assert.equal(second.result.response, 'segunda resposta');
  assert.deepEqual(second.result.usage, { input_tokens: 10, output_tokens: 2 });
  assert.ok(second.result.duration_seconds < 1, 'duration must exclude earlier turns and idle time');
});

test('new conversations and changed model settings cannot reuse unrelated context', { timeout: 3000 }, async (t) => {
  fixture(t);
  const first = await turn({ prompt: 'primeira' });
  const changed = await turn({ prompt: 'segunda', conversationId: first.result.conversation_id, reasoningEffort: 'medium' });
  assert.notEqual(changed.handle.pid, first.handle.pid);
  const fresh = await turn({ prompt: 'nova', reasoningEffort: 'medium' });
  assert.notEqual(fresh.handle.pid, changed.handle.pid);
  assert.notEqual(fresh.result.conversation_id, changed.result.conversation_id);
});

test('cancelling a turn suppresses late results and releases the process', { timeout: 3000 }, async (t) => {
  fixture(t);
  const events = [];
  const cancelled = bridge.runAgyAgent({
    prompt: 'antiga', onMessage: (message) => events.push(message),
    onClose: () => events.push('closed'), onError: () => events.push('error'),
  });
  cancelled.kill();
  const next = await turn({ prompt: 'atual' });
  assert.notEqual(next.handle.pid, cancelled.pid);
  assert.equal(next.result.response, 'atual');
  assert.deepEqual(events, []);
});

test('a completed handle cannot cancel a later turn on the warm process', { timeout: 3000 }, async (t) => {
  fixture(t);
  const first = await turn({ prompt: 'primeira' });
  const next = turn({ prompt: 'segunda', conversationId: first.result.conversation_id });
  first.handle.kill();
  assert.equal((await next).result.response, 'segunda');
});

test('spawn failures produce one error and no successful completion', { timeout: 3000 }, async (t) => {
  fixture(t);
  process.env.AGY_BIN = '/tmp/nonexistent-interviewai-test-binary';
  let errors = 0;
  let completions = 0;
  await new Promise((resolve) => bridge.runAgyAgent({
    prompt: 'teste', onError: () => { errors++; resolve(); }, onClose: () => completions++,
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors, 1);
  assert.equal(completions, 0);
});

for (const prompt of ['__error__', '__exit__']) {
  test(`${prompt}: failed turns never emit successful completion and the next request recovers`, { timeout: 3000 }, async (t) => {
    fixture(t);
    let completions = 0;
    await new Promise((resolve) => bridge.runAgyAgent({
      prompt, onError: resolve, onClose: () => completions++,
    }));
    assert.equal(completions, 0);
    assert.equal((await turn({ prompt: 'recuperada' })).result.response, 'recuperada');
  });
}

test('cancelled Codex runs cannot deliver stale callbacks to the next live response', { timeout: 3000 }, async (t) => {
  fixture(t);
  const stale = [];
  const cancelled = bridge.runCodexAgent({ prompt: 'antiga',
    onMessage: (message) => stale.push(message), onClose: () => stale.push('close'), onError: () => stale.push('error'),
  });
  cancelled.kill();
  const messages = [];
  await new Promise((resolve, reject) => bridge.runCodexAgent({ prompt: 'atual',
    onMessage: (message) => messages.push(message), onClose: resolve, onError: reject,
  }));
  assert.deepEqual(stale, []);
  assert.equal(messages.find((message) => message.event === 'result').result.response, 'atual');
});

for (const provider of ['antigravity', 'codex', 'claude']) {
  const run = (options) => new Promise((resolve, reject) => {
    const messages = [];
    const handle = bridge.runUnifiedAgent({ provider, ...options,
      onMessage: (event) => messages.push(event), onError: reject,
      onClose: () => resolve({ handle, messages, result: messages.find((e) => e.event === 'result').result }),
    });
  });
  test(`${provider}: preparing starts an idle session and the first question reuses its process and thread`, { timeout: 3000 }, async (t) => {
    fixture(t);
    t.after(() => bridge.closeAgentSession());
    const prepared = await bridge.prepareAgentSession({ provider });
    assert.ok(prepared.conversationId);
    assert.ok(prepared.pid);
    const duplicate = await bridge.prepareAgentSession({ provider });
    assert.deepEqual(duplicate, prepared, 'duplicate settings must not create another thread');
    const first = await run({ prompt: 'primeira pergunta', conversationId: prepared.conversationId });
    assert.equal(first.handle.pid, prepared.pid);
    assert.equal(first.result.conversation_id, prepared.conversationId);
    assert.equal(first.result.response, 'primeira pergunta');
    assert.equal(first.result.usage.input_tokens, 10, 'preparation must not generate a model turn');
    const second = await run({ prompt: 'segunda', conversationId: first.result.conversation_id });
    first.handle.kill();
    assert.equal(second.handle.pid, first.handle.pid);
    assert.equal(second.result.response, 'segunda');
    assert.equal(second.result.usage.input_tokens, 10);
    bridge.closeAgentSession(provider);
    const fresh = await bridge.prepareAgentSession({ provider });
    assert.notEqual(fresh.pid, prepared.pid);
    assert.notEqual(fresh.conversationId, prepared.conversationId);
  });
  test(`${provider}: a question arriving during preparation uses the same initializing process`, { timeout: 3000 }, async (t) => {
    fixture(t);
    t.after(() => bridge.closeAgentSession());
    const pending = bridge.prepareAgentSession({ provider });
    const answer = await run({ prompt: 'pergunta imediata' });
    assert.equal(answer.handle.pid, (await pending).pid);
    assert.equal(answer.result.response, 'pergunta imediata');
  });
  test(`${provider}: reset during preparation suppresses the old session and prepares a fresh one`, { timeout: 3000 }, async (t) => {
    fixture(t);
    t.after(() => bridge.closeAgentSession());
    const pending = bridge.prepareAgentSession({ provider });
    const rejection = assert.rejects(pending, /encerrada/);
    bridge.closeAgentSession(provider);
    await rejection;
    const fresh = await bridge.prepareAgentSession({ provider });
    const answer = await run({ prompt: 'nova', conversationId: fresh.conversationId });
    assert.equal(answer.handle.pid, fresh.pid);
  });
}
for (const prompt of ['__error__', '__exit__', '__rpc_error__']) {
  test(`Codex ${prompt}: failed turns emit one error, never complete and allow recovery`, { timeout: 3000 }, async (t) => {
    fixture(t);
    t.after(() => bridge.closeAgentSession());
    let errors = 0;
    let completions = 0;
    await new Promise((resolve) => bridge.runCodexAgent({ prompt,
      onError: () => { errors++; resolve(); }, onClose: () => completions++,
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors, 1);
    assert.equal(completions, 0);
    await new Promise((resolve, reject) => bridge.runCodexAgent({ prompt: 'recuperada', onClose: resolve, onError: reject }));
  });
}

for (const prompt of ['__error__', '__exit__']) {
  test(`Claude Code ${prompt}: failed turns emit one error, never complete and allow recovery`, { timeout: 3000 }, async (t) => {
    fixture(t);
    t.after(() => bridge.closeAgentSession());
    let errors = 0;
    let completions = 0;
    await new Promise((resolve) => bridge.runClaudeAgent({ prompt,
      onError: () => { errors++; resolve(); }, onClose: () => completions++,
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors, 1);
    assert.equal(completions, 0);
    await new Promise((resolve, reject) => bridge.runClaudeAgent({ prompt: 'recuperada', onClose: resolve, onError: reject }));
  });
}

test('Claude Code: a prepared but unused session is recreated with its ID instead of resuming', { timeout: 3000 }, async (t) => {
  fixture(t);
  t.after(() => bridge.closeAgentSession());
  const prepared = await bridge.prepareAgentSession({ provider: 'claude', reasoningEffort: 'low' });
  const messages = [];
  await new Promise((resolve, reject) => bridge.runClaudeAgent({ prompt: 'depois da troca', reasoningEffort: 'high',
    conversationId: prepared.conversationId, onMessage: (m) => messages.push(m), onClose: resolve, onError: reject }));
  const result = messages.find((m) => m.event === 'result').result;
  assert.equal(result.conversation_id, prepared.conversationId);
  assert.equal(result.response, 'depois da troca');
});

const PIXEL = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==' };

for (const provider of ['codex', 'claude']) {
  test(`${provider}: attached images reach the CLI as native image input before the text`, { timeout: 3000 }, async (t) => {
    fixture(t);
    const result = await new Promise((resolve, reject) => {
      const messages = [];
      bridge.runUnifiedAgent({ provider, prompt: 'resolva', images: [PIXEL, { mimeType: 'text/html', data: 'PGI+' }],
        onMessage: (event) => messages.push(event), onError: reject,
        onClose: () => resolve(messages.find((e) => e.event === 'result').result) });
    });
    const marker = provider === 'codex' ? '[image:data:image/png]' : '[image:image/png]';
    assert.equal(result.response, `${marker} resolva`, 'unsupported types must be dropped');
  });
}

test('antigravity: attached images are saved to files the prompt points to', { timeout: 3000 }, async (t) => {
  fixture(t);
  const { result } = await turn({ prompt: 'resolva', images: [PIXEL] });
  const file = result.response.match(/^- (.+\.png)$/m)?.[1];
  assert.ok(file, result.response);
  assert.deepEqual(fs.readFileSync(file), Buffer.from(PIXEL.data, 'base64'));
  assert.ok(result.response.endsWith('resolva'));
  fs.rmSync(file);
});

test('isolated runs use their own process and leave the warm session untouched', { timeout: 5000 }, async (t) => {
  fixture(t);
  for (const provider of ['claude', 'codex', 'antigravity']) {
    const warm = await bridge.prepareAgentSession({ provider });
    const reply = await bridge.runIsolatedAgent({ provider, prompt: 'extraia o currículo' });
    assert.equal(reply, 'extraia o currículo', provider);
    const again = await bridge.prepareAgentSession({ provider });
    assert.equal(again.pid, warm.pid, `${provider}: the warm session must survive an isolated run`);
  }
  await assert.rejects(bridge.runIsolatedAgent({ provider: 'claude', prompt: '__error__' }), /Falha simulada/);
});

test('one-shot turns use pre-started processes and leave the conversation untouched', { timeout: 3000 }, async (t) => {
  fixture(t);
  const conversation = await turn({ prompt: 'conversa' });
  bridge.prepareOneShotSessions({ provider: 'antigravity' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const started = Date.now();
  const cancelled = bridge.runAgyAgent({ prompt: '__wait__', oneShot: true, onMessage() {}, onError() {}, onClose() {} });
  cancelled.kill();
  const next = await turn({ prompt: 'rápida', oneShot: true });
  assert.ok(Date.now() - started < 140, 'the next one-shot turn must not wait for a cold start');
  assert.equal(next.result.response, 'rápida');
  assert.notEqual(next.handle.pid, cancelled.pid);
  assert.notEqual(next.result.conversation_id, conversation.result.conversation_id);
  const continued = await turn({ prompt: 'continua', conversationId: conversation.result.conversation_id });
  assert.equal(continued.handle.pid, conversation.handle.pid, 'the warm conversation keeps its process');
});

test('only Antigravity and HTTP providers answer live speech as one-shot turns', () => {
  assert.equal(bridge.runsOneShot('antigravity'), true);
  assert.equal(bridge.runsOneShot('gemini'), true);
  assert.equal(bridge.runsOneShot('codex'), false);
  assert.equal(bridge.runsOneShot('claude'), false);
});
