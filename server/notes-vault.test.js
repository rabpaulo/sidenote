import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNotesLookup, createNotesVault } from './notes-vault.js';
import { buildAgentPrompt, notesPromptBlock } from './agent-prompt.js';
import { buildCopilotPrompt } from './gemini-copilot.js';

const quiet = { log() {}, warn() {} };

async function makeVault(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notes-vault-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vault = path.join(dir, 'vault');
  await mkdir(path.join(vault, 'Projetos'), { recursive: true });
  await mkdir(path.join(vault, '.obsidian'), { recursive: true });
  await writeFile(path.join(vault, 'Projetos', 'Pagamentos.md'), '# Pagamentos\n## Métricas\nLatência p99 de 120 ms.');
  await writeFile(path.join(vault, '.obsidian', 'workspace.md'), '# Latência p99 configuração');
  await writeFile(path.join(vault, 'imagem.png'), 'latência');
  return { dir, vault, configFile: path.join(dir, 'config', 'notes.json') };
}

async function until(check, timeout = 3000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('indexes only Markdown notes outside hidden folders and remembers the vault', async (t) => {
  const { vault, configFile } = await makeVault(t);
  const notes = createNotesVault({ configFile, log: quiet });
  t.after(() => notes.close());
  const status = await notes.connect(vault);
  assert.equal(status.files, 1);
  assert.equal(notes.search('latência p99')[0].file, 'Projetos/Pagamentos.md');
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).vaultPath, vault);

  const reopened = createNotesVault({ configFile, log: quiet });
  t.after(() => reopened.close());
  assert.equal((await reopened.load()).files, 1);
  await reopened.disconnect();
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).vaultPath, null);
  assert.deepEqual(reopened.search('latência'), []);
});

test('picks up edits, new notes and deletions while connected', async (t) => {
  const { vault, configFile } = await makeVault(t);
  const notes = createNotesVault({ configFile, log: quiet });
  t.after(() => notes.close());
  await notes.connect(vault);
  await writeFile(path.join(vault, 'Kafka.md'), '# Kafka\nUsamos 48 partições por tópico.');
  await until(() => notes.search('partições kafka').length);
  await unlink(path.join(vault, 'Projetos', 'Pagamentos.md'));
  await until(() => !notes.search('latência p99').length);
  assert.equal(notes.status.files, 1);
});

test('rejects a missing folder and keeps the saved path visible after a failed load', async (t) => {
  const { dir, configFile } = await makeVault(t);
  const notes = createNotesVault({ configFile, log: quiet });
  await assert.rejects(notes.connect(path.join(dir, 'nao-existe')), { status: 400 });
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify({ vaultPath: path.join(dir, 'sumiu') }));
  const status = await notes.load();
  assert.equal(status.connected, false);
  assert.equal(status.path, path.join(dir, 'sumiu'));
  assert.match(status.error, /não encontrada/);
});

test('lookup announces hits only when they change for an utterance', () => {
  const sent = [];
  let results = [];
  const lookup = createNotesLookup({ search: () => results, onHits: (key, hits) => sent.push([key, hits.map((hit) => hit.id)]) });
  lookup.lookup('u1', 'qual');
  results = [{ id: 'a#1', file: 'a.md', title: 'a', heading: '', text: 'texto completo', snippet: 's', highlights: [] }];
  lookup.lookup('u1', 'qual a latência');
  lookup.lookup('u1', 'qual a latência p99');
  results = [];
  lookup.lookup('u1', 'qual a latência p99 hoje');
  assert.deepEqual(sent, [['u1', ['a#1']], ['u1', []]]);
  assert.equal(lookup.lookup(null, 'x').length, 0);
});

test('prompts carry the note sections only when there are hits', () => {
  const notes = [{ title: 'Pagamentos', heading: 'Métricas', text: 'Latência p99 de 120 ms.' }];
  assert.equal(notesPromptBlock([]), '');
  assert.match(notesPromptBlock(notes), /"nota":"Pagamentos > Métricas","trecho":"Latência p99 de 120 ms."/);
  assert.match(buildAgentPrompt('qual a latência?', {}, notes), /TRECHOS DAS NOTAS/);
  assert.doesNotMatch(buildAgentPrompt('qual a latência?'), /TRECHOS DAS NOTAS/);
  assert.match(buildCopilotPrompt('qual a latência?', 'general', false, '', [], notes), /valor exato/);
  assert.doesNotMatch(buildCopilotPrompt('qual a latência?'), /TRECHOS DAS NOTAS/);
  // The prompt stays bounded however long the sections are.
  const long = Array.from({ length: 5 }, (_, i) => ({ title: `n${i}`, heading: '', text: 'x'.repeat(5000) }));
  assert.ok(notesPromptBlock(long).length < 2600);
});
