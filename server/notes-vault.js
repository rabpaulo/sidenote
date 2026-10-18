import { watch } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNotesIndex } from './notes-index.js';

export const MAX_NOTE_FILES = 5000;
const MAX_NOTE_BYTES = 512 * 1024;
const READ_BATCH = 32;
const WATCH_DEBOUNCE_MS = 300;
// Obsidian's own settings, the trash and tool folders hold no notes worth answering from.
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.obsidian', '.trash']);

const isNote = (name) => /\.md$/i.test(name);
const toKey = (relative) => relative.split(path.sep).join('/');

function expandHome(dir) {
  return dir === '~' || dir.startsWith(`~${path.sep}`) || dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(1)) : dir;
}

async function listNotes(root) {
  const files = [];
  let truncated = false;
  const walk = async (dir) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MAX_NOTE_FILES) { truncated = true; return; }
      if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && isNote(entry.name)) files.push(full);
    }
  };
  await walk(root);
  return { files, truncated };
}

async function readNote(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_NOTE_BYTES) return null;
  return readFile(file, 'utf8');
}

// The vault path is the only setting; it lives next to the candidate profile.
export function createNotesVault({ configFile, log = console } = {}) {
  let index = createNotesIndex();
  let root = null;
  let watcher = null;
  let generation = 0;
  let status = { connected: false, path: null, files: 0, chunks: 0, indexedAt: null, indexMs: 0, truncated: false, error: null };
  const timers = new Map();

  function closeWatcher() {
    watcher?.close();
    watcher = null;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  function refreshCounts() {
    const { files, chunks } = index.size;
    status = { ...status, files, chunks };
  }

  async function reindexFile(key, current) {
    if (current !== generation) return;
    const full = path.join(root, ...key.split('/'));
    try {
      const text = await readNote(full);
      if (current !== generation) return;
      if (text === null) index.remove(key);
      else index.add(key, text);
    } catch (error) {
      if (current !== generation) return;
      if (error.code !== 'ENOENT') log.warn?.(`[Notes] Could not read ${key}: ${error.message}`);
      index.remove(key);
      // A removed or renamed folder only reports its own name.
      const prefix = `${key}/`;
      for (const file of index.files()) if (file.startsWith(prefix)) index.remove(file);
    }
    refreshCounts();
  }

  function startWatcher(current) {
    try {
      watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const key = toKey(String(filename));
        if (key.split('/').some((part) => part.startsWith('.') || SKIPPED_DIRS.has(part))) return;
        clearTimeout(timers.get(key));
        timers.set(key, setTimeout(() => {
          timers.delete(key);
          if (isNote(key)) reindexFile(key, current);
          else stat(path.join(root, key)).then((info) => {
            // A folder moved into the vault arrives as a single event.
            if (info.isDirectory() && current === generation) indexAll(current, { keepWatcher: true });
          }, () => reindexFile(key, current));
        }, WATCH_DEBOUNCE_MS));
      });
      watcher.on('error', (error) => log.warn?.(`[Notes] Watch stopped: ${error.message}`));
    } catch (error) {
      log.warn?.(`[Notes] Could not watch ${root}: ${error.message}. Use Reindexar after editing notes.`);
    }
  }

  async function indexAll(current, { keepWatcher = false } = {}) {
    const started = Date.now();
    const { files, truncated } = await listNotes(root);
    if (current !== generation) return;
    const fresh = createNotesIndex();
    for (let i = 0; i < files.length; i += READ_BATCH) {
      const batch = files.slice(i, i + READ_BATCH);
      const texts = await Promise.all(batch.map((file) => readNote(file).catch(() => null)));
      if (current !== generation) return;
      texts.forEach((text, j) => { if (text !== null) fresh.add(toKey(path.relative(root, batch[j])), text); });
    }
    // Searches keep using the previous index until the new one is complete.
    index = fresh;
    status = { ...status, indexedAt: new Date().toISOString(), indexMs: Date.now() - started, truncated, error: null };
    refreshCounts();
    if (!keepWatcher) startWatcher(current);
    log.log?.(`[Notes] Indexed ${status.files} notes (${status.chunks} sections) from ${root} in ${status.indexMs} ms`);
  }

  async function persist(vaultPath) {
    if (!configFile) return;
    await mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
    const temp = `${configFile}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, vaultPath }, null, 2), { mode: 0o600 });
    await rename(temp, configFile);
  }

  async function connect(dir, { save = true } = {}) {
    if (typeof dir !== 'string' || !dir.trim()) throw Object.assign(new Error('Informe a pasta da vault.'), { status: 400 });
    const resolved = path.resolve(expandHome(dir.trim()));
    let info;
    try { info = await stat(resolved); } catch { info = null; }
    if (!info?.isDirectory()) throw Object.assign(new Error(`Pasta não encontrada: ${resolved}`), { status: 400 });
    const current = ++generation;
    closeWatcher();
    index = createNotesIndex();
    root = resolved;
    status = { connected: true, path: resolved, files: 0, chunks: 0, indexedAt: null, indexMs: 0, truncated: false, error: null };
    if (save) await persist(resolved);
    await indexAll(current);
    return status;
  }

  return {
    get status() { return status; },
    async load() {
      if (!configFile) return status;
      let vaultPath = null;
      try {
        ({ vaultPath } = JSON.parse(await readFile(configFile, 'utf8')));
        if (vaultPath) await connect(vaultPath, { save: false });
      } catch (error) {
        if (error.code === 'ENOENT') return status;
        // Keep the saved path so the UI can show what failed and offer to fix it.
        status = { ...status, path: vaultPath || null, error: error.message };
        log.warn?.(`[Notes] ${error.message}`);
      }
      return status;
    },
    connect,
    async reindex() {
      if (!root) throw Object.assign(new Error('Nenhuma vault conectada.'), { status: 400 });
      return connect(root, { save: false });
    },
    async disconnect() {
      generation++;
      closeWatcher();
      index = createNotesIndex();
      root = null;
      status = { connected: false, path: null, files: 0, chunks: 0, indexedAt: null, indexMs: 0, truncated: false, error: null };
      await persist(null);
      return status;
    },
    search: (query, options) => index.search(query, options),
    close: closeWatcher,
  };
}

// The UI card gets the snippet only; the prompt gets the full section text.
export function publicHit({ id, file, title, heading, snippet, highlights }) {
  return { id, file, title, heading, snippet, highlights };
}

// Remembers the last hits per utterance so repeated partials with the same
// result do not re-render the card.
export function createNotesLookup({ search, onHits, maxKeys = 16 }) {
  const last = new Map();
  return {
    lookup(key, text) {
      const hits = search(text);
      if (!key) return hits;
      const signature = hits.map((hit) => hit.id).join('|');
      const previous = last.get(key);
      if (previous === undefined ? hits.length : previous !== signature) onHits(key, hits.map(publicHit));
      last.delete(key);
      last.set(key, signature);
      if (last.size > maxKeys) last.delete(last.keys().next().value);
      return hits;
    },
    clear: () => last.clear(),
  };
}
