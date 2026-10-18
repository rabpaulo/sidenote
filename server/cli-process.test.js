import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findOnPath, resolveCliBin } from './cli-process.js';

test('finds CLIs on PATH, including Windows .cmd shims through PATHEXT', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cli-path-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'codex.cmd'), '@echo off');
  await writeFile(path.join(dir, 'claude'), '#!/bin/sh');
  assert.equal(findOnPath('codex', { env: { PATH: `C:\\nada;${dir}`, PATHEXT: '.EXE;.CMD' }, platform: 'win32' }), path.join(dir, 'codex.cmd'));
  assert.equal(findOnPath('codex', { env: { PATH: dir }, platform: 'linux' }), null);
  assert.equal(findOnPath('claude', { env: { PATH: dir }, platform: 'linux' }), path.join(dir, 'claude'));
});

test('an explicit *_BIN variable always wins', () => {
  assert.equal(resolveCliBin('claude', { CLAUDE_BIN: '/opt/claude' }), '/opt/claude');
  assert.equal(resolveCliBin('agy', { AGY_BIN: 'C:\\tools\\agy.exe' }), 'C:\\tools\\agy.exe');
});
