import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProfileStore, defaultProfilePath, migrateLegacyDataDir } from './profile-store.js';
import { EMPTY_PROFILE, normalizeProfile } from '../shared/candidate-profile.js';

test('profile path lives outside the app data and honours overrides', () => {
  assert.equal(defaultProfilePath({ SIDENOTE_PROFILE_PATH: '/tmp/p.json' }), '/tmp/p.json');
  assert.equal(defaultProfilePath({ XDG_DATA_HOME: '/data' }, 'linux'), path.join('/data', 'sidenote', 'profile.json'));
  assert.equal(defaultProfilePath({ APPDATA: 'C:\\Users\\ana\\AppData\\Roaming' }, 'win32'),
    path.join('C:\\Users\\ana\\AppData\\Roaming', 'Sidenote', 'profile.json'));
});

test('saves atomically, reloads in a new store and survives a corrupt file', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'profile-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'profile.json');
  const store = createProfileStore(file);
  assert.deepEqual(await store.load(), normalizeProfile(EMPTY_PROFILE));
  await Promise.all([store.save({ name: 'A' }), store.save({ name: 'Ana', preferredLanguage: 'TypeScript' })]);
  const reloaded = await createProfileStore(file).load();
  assert.equal(reloaded.name, 'Ana');
  assert.equal(reloaded.preferredLanguage, 'TypeScript');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 1);
  await writeFile(file, '{oops');
  assert.deepEqual(await store.load(), normalizeProfile(EMPTY_PROFILE));
});

test('moves the folder from the old app name once, keeping its files', async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), 'profile-legacy-'));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  await mkdir(path.join(dataHome, 'interviewai', 'history'), { recursive: true });
  await writeFile(path.join(dataHome, 'interviewai', 'profile.json'), 'antigo');

  migrateLegacyDataDir({ XDG_DATA_HOME: dataHome }, 'linux');
  assert.equal(await readFile(path.join(dataHome, 'sidenote', 'profile.json'), 'utf8'), 'antigo');
  await assert.rejects(readFile(path.join(dataHome, 'interviewai', 'profile.json')));

  // An existing folder under the new name is never replaced.
  await mkdir(path.join(dataHome, 'interviewai'));
  await writeFile(path.join(dataHome, 'interviewai', 'profile.json'), 'outro');
  migrateLegacyDataDir({ XDG_DATA_HOME: dataHome }, 'linux');
  assert.equal(await readFile(path.join(dataHome, 'sidenote', 'profile.json'), 'utf8'), 'antigo');
});
