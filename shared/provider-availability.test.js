import test from 'node:test';
import assert from 'node:assert/strict';
import { availableSelection, providerModels, unavailableReason } from './provider-availability.js';

const PROVIDERS = {
  claude: { defaultModel: 'claude-sonnet-5-5', models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }] },
  opencode: { defaultModel: null, dynamicModels: true, models: [] },
};

test('providers without a fixed list offer the models their account listed', () => {
  const entry = { status: 'available', models: ['opencode/big-pickle', 'verboo/glm-5.2'],
    catalog: [{ id: 'opencode/big-pickle', name: 'opencode/big-pickle' }, { id: 'verboo/glm-5.2', name: 'verboo/glm-5.2' }] };
  assert.deepEqual(providerModels(PROVIDERS.opencode, entry).map((model) => model.id), ['opencode/big-pickle', 'verboo/glm-5.2']);
  assert.deepEqual(providerModels(PROVIDERS.claude, undefined).map((model) => model.id), ['claude-sonnet-5-5']);
});

test('a listed provider with no model chosen falls back to its first model', () => {
  const availability = { opencode: { status: 'available', models: ['opencode/big-pickle'], catalog: [{ id: 'opencode/big-pickle', name: 'Big Pickle' }] } };
  assert.equal(unavailableReason(availability, 'opencode', null), 'Nenhum modelo escolhido.');
  assert.equal(unavailableReason(availability, 'opencode'), null);
  assert.deepEqual(availableSelection(availability, PROVIDERS, 'opencode', null),
    { provider: 'opencode', model: 'opencode/big-pickle', modelName: 'Big Pickle' });
});
