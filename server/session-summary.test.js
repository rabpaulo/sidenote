import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionTranscript } from './session-transcript.js';
import { buildSummaryPrompt, createSummaryService, parseSummary, saveSessionMarkdown, sessionMarkdown } from './session-summary.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeRun() {
  const calls = [];
  const run = (options) => new Promise((resolve, reject) => {
    const call = { options, resolve, reject };
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelado'), { name: 'AbortError' })));
    calls.push(call);
  });
  return { run, calls };
}

function setup({ auto = true, error = null, busy = false } = {}) {
  let clock = 0;
  const transcript = createSessionTranscript({ now: () => (clock += 5000) });
  const { run, calls } = fakeRun();
  const updates = [];
  const settings = { auto, error, busy };
  const service = createSummaryService({
    transcript,
    run,
    config: () => ({ auto: settings.auto, provider: 'claude', model: 'claude-haiku-5-5', fastMode: true, error: settings.error }),
    canAutoStart: () => !settings.busy,
    onUpdate: (state) => updates.push(state),
    minNewLines: 2,
    autoDelayMs: 5,
    busyRetryMs: 5,
    log: { warn() {} },
  });
  const say = (role, text) => { if (transcript.add(role, text)) service.noteActivity(); };
  return { transcript, service, calls, updates, settings, say };
}

test('the prompt carries the whole transcript with roles and times', () => {
  const entries = [
    { role: 'interlocutor', text: 'Como você lida com prazos?', at: 1000 },
    { role: 'assistant', text: 'x'.repeat(900), at: 6000 },
    { role: 'user', text: 'Eu priorizo\ncom o time.', at: 65000 },
  ];
  const prompt = buildSummaryPrompt({ entries, startedAt: 1000 });
  assert.ok(prompt.includes('[00:00] Interlocutor: Como você lida com prazos?'));
  assert.ok(prompt.includes('[01:04] Você: Eu priorizo com o time.'));
  assert.ok(prompt.includes(`[00:05] Sugestão da IA: ${'x'.repeat(600)}…`), 'long AI answers are cut');
  assert.ok(prompt.includes('## Decisões e próximos passos'));
  assert.ok(!prompt.includes('Python'), 'no coding answer rules');
  assert.ok(buildSummaryPrompt({ entries, startedAt: 1000, final: true }).includes('A sessão terminou'));
});

test('a transcript too long for the prompt updates the previous summary with the new lines', () => {
  const entries = Array.from({ length: 6 }, (_, i) => ({ role: 'interlocutor', text: `fala ${i} ${'y'.repeat(40)}`, at: i * 1000 }));
  const prompt = buildSummaryPrompt({ entries, startedAt: 0, previous: { text: 'RESUMO VELHO', covered: 4 }, maxChars: 200 });
  assert.ok(prompt.includes('RESUMO ANTERIOR'));
  assert.ok(prompt.includes('RESUMO VELHO'));
  assert.ok(!prompt.includes('fala 3'), 'lines the previous summary covers are not resent');
  assert.ok(prompt.includes('fala 4') && prompt.includes('fala 5'));
  const noPrevious = buildSummaryPrompt({ entries, startedAt: 0, maxChars: 150 });
  assert.match(noPrevious, /as 4 primeiras falas foram omitidas/);
  assert.ok(noPrevious.includes('fala 5'), 'the newest lines are kept');
});

test('updates automatically after enough new lines, without streaming over the old text', async () => {
  const { service, calls, updates, say } = setup();
  say('interlocutor', 'Primeira pergunta');
  await tick(20);
  assert.equal(calls.length, 0, 'one line is not enough');
  say('user', 'Primeira resposta');
  await tick(20);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.reasoningEffort, 'low');
  assert.equal(calls[0].options.model, 'claude-haiku-5-5');
  assert.equal(calls[0].options.onText, undefined);
  calls[0].resolve('## Visão geral\nResumo 1');
  await tick();
  const state = service.state;
  assert.equal(state.status, 'idle');
  assert.equal(state.text, '## Visão geral\nResumo 1');
  assert.equal(state.covered, 2);
  assert.equal(state.stale, false);
  assert.ok(updates.some((update) => update.status === 'running'));

  say('interlocutor', 'Segunda pergunta');
  assert.equal(service.state.stale, true);
  await tick(20);
  assert.equal(calls.length, 1, 'waits for enough new lines again');
});

test('waits while a live answer is running', async () => {
  const { calls, settings, say } = setup({ busy: true });
  say('interlocutor', 'a');
  say('user', 'b');
  await tick(30);
  assert.equal(calls.length, 0);
  settings.busy = false;
  await tick(30);
  assert.equal(calls.length, 1);
});

test('a manual request streams, and one made while running reruns afterwards', async () => {
  const { service, calls, say } = setup({ auto: false });
  say('interlocutor', 'a');
  say('user', 'b');
  await tick(20);
  assert.equal(calls.length, 0, 'automatic updates are off');
  assert.equal(service.request(), true);
  assert.equal(calls[0].options.reasoningEffort, 'medium');
  calls[0].options.onText('Parcial');
  assert.equal(service.state.draft, 'Parcial');
  say('interlocutor', 'c');
  assert.equal(service.request(), false);
  calls[0].resolve('Resumo A');
  await tick();
  assert.equal(calls.length, 2, 'the queued request covers the new line');
  assert.ok(calls[1].options.prompt.includes('Interlocutor: c'));
  calls[1].resolve('Resumo B');
  await tick();
  assert.equal(service.state.text, 'Resumo B');
  assert.equal(service.state.draft, '');
});

