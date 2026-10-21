import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLspciName, parseNvidiaSmi, parseWindowsGpus, scanHardware } from './hardware.js';

test('nvidia-smi lines become GPUs with their VRAM', () => {
  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 4090, 24564\nNVIDIA GeForce RTX 3060, 12288\n'), [
    { name: 'NVIDIA GeForce RTX 4090', vendor: 'nvidia', vramGb: 24, dedicated: true },
    { name: 'NVIDIA GeForce RTX 3060', vendor: 'nvidia', vramGb: 12, dedicated: true },
  ]);
  assert.deepEqual(parseNvidiaSmi(''), []);
  assert.deepEqual(parseNvidiaSmi('NVIDIA-SMI has failed because it could not communicate'), []);
});

test('lspci names keep the marketing name in brackets', () => {
  assert.equal(parseLspciName('03:00.0 "VGA compatible controller" "Advanced Micro Devices, Inc. [AMD/ATI]" "Navi 23 [Radeon RX 6600/6600 XT/6600M]" -rc7'),
    'Radeon RX 6600/6600 XT/6600M');
  assert.equal(parseLspciName('00:02.0 "VGA compatible controller" "Intel Corporation" "UHD Graphics 630"'), 'UHD Graphics 630');
  assert.equal(parseLspciName(''), null);
});

test('Windows registry entries give real VRAM and skip virtual adapters', () => {
  const gpus = parseWindowsGpus(JSON.stringify([
    { name: 'AMD Radeon RX 7800 XT', memory: 17163091968 },
    { name: 'Intel(R) UHD Graphics 770', memory: 134217728 },
    { name: 'Microsoft Basic Display Adapter', memory: null },
  ]));
  assert.deepEqual(gpus, [
    { name: 'AMD Radeon RX 7800 XT', vendor: 'amd', vramGb: 16, dedicated: true },
    { name: 'Intel(R) UHD Graphics 770', vendor: 'intel', vramGb: 0, dedicated: false },
  ]);
  // A single adapter comes back as an object, not a list.
  assert.equal(parseWindowsGpus('{"name":"NVIDIA GeForce RTX 3070","memory":8589934592}')[0].vramGb, 8);
  assert.deepEqual(parseWindowsGpus('not json'), []);
});

test('Apple Silicon reports its unified memory', async () => {
  const hardware = await scanHardware({ platform: 'darwin', arch: 'arm64' });
  assert.equal(hardware.gpus.length, 1);
  assert.equal(hardware.gpus[0].unified, true);
  assert.ok(hardware.ramGb > 0);
});
