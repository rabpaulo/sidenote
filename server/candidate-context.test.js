import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCandidateContext } from './candidate-context.js';

test('reads the project context afresh and reports missing, blank and oversized files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'candidate-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'contexto.md');
  assert.equal((await readCandidateContext(root)).status, 404);
  await writeFile(file, '\uFEFF# Minha experiência\n\nDesenvolvimento web.\n');
  assert.deepEqual(await readCandidateContext(root), { status: 200, text: '# Minha experiência\n\nDesenvolvimento web.' });
  await writeFile(file, 'Contexto atualizado.');
  assert.equal((await readCandidateContext(root)).text, 'Contexto atualizado.');
  await writeFile(file, '  \n');
  assert.equal((await readCandidateContext(root)).status, 400);
  await writeFile(file, 'á'.repeat(6000));
  assert.equal((await readCandidateContext(root)).text.length, 6000);
  await writeFile(file, 'a'.repeat(6001));
  assert.equal((await readCandidateContext(root)).status, 400);
  await writeFile(file, 'a'.repeat(24001));
  assert.equal((await readCandidateContext(root)).status, 400);
  await rm(file);
  await mkdir(file);
  assert.equal((await readCandidateContext(root)).status, 400);
});
