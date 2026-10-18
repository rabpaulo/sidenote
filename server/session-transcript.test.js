import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTranscript } from './session-transcript.js';

test('keeps every line in order and counts only what people said', () => {
  let clock = 1000;
  const transcript = createSessionTranscript({ now: () => clock++ });
  assert.equal(transcript.add('interlocutor', '  Fale sobre você.  '), true);
  assert.equal(transcript.add('assistant', 'Sugestão'), true);
  assert.equal(transcript.add('user', 'Sou desenvolvedor.'), true);
  assert.equal(transcript.add('system', 'ignorado'), false);
  assert.equal(transcript.add('user', '   '), false);
  assert.deepEqual(transcript.entries().map(({ role, text }) => [role, text]), [
    ['interlocutor', 'Fale sobre você.'], ['assistant', 'Sugestão'], ['user', 'Sou desenvolvedor.'],
  ]);
  assert.equal(transcript.spokenCount, 2);
  assert.equal(transcript.startedAt, 1000);
});

test('a repeated trigger of the last line is not recorded twice', () => {
  const transcript = createSessionTranscript();
  transcript.add('interlocutor', 'Pergunta');
  assert.equal(transcript.add('interlocutor', 'Pergunta'), false);
  transcript.add('user', 'Resposta');
  assert.equal(transcript.add('interlocutor', 'Pergunta'), true, 'asked again later is a new line');
});

test('an AI answer with the same id replaces its earlier version', () => {
  const transcript = createSessionTranscript();
  transcript.add('interlocutor', 'Pergunta');
  transcript.add('assistant', 'Prévia', { id: 'copilot-pc-1' });
  const version = transcript.version;
  assert.equal(transcript.add('assistant', 'Resposta completa', { id: 'copilot-pc-1' }), true);
  assert.equal(transcript.version, version + 1);
  assert.deepEqual(transcript.entries().map((entry) => entry.text), ['Pergunta', 'Resposta completa']);
  assert.equal(transcript.add('assistant', 'Resposta completa', { id: 'copilot-pc-1' }), false);
});

test('clear starts a new session and changes the version', () => {
  const transcript = createSessionTranscript({ maxEntries: 2 });
  transcript.add('user', 'a');
  transcript.add('user', 'b');
  transcript.add('user', 'c');
  assert.deepEqual(transcript.entries().map((entry) => entry.text), ['b', 'c']);
  const version = transcript.version;
  transcript.clear();
  assert.equal(transcript.entries().length, 0);
  assert.equal(transcript.startedAt, null);
  assert.notEqual(transcript.version, version);
});
