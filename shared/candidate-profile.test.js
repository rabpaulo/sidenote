import test from 'node:test';
import assert from 'node:assert/strict';
import { composeCandidateContext, EMPTY_PROFILE, isProfileEmpty, mergeImportedFields, normalizeProfile } from './candidate-profile.js';
import { buildAgentPrompt } from '../server/agent-prompt.js';

test('normalizes untrusted profiles to known fields and limits', () => {
  const profile = normalizeProfile({
    name: 'Ana', years: '5 anos', unknown: 'x', preferredLanguage: 7,
    stack: ['React', ' react ', '', 'Node.js', 42],
    experiences: [{ title: 'Checkout', story: 'Reduzi erros.', extra: true }, null, 'texto'],
  });
  assert.equal(profile.unknown, undefined);
  assert.equal(profile.years, '5');
  assert.equal(profile.preferredLanguage, '');
  assert.deepEqual(profile.stack, ['React', 'Node.js']);
  assert.deepEqual(profile.experiences, [{ title: 'Checkout', story: 'Reduzi erros.' }]);
  assert.deepEqual(normalizeProfile(null), normalizeProfile(EMPTY_PROFILE));
});

test('composes only the filled sections, in a stable order', () => {
  assert.equal(composeCandidateContext(EMPTY_PROFILE), '');
  assert.equal(isProfileEmpty({ experiences: [{ title: ' ', story: '' }] }), true);
  const text = composeCandidateContext({
    name: 'Ana', role: 'Backend', seniority: 'Sênior', years: '1', preferredLanguage: 'TypeScript',
    stack: ['Node.js', 'PostgreSQL'], experiences: [{ title: '', story: 'Migrei a fila.' }],
    jobCompany: 'Loja', notes: 'Inglês avançado.',
  });
  assert.equal(text, [
    '## Perfil\nNome: Ana\nCargo atual: Backend\nNível: Sênior, 1 ano de experiência\nLinguagem preferida para código: TypeScript\nTecnologias que domino: Node.js, PostgreSQL',
    '## Experiências reais\n### Experiência\nMigrei a fila.',
    '## Entrevista atual\nEmpresa: Loja',
    '## Outras informações\nInglês avançado.',
  ].join('\n\n'));
});

test('chat prompts default code answers to the preferred language', () => {
  assert.match(buildAgentPrompt('Resolva two sum'), /em Python se nenhuma for mencionada/);
  assert.match(buildAgentPrompt('Resolva two sum', { preferredLanguage: 'TypeScript' }), /em TypeScript, mesmo que o editor de uma captura de tela esteja em outra linguagem/);
});

test('company context is part of the current interview block', () => {
  assert.equal(composeCandidateContext({ jobCompany: 'Acme', jobCompanyContext: 'Produtos de IA e de infraestrutura.', jobRole: 'SRE' }),
    '## Entrevista atual\nEmpresa: Acme\nSobre a empresa e seus produtos: Produtos de IA e de infraestrutura.\nVaga: SRE');
});

test('imported fields replace filled values, extend the stack and append notes', () => {
  const draft = { name: 'Ana', role: 'Dev', stack: ['React'], notes: 'Inglês avançado.', jobCompany: 'Acme',
    experiences: [{ title: 'Antiga', story: 'x' }] };
  const merged = mergeImportedFields(draft, {
    name: 'Ana Souza', role: '', stack: ['react', 'Go'], notes: 'Formação: UFMG.',
    experiences: [{ title: 'Loja', story: 'Migrei a fila.' }], unknown: 'x',
  });
  assert.equal(merged.name, 'Ana Souza');
  assert.equal(merged.role, 'Dev', 'empty imported values keep what the user typed');
  assert.deepEqual(merged.stack, ['React', 'Go']);
  assert.equal(merged.notes, 'Inglês avançado.\n\nFormação: UFMG.');
  assert.deepEqual(merged.experiences, [{ title: 'Loja', story: 'Migrei a fila.' }]);
  assert.equal(merged.jobCompany, 'Acme');
  assert.equal(merged.unknown, undefined);
  assert.equal(mergeImportedFields(merged, { notes: 'Formação: UFMG.' }).notes, merged.notes, 'reimporting does not duplicate notes');
});
