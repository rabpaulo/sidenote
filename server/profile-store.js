import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EMPTY_PROFILE, normalizeProfile } from '../shared/candidate-profile.js';

// Kept outside Electron's userData and the browser's localStorage, so the profile
// survives clearing app data, new sessions, rebuilds and dev/packaged origin changes.
export function defaultProfilePath(env = process.env, platform = process.platform) {
  if (env.SIDENOTE_PROFILE_PATH) return env.SIDENOTE_PROFILE_PATH;
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Sidenote', 'profile.json');
  }
  const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'sidenote', 'profile.json');
}

// The app was called InterviewAI; its folder moves once to the current name, keeping
// profile, history, models and venv. A failed move leaves the app starting empty.
export function migrateLegacyDataDir(env = process.env, platform = process.platform) {
  if (env.SIDENOTE_PROFILE_PATH) return;
  const dir = path.dirname(defaultProfilePath(env, platform));
  const legacy = path.join(path.dirname(dir), platform === 'win32' ? 'InterviewAI' : 'interviewai');
  if (existsSync(dir) || !existsSync(legacy)) return;
  try {
    renameSync(legacy, dir);
  } catch (error) {
    console.warn(`[Profile] Could not move ${legacy} to ${dir}: ${error.message}`);
  }
}

export function createProfileStore(file = defaultProfilePath()) {
  let pending = Promise.resolve();
  async function write(input) {
    const profile = normalizeProfile(input);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // Write-then-rename so a crash never leaves a half-written profile behind.
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), profile }, null, 2), { mode: 0o600 });
    await rename(temp, file);
    return profile;
  }
  return {
    file,
    async load() {
      try {
        return normalizeProfile(JSON.parse(await readFile(file, 'utf8')).profile);
      } catch (error) {
        if (error.code !== 'ENOENT') console.warn(`[Profile] Could not read ${file}: ${error.message}`);
        return normalizeProfile(EMPTY_PROFILE);
      }
    },
    // Saves run one at a time so concurrent requests never share the temp file.
    save(input) {
      const result = pending.then(() => write(input));
      pending = result.catch(() => {});
      return result;
    },
  };
}
