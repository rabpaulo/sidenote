import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationMemory } from './conversation-memory.js';

test('keeps actual inputs separate from suggestions and does not repeat the current question', () => {
  const memory = createConversationMemory();
  memory.remember('interlocutor', 'Estamos falando de cache.');
  memory.remember('user', 'Implementei Redis no projeto.');
  memory.remember('copilot', 'Liderei uma equipe de 20 pessoas.');
  memory.remember('assistant', 'Experiência inventada.');
  memory.remember('interlocutor', 'E a invalidação?');
  memory.remember('interlocutor', ' E a invalidação? ');
  const recent = memory.beforeQuestion('E a invalidação?');
  assert.deepEqual(recent, [
    { role: 'interlocutor', text: 'Estamos falando de cache.' },
    { role: 'user', text: 'Implementei Redis no projeto.' },
  ]);
  recent[0].text = 'Alteração externa';
  assert.equal(memory.beforeQuestion('E a invalidação?')[0].text, 'Estamos falando de cache.');
  memory.clear();
  assert.deepEqual(memory.beforeQuestion('Nova sessão'), []);
});

test('memory stays bounded and marks truncated utterances rather than claiming completeness', () => {
  const memory = createConversationMemory({ maxTurns: 3, maxCharacters: 3500 });
  for (let i = 0; i < 6; i++) memory.remember('interlocutor', `Pergunta ${i}`);
  assert.equal(memory.beforeQuestion('outra').length, 3);
  assert.equal(memory.beforeQuestion('outra')[0].text, 'Pergunta 3');
  memory.remember('user', 'a'.repeat(4000));
  assert.equal(memory.beforeQuestion('outra').at(-1).truncated, true);
  memory.remember('interlocutor', 'b'.repeat(1500));
  assert.ok(memory.beforeQuestion('outra').reduce((size, turn) => size + turn.text.length, 0) <= 3500);
});
