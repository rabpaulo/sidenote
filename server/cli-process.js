import { spawn as spawnDirect } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crossSpawn from 'cross-spawn';

const isWindows = process.platform === 'win32';

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

// Looks a command up on PATH, honoring PATHEXT on Windows (npm installs CLIs there as .cmd shims).
export function findOnPath(name, { env = process.env, platform = process.platform } = {}) {
  const windows = platform === 'win32';
  const dirs = (env.PATH || env.Path || '').split(windows ? ';' : ':').filter(Boolean);
  const exts = windows ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir.replace(/^"(.*)"$/, '$1'), name + ext.toLowerCase());
      if (isFile(file)) return file;
    }
  }
  return null;
}

const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

// Usual install locations when the CLI is not on the PATH the app was started with
// (desktop launchers often get a shorter PATH than the user's shell).
const KNOWN_LOCATIONS = {
  agy: isWindows
    ? [path.join(home, '.local', 'bin', 'agy.exe'), path.join(localAppData, 'Programs', 'agy', 'agy.exe'), path.join(appData, 'npm', 'agy.cmd')]
    : [path.join(home, '.local', 'bin', 'agy'), '/usr/local/bin/agy', '/usr/bin/agy'],
  codex: isWindows
    ? [path.join(appData, 'npm', 'codex.cmd'), path.join(home, '.local', 'bin', 'codex.exe')]
    : ['/usr/bin/codex', '/usr/local/bin/codex', path.join(home, '.local', 'bin', 'codex')],
  claude: isWindows
    ? [path.join(home, '.local', 'bin', 'claude.exe'), path.join(appData, 'npm', 'claude.cmd')]
    : [path.join(home, '.local', 'bin', 'claude'), '/usr/bin/claude', '/usr/local/bin/claude'],
  opencode: isWindows
    ? [path.join(appData, 'npm', 'opencode.cmd'), path.join(home, '.opencode', 'bin', 'opencode.exe')]
    : [path.join(home, '.opencode', 'bin', 'opencode'), path.join(home, '.local', 'bin', 'opencode'), '/usr/local/bin/opencode', '/usr/bin/opencode'],
};

const ENV_NAMES = { agy: 'AGY_BIN', codex: 'CODEX_BIN', claude: 'CLAUDE_BIN', opencode: 'OPENCODE_BIN' };

/**
 * Empty working directory for the agent CLIs. Outside the project, they find no
 * repository, AGENTS.md or CLAUDE.md to load or index before answering.
 */
export function agentWorkspace() {
  const dir = path.join(os.tmpdir(), 'interviewai-agent');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Path of a provider CLI: the *_BIN variable, then PATH, then the usual install locations. */
export function resolveCliBin(name, env = process.env) {
  const configured = env[ENV_NAMES[name]];
  if (configured) return configured;
  return findOnPath(name, { env }) || KNOWN_LOCATIONS[name]?.find(isFile) || name;
}

export function cliAvailable(bin) {
  return isFile(bin) || Boolean(findOnPath(bin));
}

/** Python 3 interpreter for the transcriber; Windows installs usually expose `python` or the `py` launcher. */
export function resolvePython(env = process.env) {
  if (env.PYTHON_BIN) return { command: env.PYTHON_BIN, args: [] };
  const candidates = isWindows ? ['python', 'py', 'python3'] : ['python3', 'python'];
  for (const name of candidates) {
    const found = findOnPath(name, { env });
    // The Microsoft Store stub in WindowsApps only opens the store; skip it when a real one exists.
    if (found && !/WindowsApps/i.test(found)) return { command: found, args: name === 'py' ? ['-3'] : [] };
  }
  return { command: candidates[0], args: [] };
}

/**
 * Spawns a CLI. On Windows, .cmd/.bat shims cannot be spawned directly, so
 * cross-spawn runs them through cmd.exe with the arguments escaped.
 */
export function spawnCli(command, args, options = {}) {
  const spawn = isWindows ? crossSpawn : spawnDirect;
  return spawn(command, args, { windowsHide: true, ...options });
}

/** Ends a CLI and, on Windows, the processes it started (a .cmd shim runs node as a child of cmd.exe). */
export function killProcessTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (isWindows && child.pid) {
    try {
      spawnDirect('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        .on('error', () => child.kill());
      return;
    } catch {}
  }
  try { child.kill(signal); } catch {}
}
