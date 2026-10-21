import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_MODEL_CATALOG, memoryBudget, rateLocalModel, recommendLocalModels } from './local-providers.js';
import { providerDetected } from './provider-availability.js';

const recommended = (hardware) => recommendLocalModels(hardware).find((model) => model.recommended)?.id;
const model = (id) => LOCAL_MODEL_CATALOG.find((entry) => entry.id === id);

test('each hardware tier gets the best model that still answers live', () => {
  assert.equal(recommended({ ramGb: 8, gpus: [] }), 'qwen3.5:2b');
  assert.equal(recommended({ ramGb: 16, gpus: [] }), 'qwen3.5:4b');
  // Mixture of experts reads few weights per token, so it runs on a CPU with enough RAM.
  assert.equal(recommended({ ramGb: 32, gpus: [] }), 'gpt-oss:20b');
  assert.equal(recommended({ ramGb: 16, gpus: [{ vendor: 'amd', dedicated: true, vramGb: 8 }] }), 'gemma4:12b');
  assert.equal(recommended({ ramGb: 32, gpus: [{ vendor: 'nvidia', dedicated: true, vramGb: 24 }] }), 'qwen3.6:27b');
  assert.equal(recommended({ ramGb: 128, gpus: [{ vendor: 'apple', unified: true, vramGb: 128 }] }), 'gpt-oss:120b');
  assert.equal(recommended({ ramGb: 192, gpus: [{ vendor: 'apple', unified: true, vramGb: 192 }] }), 'qwen3.5:122b');
});

test('integrated graphics count as CPU and a tiny machine still gets something', () => {
  const hardware = { ramGb: 6, gpus: [{ vendor: 'intel', dedicated: false, vramGb: 0 }] };
  assert.equal(memoryBudget(hardware).vramGb, 0);
  assert.equal(recommended(hardware), 'qwen3.5:0.8b');
  // With 4 GB the system and the meeting app leave no room for a model.
  assert.equal(recommended({ ramGb: 4, gpus: [] }), undefined);
});

test('a model is rated by where its weights fit', () => {
  const gpu8 = { ramGb: 16, gpus: [{ dedicated: true, vramGb: 8 }] };
  assert.deepEqual(rateLocalModel(model('qwen3.5:4b'), gpu8).fit, 'gpu');
  assert.equal(rateLocalModel(model('qwen3.5:9b'), gpu8).fit, 'partial');
  assert.equal(rateLocalModel(model('qwen3.6:27b'), gpu8).fit, 'none');
  // Dense weights spilling far into RAM are slow; experts are not.
  const gpu12 = { ramGb: 64, gpus: [{ dedicated: true, vramGb: 12 }] };
  assert.equal(rateLocalModel(model('qwen3.6:27b'), gpu12).speed, 'slow');
  assert.equal(rateLocalModel(model('qwen3.6:35b'), gpu12).speed, 'medium');
  // The largest GPU drives the budget.
  assert.equal(memoryBudget({ ramGb: 16, gpus: [{ dedicated: true, vramGb: 4 }, { dedicated: true, vramGb: 12 }] }).vramGb, 12 * 0.95);
});

test('only providers found on the machine count as detected', () => {
  assert.equal(providerDetected(undefined), null);
  assert.equal(providerDetected({ status: 'checking' }), null);
  assert.equal(providerDetected({ status: 'unavailable', installed: false }), false);
  assert.equal(providerDetected({ status: 'unavailable', needsKey: true }), false);
  // Installed but logged out still shows, with its reason.
  assert.equal(providerDetected({ status: 'unavailable', reason: 'login' }), true);
  assert.equal(providerDetected({ status: 'unknown' }), true);
  assert.equal(providerDetected({ status: 'available', installed: true }), true);
});
