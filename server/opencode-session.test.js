import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpencodeModel, opencodeAgentFor } from './opencode-session.js';

test('OpenCode models are provider/model and its own models keep the default agent', () => {
  assert.deepEqual(parseOpencodeModel('openrouter/meta/llama-4'), { providerID: 'openrouter', modelID: 'meta/llama-4' });
  assert.equal(parseOpencodeModel('sem-barra'), null);
  assert.equal(opencodeAgentFor('opencode/big-pickle'), 'build');
  assert.equal(opencodeAgentFor('verboo/glm-5.2'), 'interviewai');
});
