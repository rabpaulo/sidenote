import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { findOnPath, resolvePython } from './cli-process.js';
import { DEFAULT_SPEECH_ENGINE, SPEECH_ENGINES, SPEECH_MODELS, requiredModels, speechEngine } from '../shared/speech-engines.js';

const isWindows = process.platform === 'win32';

// The app's own virtual environment, next to the profile. Linux distributions mark
// the system Python as externally managed, so pip installs go there instead.
export function venvDir(dataDir) {
  return path.join(dataDir, 'venv');
}

function venvPython(dataDir) {
  const file = isWindows ? path.join(venvDir(dataDir), 'Scripts', 'python.exe') : path.join(venvDir(dataDir), 'bin', 'python');
  return fs.existsSync(file) ? file : null;
}

/** PYTHON_BIN, then the app's venv, then the system Python. */
export function speechPython(dataDir, env = process.env) {
  if (env.PYTHON_BIN) return { command: env.PYTHON_BIN, args: [] };
  const venv = venvPython(dataDir);
  if (venv) return { command: venv, args: [] };
  return resolvePython(env);
}

/** WHISPER_SERVER_BIN, then <data>/bin/whisper-server, then the PATH. */
export function whisperServerBin(dataDir, env = process.env) {
  if (env.WHISPER_SERVER_BIN) return fs.existsSync(env.WHISPER_SERVER_BIN) ? env.WHISPER_SERVER_BIN : null;
  const local = path.join(dataDir, 'bin', isWindows ? 'whisper-server.exe' : 'whisper-server');
  if (fs.existsSync(local)) return local;
  return findOnPath('whisper-server', { env }) || null;
}

const PROBE = `
import importlib.util, json, os, sys, sysconfig
modules = sys.argv[1:]
print(json.dumps({
  "python": sys.executable,
  "version": "%d.%d.%d" % sys.version_info[:3],
  "venv": sys.prefix != sys.base_prefix,
  "externallyManaged": sys.prefix == sys.base_prefix and os.path.exists(os.path.join(sysconfig.get_path("stdlib"), "EXTERNALLY-MANAGED")),
  "modules": {name: importlib.util.find_spec(name) is not None for name in modules},
}))
`;

function probePython({ command, args }) {
  const modules = [...new Set(SPEECH_ENGINES.flatMap((engine) => engine.packages.map((item) => item.module)))];
  return new Promise((resolve) => {
    execFile(command, [...args, '-c', PROBE, ...modules], { timeout: 15000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve({ error: `Python não encontrado ou com erro (${command}).` });
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ error: 'Não foi possível verificar os pacotes Python.' });
      }
    });
  });
}

const quote = (value) => (/\s/.test(value) ? `"${value}"` : value);

// The exact command that installs what an engine lacks, for the Python the app uses.
export function pipCommand(probe, packages, dataDir) {
  if (!packages.length) return null;
  const names = packages.join(' ');
  if (probe?.venv || !probe?.externallyManaged) {
    const python = probe?.python ? quote(probe.python) : isWindows ? 'py' : 'python3';
    return `${python} -m pip install ${names}`;
  }
  // The system Python refuses pip: create the app's venv, with the recognizer Google needs too.
  const venv = venvDir(dataDir);
  const pip = isWindows ? path.join(venv, 'Scripts', 'pip') : path.join(venv, 'bin', 'pip');
  const all = [...new Set(['SpeechRecognition', ...packages])].join(' ');
  return `python3 -m venv ${quote(venv)} && ${quote(pip)} install ${all}`;
}

/** The same install as pipCommand, as the programs to run one after the other. */
export function installSteps(probe, packages, dataDir) {
  if (!packages.length) return [];
  if (probe?.venv || !probe?.externallyManaged) {
    return [{ command: probe?.python || (isWindows ? 'py' : 'python3'), args: ['-m', 'pip', 'install', ...packages] }];
  }
  const venv = venvDir(dataDir);
  const python = isWindows ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
  return [
    { command: probe.python || 'python3', args: ['-m', 'venv', venv] },
    { command: python, args: ['-m', 'pip', 'install', ...new Set(['SpeechRecognition', ...packages])] },
  ];
}

function runStep({ command, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => {
      const lastLine = stderr.trim().split('\n').filter((line) => !/^\s*(WARNING|\[notice\])/.test(line)).at(-1);
      code === 0 ? resolve() : reject(new Error(lastLine || `${path.basename(command)} terminou com código ${code}`));
    });
  });
}

/**
 * The chosen engine (persisted in speech.json next to the profile), what each engine
 * still lacks, and the config the transcribe.py worker is started with.
 */
