import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createModelStore } from './speech-models.js';
import { createSpeechSettings, installSteps, pipCommand } from './speech-settings.js';
import { resolvePython } from './cli-process.js';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidenote-speech-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Serves bytes in small pieces, optionally waiting on `gate` before the last one.
function fakeFetch(bodies, { gate = null } = {}) {
  return async (url, { signal }) => {
    const body = bodies[url];
    if (!body) return new Response(null, { status: 404 });
    const pieces = [body.subarray(0, Math.ceil(body.length / 2)), body.subarray(Math.ceil(body.length / 2))];
    const stream = new ReadableStream({
      async pull(controller) {
        if (signal.aborted) return controller.error(new DOMException('aborted', 'AbortError'));
        const piece = pieces.shift();
        if (!piece) return controller.close();
        if (!pieces.length && gate) await gate;
        if (signal.aborted) return controller.error(new DOMException('aborted', 'AbortError'));
        controller.enqueue(piece);
      },
    });
    return new Response(stream, { status: 200 });
  };
}

const CATALOG = {
  files: { engine: 'faster-whisper', bytes: 10, files: [{ name: 'a.txt', url: 'https://x/a' }, { name: 'model.bin', url: 'https://x/m' }] },
  zipped: { engine: 'vosk', bytes: 10, archive: 'https://x/z' },
};

test('a model is installed only once every file is in place, and can be removed', async (t) => {
  const dir = scratch(t);
  let notices = 0;
  const store = createModelStore({
    dir, catalog: CATALOG, onChange: () => notices++,
    fetchImpl: fakeFetch({ 'https://x/a': Buffer.from('hello'), 'https://x/m': Buffer.from('weights!') }),
  });
  assert.equal(store.status().files.installed, false);
  assert.equal(await store.download('files'), true);
  assert.equal(store.installed('files'), true);
  assert.equal(fs.readFileSync(path.join(store.pathOf('files'), 'model.bin'), 'utf8'), 'weights!');
  assert.equal(store.status().files.bytes > 0, true);
  assert.ok(notices > 0);
  await store.remove('files');
  assert.equal(store.installed('files'), false);
  assert.equal(fs.existsSync(path.join(dir, 'files')), false);
});

