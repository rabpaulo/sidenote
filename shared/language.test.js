import test from 'node:test';
import assert from 'node:assert/strict';
import { createUtteranceLanguage } from './language.js';

test('auto mode asks for every language, preferring the last one heard', () => {
  assert.equal(createUtteranceLanguage('auto').request, 'pt-BR,en-US');
  assert.equal(createUtteranceLanguage('auto', 'en-US').request, 'en-US,pt-BR');
});

test('auto mode locks the utterance to the first recognized language', () => {
  const language = createUtteranceLanguage('auto');
  language.observe({ error: 'Não foi possível entender o áudio', code: 'unrecognized' });
  assert.equal(language.detected, null);
  language.observe({ text: 'tell me about yourself', language: 'en-US' });
  language.observe({ text: 'e você', language: 'pt-BR' });
  assert.equal(language.request, 'en-US');
  assert.equal(language.detected, 'en-US');
});

test('a fixed language is never overridden', () => {
  const language = createUtteranceLanguage('pt-BR', 'en-US');
  language.observe({ text: 'hello', language: 'en-US' });
  assert.equal(language.request, 'pt-BR');
});