export function createSpeechSettings({ dataDir, models, env = process.env, onChange = () => {}, onInstalled = () => {} }) {
  const file = path.join(dataDir, 'speech.json');
  let settings = { engine: DEFAULT_SPEECH_ENGINE, variant: 'small' };
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (speechEngine(saved.engine)) settings.engine = saved.engine;
    if (saved.variant === 'small' || saved.variant === 'base') settings.variant = saved.variant;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[Speech] Could not read ${file}: ${error.message}`);
  }
  let probe = null;
  let probing = null;
  // The engine whose Python packages are being installed, and the last failure of each.
  let installing = null;
  const installErrors = new Map();

  const python = () => speechPython(dataDir, env);

  function refreshProbe() {
    probing ||= probePython(python()).then((result) => {
      probe = result;
      probing = null;
      return result;
    });
    return probing;
  }

  function engineStatus(engine) {
    const missingPackages = probe?.modules
      ? engine.packages.filter((item) => !probe.modules[item.module]).map((item) => item.pip)
      : [];
    const binary = engine.binary ? whisperServerBin(dataDir, env) : null;
    const needed = requiredModels(engine.id, settings.variant);
    const installedModels = needed.filter((id) => models.installed(id));
    const modelsReady = engine.id === 'vosk' ? installedModels.length > 0 : installedModels.length === needed.length;
    return {
      id: engine.id,
      missingPackages,
      pip: pipCommand(probe, missingPackages, dataDir),
      binary: engine.binary ? { path: binary, found: !!binary } : null,
      modelsReady,
      ready: !probe?.error && missingPackages.length === 0 && (!engine.binary || !!binary) && modelsReady,
      installing: installing === engine.id,
      installError: installErrors.get(engine.id) || null,
    };
  }

  return {
    file,
    python,
    refreshProbe,
    get settings() { return { ...settings }; },

    save(next) {
      if (next.engine !== undefined) {
        if (!speechEngine(next.engine)) throw new Error('Motor de reconhecimento desconhecido.');
        settings.engine = next.engine;
      }
      if (next.variant !== undefined) {
        if (next.variant !== 'small' && next.variant !== 'base') throw new Error('Variante desconhecida.');
        settings.variant = next.variant;
      }
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ version: 1, ...settings }, null, 2));
      return { ...settings };
    },

    /** Installs the engine's missing Python packages in the background (see installSteps). */
    async install(engineId) {
      const engine = speechEngine(engineId);
      if (!engine) throw new Error('Motor de reconhecimento desconhecido.');
      if (installing) throw new Error('Já há uma instalação em andamento.');
      await refreshProbe();
      if (probe?.error) throw new Error(probe.error);
      const steps = installSteps(probe, engineStatus(engine).missingPackages, dataDir);
      if (!steps.length) return;
      installing = engine.id;
      installErrors.delete(engine.id);
      (async () => {
        try {
          for (const step of steps) await runStep(step);
          console.log(`[Speech] Installed the Python packages of ${engine.id}`);
        } catch (error) {
          console.warn(`[Speech] Could not install the packages of ${engine.id}: ${error.message}`);
          installErrors.set(engine.id, error.message);
        }
        installing = null;
        await refreshProbe();
        onInstalled();
        onChange();
      })();
    },

    status() {
      return {
        ...settings,
        python: probe ? { path: probe.python || null, version: probe.version || null, venv: !!probe.venv, error: probe.error || null } : null,
        venv: venvDir(dataDir),
        modelsDir: models.dir,
        // Where a whisper-server put by hand is found (see whisperServerBin).
        binDir: path.join(dataDir, 'bin'),
        engines: Object.fromEntries(SPEECH_ENGINES.map((engine) => [engine.id, engineStatus(engine)])),
        models: models.status(),
      };
    },

    /** What transcribe.py --serve is started with for the chosen engine. */
    workerConfig() {
      const { engine, variant } = settings;
      if (engine === 'google') return { engine };
      const needed = requiredModels(engine, variant);
      if (engine === 'vosk') {
        return {
          engine,
          modelDirs: Object.fromEntries(needed.filter((id) => models.installed(id))
            .map((id) => [SPEECH_MODELS[id].language, models.pathOf(id)])),
        };
      }
      const modelDir = models.pathOf(needed[0]);
      if (engine === 'whisper-turbo') {
        const name = SPEECH_MODELS[needed[0]].files[0].name;
        return { engine, modelFile: modelDir ? path.join(modelDir, name) : null, whisperServer: whisperServerBin(dataDir, env) };
      }
      return { engine, modelDir };
    },
  };
}
