import fs from 'node:fs';
import path from 'node:path';
import { API_PROVIDERS, isApiProvider } from '../shared/api-providers.js';
import { defaultProfilePath } from './profile-store.js';

// API keys saved in the app live next to the profile, readable only by the user.
// The client never receives a saved key back, only whether one exists and its last
// characters. A key in the environment (OPENAI_API_KEY...) is used when none is saved.
export function defaultKeysPath(env = process.env) {
  return env.INTERVIEWAI_KEYS_PATH || path.join(path.dirname(defaultProfilePath(env)), 'api-keys.json');
}

const MAX_KEY_LENGTH = 400;

export function createProviderKeys({ file = defaultKeysPath(), env = process.env } = {}) {
  let saved = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')).keys || {};
    saved = Object.fromEntries(Object.entries(parsed).filter(([id, key]) => isApiProvider(id) && typeof key === 'string' && key));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[Keys] Could not read ${file}: ${error.message}`);
  }

  function write() {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Write-then-rename so a crash never leaves a half-written file behind.
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, keys: saved }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  const envKey = (provider) => API_PROVIDERS[provider].env.map((name) => env[name]).find(Boolean) || null;

  return {
    file,
    /** The key a request uses: the saved one, then the environment. */
    get(provider) {
      if (!isApiProvider(provider)) return null;
      return saved[provider] || envKey(provider);
    },
    set(provider, key) {
      if (!isApiProvider(provider)) throw new Error('Provedor desconhecido.');
      const value = typeof key === 'string' ? key.trim() : '';
      if (!value) throw new Error('Informe a API key.');
      if (value.length > MAX_KEY_LENGTH || /\s/.test(value)) throw new Error('A API key não parece válida.');
      saved = { ...saved, [provider]: value };
      write();
    },
    remove(provider) {
      if (!saved[provider]) return;
      const { [provider]: _removed, ...rest } = saved;
      saved = rest;
      write();
    },
    /** What the client may see: where each key comes from and its last characters. */
    summary() {
      return Object.fromEntries(Object.keys(API_PROVIDERS).map((provider) => {
        const key = this.get(provider);
        const source = saved[provider] ? 'saved' : key ? 'env' : null;
        return [provider, { configured: Boolean(key), source, hint: key ? `…${key.slice(-4)}` : null }];
      }));
    },
    /** Environment for OpenCode, so it offers the models of every provider with a key. */
    opencodeEnv() {
      return Object.fromEntries(Object.values(API_PROVIDERS)
        .map(({ id, opencodeEnv }) => [opencodeEnv, this.get(id)])
        .filter(([, key]) => key));
    },
  };
}

export const providerKeys = createProviderKeys();
