import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown, cleanMarkdown, createNotesIndex, tokenize } from './notes-index.js';

const PAYMENTS = `---
tags: [work]
---
# Plataforma de Pagamentos
Migrei o serviço de cobrança para Kafka.

## Métricas
A latência p99 caiu de 850 ms para 120 ms. Processamos 12 mil transações por segundo no pico.

## Time
Liderei 4 engenheiros entre 2022 e 2024.`;

function sampleIndex() {
  const index = createNotesIndex();
  index.add('Projetos/Pagamentos.md', PAYMENTS);
  index.add('Estudos/CAP.md', '# Teorema CAP\nConsistência, disponibilidade e tolerância a partições.');
  index.add('Vida/Salário.md', '# Pretensão salarial\nMínimo 18 mil CLT; ideal 22 mil.');
  index.add('Diario/2026-10-01.md', 'Reunião com o time hoje. Nada de mais.');
  return index;
}

test('folds accents, drops question words and keeps numbers', () => {
  assert.deepEqual(tokenize('Qual foi a Latência p99? 1.200 transações').map((token) => token.term),
    ['latencia', 'p99', '1.200', 'transacao']);
  const [token] = tokenize('a latência');
  assert.equal('a latência'.slice(token.start, token.end), 'latência');
});

test('chunks by heading, keeps the heading path and strips Obsidian syntax', () => {
  const chunks = chunkMarkdown(PAYMENTS, 'Projetos/Pagamentos.md');
  assert.deepEqual(chunks.map((chunk) => chunk.heading),
    ['Plataforma de Pagamentos', 'Plataforma de Pagamentos > Métricas', 'Plataforma de Pagamentos > Time']);
  assert.equal(chunks[0].title, 'Pagamentos');
  assert.ok(!chunks.some((chunk) => chunk.text.includes('tags:')));
  assert.equal(cleanMarkdown('Veja [[Projeto X|o projeto]] e [[Notas#Kafka]] ![[img.png]] %%oculto%%'),
    'Veja o projeto e Notas > Kafka  ');
  // A heading inside a code fence is code, not a section.
  assert.equal(chunkMarkdown('# A\n```\n# comentário\n```\ntexto', 'a.md').length, 1);
});

test('splits long sections so a hit points at the relevant paragraph', () => {
  const long = Array.from({ length: 6 }, (_, i) => `Parágrafo ${i} ${'palavra '.repeat(40)}`).join('\n\n');
  const chunks = chunkMarkdown(`# Longa\n${long}`, 'longa.md');
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 1200 && chunk.heading === 'Longa'));
});

test('finds the section that holds the requested figure', () => {
  const [hit] = sampleIndex().search('quantas transações por segundo vocês processavam?');
  assert.equal(hit.file, 'Projetos/Pagamentos.md');
  assert.equal(hit.heading, 'Plataforma de Pagamentos > Métricas');
  assert.match(hit.text, /12 mil transações/);
  assert.deepEqual(hit.highlights.map(([start, end]) => hit.snippet.slice(start, end)), ['Processamos', 'transações', 'segundo']);
});

test('matches the title and heading, and verb forms by their stem', () => {
  const index = sampleIndex();
  assert.equal(index.search('me fala sobre o teorema CAP')[0].file, 'Estudos/CAP.md');
  assert.equal(index.search('qual sua pretensão salarial?')[0].file, 'Vida/Salário.md');
  assert.equal(index.search('quantas pessoas você liderou?')[0].heading, 'Plataforma de Pagamentos > Time');
});

test('small talk and unknown subjects return nothing', () => {
  const index = sampleIndex();
  assert.deepEqual(index.search('oi, tudo bem com você?'), []);
  assert.deepEqual(index.search('como você lida com feedback negativo?'), []);
  assert.deepEqual(createNotesIndex().search('latência'), []);
});

test('replacing and removing a file updates the results', () => {
  const index = sampleIndex();
  index.add('Projetos/Pagamentos.md', '# Pagamentos\nA latência p99 ficou em 95 ms.');
  assert.match(index.search('latência p99')[0].text, /95 ms/);
  index.remove('Projetos/Pagamentos.md');
  assert.deepEqual(index.search('latência p99'), []);
  assert.deepEqual(index.size, { files: 3, chunks: 3 });
});

test('searches a large vault in a few milliseconds', () => {
  const index = createNotesIndex();
  for (let i = 0; i < 2000; i++) {
    index.add(`nota-${i}.md`, `# Projeto ${i}\nServiço ${i} usa fila ${i % 7} e banco ${i % 13}. Latência ${i} ms.\n\n## Time\nPessoas ${i % 9}.`);
  }
  index.add('alvo.md', '# Migração Kubernetes\nMigramos 40 microsserviços para Kubernetes em 2025.');
  const started = performance.now();
  const [hit] = index.search('quantos microsserviços vocês migraram para Kubernetes?');
  const elapsed = performance.now() - started;
  assert.equal(hit.file, 'alvo.md');
  assert.ok(elapsed < 50, `search took ${elapsed} ms`);
});
