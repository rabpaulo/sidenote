import fs from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SPEECH_MODELS } from '../shared/speech-engines.js';

const MARKER = '.complete';
const PROGRESS_MS = 250;

// Extracts a .zip or .tar.* with the Python the app already requires, so no unzip
// or bzip2 tool is needed on any system. Only paths inside the folder are written.
const EXTRACT = `
import sys, tarfile, zipfile
source, target = sys.argv[1], sys.argv[2]
if zipfile.is_zipfile(source):
    with zipfile.ZipFile(source) as archive:
        archive.extractall(target)
else:
    with tarfile.open(source) as archive:
        try:
            archive.extractall(target, filter="data")
        except TypeError:
            archive.extractall(target)
`;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim().split('\n').at(-1) || `código ${code}`))));
  });
}

// An archive with a single top folder is flattened, so the model's files sit at the root.
async function flatten(dir) {
  const entries = fs.readdirSync(dir);
  if (entries.length !== 1) return;
  const inner = path.join(dir, entries[0]);
  if (!fs.statSync(inner).isDirectory()) return;
  for (const name of fs.readdirSync(inner)) await rename(path.join(inner, name), path.join(dir, name));
  await rm(inner, { recursive: true, force: true });
}

function folderBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    total += entry.isDirectory() ? folderBytes(file) : fs.statSync(file).size;
  }
  return total;
}

/**
 * Downloaded speech models, one folder each under `dir`. A model is installed when
 * its folder has the marker written after the last file; downloads go to a
 * `.partial` folder first, so a cancelled or failed one never looks installed.
 */
export function createModelStore({ dir, python = () => ({ command: 'python3', args: [] }), fetchImpl = fetch,
  onChange = () => {}, catalog = SPEECH_MODELS }) {
  const jobs = new Map();
  const errors = new Map();
  let lastNotice = 0;
  let noticeTimer = null;

  const folderOf = (id) => path.join(dir, id);
  const installed = (id) => fs.existsSync(path.join(folderOf(id), MARKER));

  // Progress is reported a few times a second; state changes right away.
  function changed(force = false) {
    const wait = lastNotice + PROGRESS_MS - Date.now();
    if (force || wait <= 0) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
      lastNotice = Date.now();
      onChange();
    } else {
      noticeTimer ||= setTimeout(() => changed(true), wait);
    }
  }

  async function fetchTo(url, file, job) {
    const response = await fetchImpl(url, { signal: job.controller.signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ao baixar ${path.basename(file)}`);
    const out = fs.createWriteStream(file);
    try {
      for await (const chunk of response.body) {
        job.received += chunk.length;
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
        changed();
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
  }

  async function install(id, job) {
    const model = catalog[id];
    const partial = `${folderOf(id)}.partial`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial, { recursive: true });
    try {
      if (model.archive) {
        const archive = path.join(dir, `${id}.download`);
        try {
          await fetchTo(model.archive, archive, job);
          job.phase = 'extracting';
          changed(true);
          const { command, args } = python();
          await run(command, [...args, '-c', EXTRACT, archive, partial]);
        } finally {
          await rm(archive, { force: true });
        }
        await flatten(partial);
      } else {
        for (const file of model.files) await fetchTo(file.url, path.join(partial, file.name), job);
      }
      await writeFile(path.join(partial, MARKER), JSON.stringify({ id, installedAt: new Date().toISOString() }));
      await rm(folderOf(id), { recursive: true, force: true });
      await rename(partial, folderOf(id));
    } catch (error) {
      await rm(partial, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  return {
    dir,
    installed,
    // The model's folder when it is installed.
    pathOf(id) {
      return installed(id) ? folderOf(id) : null;
    },

    status() {
      return Object.fromEntries(Object.keys(catalog).map((id) => {
        const job = jobs.get(id);
        let bytes = null;
        if (installed(id)) {
          try { bytes = folderBytes(folderOf(id)); } catch {}
        }
        return [id, {
          installed: installed(id),
          bytes,
          download: job ? { received: job.received, total: catalog[id].bytes, phase: job.phase } : null,
          error: errors.get(id) || null,
        }];
      }));
    },

    download(id) {
      if (!catalog[id]) throw new Error('Modelo desconhecido.');
      if (jobs.has(id)) return jobs.get(id).promise;
      errors.delete(id);
      const job = { controller: new AbortController(), received: 0, phase: 'downloading' };
      jobs.set(id, job);
      changed(true);
      job.promise = mkdir(dir, { recursive: true })
        .then(() => install(id, job))
        .then(() => true, (error) => {
          if (!job.controller.signal.aborted) {
            console.warn(`[Speech] Download of ${id} failed: ${error.message}`);
            errors.set(id, error.message);
          }
          return false;
        })
        .finally(() => {
          jobs.delete(id);
          changed(true);
        });
      return job.promise;
    },

    cancel(id) {
      const job = jobs.get(id);
      if (!job) return false;
      job.controller.abort();
      return true;
    },

    async remove(id) {
      if (!catalog[id]) throw new Error('Modelo desconhecido.');
      this.cancel(id);
      await jobs.get(id)?.promise;
      await rm(folderOf(id), { recursive: true, force: true });
      errors.delete(id);
      changed(true);
    },
  };
}