test('errors keep the last summary, and an unusable model never starts', async () => {
  const { service, calls, settings, say } = setup({ auto: false });
  say('interlocutor', 'a');
  service.request();
  calls[0].resolve('Resumo bom');
  await tick();
  service.request();
  calls[1].reject(new Error('cota esgotada'));
  await tick();
  assert.equal(service.state.status, 'error');
  assert.equal(service.state.error, 'cota esgotada');
  assert.equal(service.state.text, 'Resumo bom');
  settings.error = 'O modelo não está disponível na sua conta.';
  assert.equal(service.request(), false);
  assert.equal(calls.length, 2);
  assert.equal(service.state.error, 'O modelo não está disponível na sua conta.');
});

test('nothing to summarize without a spoken line', () => {
  const { service, calls, transcript } = setup();
  transcript.add('assistant', 'Só uma sugestão');
  assert.equal(service.request(), false);
  assert.equal(calls.length, 0);
  assert.equal(service.state.error, 'Ainda não há falas para resumir.');
});

test('reset cancels the running summary and forgets the old one', async () => {
  const { service, calls, transcript, say } = setup({ auto: false });
  say('interlocutor', 'a');
  service.request();
  calls[0].resolve('Resumo');
  await tick();
  assert.deepEqual(service.current(), { text: 'Resumo', title: null, model: 'claude-haiku-5-5' });
  say('user', 'b');
  assert.equal(service.current(), null, 'a summary missing the last line is not current');
  service.request();
  transcript.clear();
  service.reset();
  await tick();
  assert.equal(service.state.text, '');
  assert.equal(service.state.status, 'idle');
  assert.equal(service.basis(), null);
});

test('markdown has the summary and the full transcript, and files never overwrite', async () => {
  const entries = [
    { role: 'interlocutor', text: 'Pergunta', at: Date.UTC(2026, 9, 16, 12, 0, 0) },
    { role: 'user', text: 'Resposta', at: Date.UTC(2026, 9, 16, 12, 1, 30) },
  ];
  const markdown = sessionMarkdown({ entries, startedAt: entries[0].at, summary: '## Visão geral\nOk', model: 'gpt-6-luna' });
  assert.match(markdown, /^---\ndata: 2026-10-16T12:00:00.000Z\nfim: 2026-10-16T12:01:30.000Z\nduracao: 01:30\norigem: InterviewAI\nmodelo_resumo: gpt-6-luna\n---/);
  assert.ok(markdown.includes('## Visão geral\nOk'));
  assert.ok(markdown.includes('**[01:30] Você**\nResposta'));
  assert.ok(sessionMarkdown({ entries, startedAt: entries[0].at }).includes('_Resumo não gerado._'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interviewai-sessions-'));
  try {
    const first = await saveSessionMarkdown(path.join(dir, 'novo'), markdown, entries[0].at);
    const second = await saveSessionMarkdown(path.join(dir, 'novo'), 'outra', entries[0].at);
    assert.match(path.basename(first), /^2026-10-16 \d{4} Sessão InterviewAI\.md$/);
    assert.match(path.basename(second), / \(2\)\.md$/);
    assert.equal(fs.readFileSync(first, 'utf8'), markdown);
    const titled = await saveSessionMarkdown(path.join(dir, 'novo'), 'x', entries[0].at, 'Entrevista: backend/Node?');
    assert.match(path.basename(titled), /^2026-10-16 \d{4} Entrevista backend Node\.md$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the model names the meeting on the first line of the summary', async () => {
  assert.ok(buildSummaryPrompt({ entries: [{ role: 'user', text: 'oi', at: 0 }], startedAt: 0 }).includes('Título:'));
  assert.deepEqual(parseSummary('Título: Entrevista backend na Acme\n\n## Visão geral\nOk'),
    { title: 'Entrevista backend na Acme', body: '## Visão geral\nOk' });
  assert.deepEqual(parseSummary('**Título:** "Planejamento do Q4".\n## Visão geral\nOk'),
    { title: 'Planejamento do Q4', body: '## Visão geral\nOk' });
  assert.deepEqual(parseSummary('## Visão geral\nSem título'), { title: null, body: '## Visão geral\nSem título' });
  assert.deepEqual(parseSummary('Título: ainda escreven'), { title: null, body: '' }, 'a streaming title line is hidden');

  const { service, calls, say } = setup({ auto: false });
  say('interlocutor', 'a');
  service.request();
  calls[0].resolve('Título: Conversa sobre prazos\n## Visão geral\nOk');
  await tick();
  assert.equal(service.state.title, 'Conversa sobre prazos');
  assert.equal(service.state.text, '## Visão geral\nOk');
  assert.equal(service.current().title, 'Conversa sobre prazos');
  const titled = sessionMarkdown({ entries: [{ role: 'user', text: 'oi', at: Date.UTC(2026, 9, 16, 12) }], title: 'Conversa sobre prazos' });
  assert.match(titled, /titulo: "Conversa sobre prazos"/);
  assert.match(titled, /# Conversa sobre prazos · 16\/10\/2026/);
});
