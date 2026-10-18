import test from 'node:test';
import assert from 'node:assert/strict';
import { welcomeNeeds } from './welcome.js';

const speech = (engine, ready) => ({ engine, engines: { [engine]: { ready } } });

test('a fresh install needs a provider and a speech model', () => {
  const needs = welcomeNeeds({ antigravity: { status: 'unavailable' }, gemini: { status: 'unavailable' } }, speech('parakeet', false));
  assert.deepEqual(needs, { known: true, provider: true, speech: true });
});

test('one usable provider or one whose check failed is enough', () => {
  assert.equal(welcomeNeeds({ codex: { status: 'available' }, gemini: { status: 'unavailable' } }, speech('parakeet', true)).provider, false);
  assert.equal(welcomeNeeds({ codex: { status: 'unknown' } }, speech('parakeet', true)).provider, false);
});

test('nothing is decided while a check is running or the speech status has not arrived', () => {
  assert.equal(welcomeNeeds({ codex: { status: 'checking' } }, speech('google', true)).known, false);
  assert.equal(welcomeNeeds({ codex: { status: 'available' } }, null).known, false);
  assert.equal(welcomeNeeds({}, speech('google', true)).known, false);
});