test('a cancelled or failed download leaves nothing that looks installed', async (t) => {
  const dir = scratch(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const store = createModelStore({ dir, catalog: CATALOG, fetchImpl: fakeFetch({ 'https://x/a': Buffer.from('hello'), 'https://x/m': Buffer.from('weights!') }, { gate }) });
  const pending = store.download('files');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(store.status().files.download, 'the download is reported while it runs');
  store.cancel('files');
  release();
  assert.equal(await pending, false);
  assert.equal(store.installed('files'), false);
  assert.equal(store.status().files.error, null, 'a cancel is not an error');
  assert.deepEqual(fs.readdirSync(dir), []);

  const broken = createModelStore({ dir, catalog: CATALOG, fetchImpl: fakeFetch({ 'https://x/a': Buffer.from('hello') }) });
  assert.equal(await broken.download('files'), false);
  assert.match(broken.status().files.error, /404/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

const python = resolvePython();
const hasPython = (() => {
  try { execFileSync(python.command, [...python.args, '-c', 'pass']); return true; } catch { return false; }
})();

test('an archive is extracted with Python and its single top folder flattened', { skip: !hasPython && 'needs Python' }, async (t) => {
  const dir = scratch(t);
  const zip = path.join(dir, 'source.zip');
  execFileSync(python.command, [...python.args, '-c',
    'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as z:\n    z.writestr("model-1.0/am/final.mdl", "kaldi")\n    z.writestr("model-1.0/README", "hi")', zip]);
  const models = path.join(dir, 'models');
  const store = createModelStore({ dir: models, python: () => python, catalog: CATALOG, fetchImpl: fakeFetch({ 'https://x/z': fs.readFileSync(zip) }) });
  assert.equal(await store.download('zipped'), true);
  assert.equal(fs.readFileSync(path.join(store.pathOf('zipped'), 'am', 'final.mdl'), 'utf8'), 'kaldi');
  assert.deepEqual(fs.readdirSync(models), ['zipped'], 'the archive itself is removed');
});

test('the pip command targets the Python the app uses, or creates the app venv when pip is refused', () => {
  assert.equal(pipCommand({ python: '/home/u/.local/share/sidenote/venv/bin/python', venv: true }, ['sherpa-onnx'], '/d'),
    '/home/u/.local/share/sidenote/venv/bin/python -m pip install sherpa-onnx');
  assert.equal(pipCommand({ python: 'C:\\Program Files\\Python312\\python.exe', venv: false, externallyManaged: false }, ['vosk'], '/d'),
    '"C:\\Program Files\\Python312\\python.exe" -m pip install vosk');
  const created = pipCommand({ python: '/usr/bin/python3', venv: false, externallyManaged: true }, ['faster-whisper'], '/data');
  assert.match(created, /^python3 -m venv .*venv && .*pip install SpeechRecognition faster-whisper$/);
  assert.equal(pipCommand({}, [], '/d'), null);
});

test('the install steps use the app venv when the system Python refuses pip', () => {
  assert.deepEqual(installSteps({ python: '/v/bin/python', venv: true }, ['vosk'], '/d'),
    [{ command: '/v/bin/python', args: ['-m', 'pip', 'install', 'vosk'] }]);
  const [create, install] = installSteps({ python: '/usr/bin/python3', venv: false, externallyManaged: true }, ['sherpa-onnx'], '/data');
  assert.deepEqual(create, { command: '/usr/bin/python3', args: ['-m', 'venv', path.join('/data', 'venv')] });
  assert.deepEqual(install.args, ['-m', 'pip', 'install', 'SpeechRecognition', 'sherpa-onnx']);
  assert.match(install.command, /venv/);
  assert.deepEqual(installSteps({}, [], '/d'), []);
});

test('settings persist and give the worker the paths of the chosen engine', async (t) => {
  const dir = scratch(t);
  const installed = new Set(['vosk-small-pt', 'faster-whisper-base']);
  const models = {
    dir: path.join(dir, 'models'),
    installed: (id) => installed.has(id),
    pathOf: (id) => (installed.has(id) ? path.join(dir, 'models', id) : null),
    status: () => ({}),
  };
  const settings = createSpeechSettings({ dataDir: dir, models, env: { PYTHON_BIN: 'python3' } });
  // Parakeet is the default; without its model the worker reports it and Google takes over.
  assert.deepEqual(settings.workerConfig(), { engine: 'parakeet', modelDir: null });
  settings.save({ engine: 'vosk' });
  assert.deepEqual(settings.workerConfig(), { engine: 'vosk', modelDirs: { 'pt-BR': path.join(dir, 'models', 'vosk-small-pt') } });
  settings.save({ engine: 'faster-whisper', variant: 'base' });
  assert.deepEqual(settings.workerConfig(), { engine: 'faster-whisper', modelDir: path.join(dir, 'models', 'faster-whisper-base') });
  assert.throws(() => settings.save({ engine: 'nope' }));

  const reloaded = createSpeechSettings({ dataDir: dir, models, env: { PYTHON_BIN: 'python3' } });
  assert.deepEqual(reloaded.settings, { engine: 'faster-whisper', variant: 'base' });
  const status = reloaded.status();
  assert.equal(status.engines['faster-whisper'].modelsReady, true);
  assert.equal(status.engines.parakeet.modelsReady, false);
  assert.equal(status.engines['whisper-turbo'].binary.found, false);
});

test('Parakeet is ready with only its model, even without Python', async (t) => {
  const dir = scratch(t);
  const models = {
    dir: path.join(dir, 'models'),
    installed: (id) => id === 'parakeet-tdt-0.6b-v3-int8',
    pathOf: (id) => (id === 'parakeet-tdt-0.6b-v3-int8' ? path.join(dir, 'models', id) : null),
    status: () => ({}),
  };
  const settings = createSpeechSettings({ dataDir: dir, models, env: { PYTHON_BIN: path.join(dir, 'no-python') } });
  await settings.refreshProbe();
  const status = settings.status();
  assert.ok(status.python.error);
  assert.equal(status.engines.parakeet.ready, true);
  assert.equal(status.engines.vosk.ready, false);
});
