import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMeetingHistory, queryTokens } from './meeting-history.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const quiet = { log() {}, warn() {}, error() {} };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sidenote-history-'));
}

const meeting = (lines, start = 1000) => lines.map(([role, text], i) => ({ role, text, at: start + i * 1000 }));

test('meetings are saved, listed newest first and survive a restart', async () => {
  const dir = tempDir();
  try {
    let changes = 0;
    const history = createMeetingHistory({ dir, onChange: () => changes++, log: quiet });
    history.load();
    assert.equal(history.add({ entries: meeting([['user', 'só uma fala']]) }), null, 'too little to keep');
    const first = history.add({ entries: meeting([['interlocutor', 'Fale de Kubernetes'], ['user', 'Uso em produção']], 1000) });
    const second = history.add({ entries: meeting([['interlocutor', 'Orçamento do trimestre'], ['user', 'Fechamos em março']], 50000) });
    assert.equal(first.endedAt, 2000, 'ends at the last line');
    assert.equal(first.status, 'pending');
    history.update(second.id, { title: 'Planejamento financeiro', status: 'done', summary: '## Visão geral\nOrçamento' });
    assert.deepEqual(history.list().map((item) => item.id), [second.id, first.id]);
    assert.equal(changes, 3);
    await tick(20);

    const reloaded = createMeetingHistory({ dir, log: quiet });
    assert.deepEqual(reloaded.load(), [first.id], 'meetings still waiting for a summary are reported');
    assert.equal(reloaded.get(second.id).title, 'Planejamento financeiro');
    assert.equal(reloaded.get(first.id).entries[0].text, 'Fale de Kubernetes');
    assert.ok(await reloaded.remove(first.id));
    assert.equal(reloaded.get(first.id), null);
    assert.ok(!fs.existsSync(path.join(dir, `${first.id}.json`)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search ignores case and accents, needs every word and ranks title matches first', () => {
  const dir = tempDir();
  try {
    const history = createMeetingHistory({ dir, log: quiet });
    const talk = history.add({ entries: meeting([['interlocutor', 'Como você usa ORÇAMENTOS no projeto?'], ['user', 'Planilhas']]) });
    const titled = history.add({ entries: meeting([['interlocutor', 'Bom dia'], ['user', 'Bom dia']], 9000) });
    history.update(titled.id, { title: 'Revisão de orçamento' });
    assert.deepEqual(queryTokens('Orçamento, Q4!'), ['orcamento', 'q4']);
    assert.deepEqual(history.list({ query: 'orcamento' }).map((item) => item.id), [titled.id, talk.id]);
    assert.deepEqual(history.list({ query: 'orcamento planilhas' }).map((item) => item.id), [talk.id]);
    assert.deepEqual(history.list({ query: 'kubernetes' }), []);
    const [hit] = history.list({ query: 'projeto' });
    assert.match(hit.snippet.text, /usa ORÇAMENTOS no projeto/);
    assert.equal(hit.snippet.match, 'projeto');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a meeting left open by closing the app comes back waiting for its summary', () => {
  const dir = tempDir();
  try {
    const running = createMeetingHistory({ dir, log: quiet });
    running.saveDraft({ startedAt: 1000, entries: meeting([['interlocutor', 'Pergunta'], ['user', 'Resposta']]) });
    running.flushDraft();
    const next = createMeetingHistory({ dir, log: quiet });
    const [id] = next.load();
    assert.equal(next.get(id).status, 'pending');
    assert.equal(next.get(id).endedAt, 2000);
    assert.ok(!fs.existsSync(path.join(dir, 'draft.json')));
    assert.equal(createMeetingHistory({ dir, log: quiet }).load().length, 1, 'recovered only once');
    next.saveDraft({ startedAt: 1, entries: meeting([['user', 'x'], ['user', 'y']]) });
    next.clearDraft();
    next.flushDraft();
    assert.ok(!fs.existsSync(path.join(dir, 'draft.json')), 'an archived meeting leaves no draft');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the draft is written after a pause and a cleared draft stays cleared', async () => {
  const dir = tempDir();
  try {
    const history = createMeetingHistory({ dir, draftDelayMs: 5, log: quiet });
    history.saveDraft({ startedAt: 1, entries: meeting([['user', 'a'], ['user', 'b']]) });
    await tick(30);
    assert.ok(fs.existsSync(path.join(dir, 'draft.json')));
    history.saveDraft({ startedAt: 1, entries: meeting([['user', 'a'], ['user', 'b'], ['user', 'c']]) });
    await tick(6);
    history.clearDraft();
    await tick(30);
    assert.ok(!fs.existsSync(path.join(dir, 'draft.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
