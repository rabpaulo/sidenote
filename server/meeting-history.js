import fs from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const DRAFT_FILE = 'draft.json';
const SNIPPET_CHARS = 160;
const MIN_SPOKEN_LINES = 2;

// Lowercase without accents, with a map back to the original offsets for snippets.
function fold(text) {
  let folded = '';
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const part = text[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (let j = 0; j < part.length; j++) map.push(i);
    folded += part;
  }
  return { folded, map };
}

export function queryTokens(query) {
  return fold(String(query || '')).folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function spokenLines(entries = []) {
  return entries.filter((entry) => entry.role !== 'assistant').length;
}

function snippetAround(text, map, position, length) {
  const start = map[position] ?? 0;
  const end = map[position + length - 1] + 1 || start;
  const from = Math.max(0, start - Math.floor((SNIPPET_CHARS - (end - start)) / 2));
  const to = Math.min(text.length, from + SNIPPET_CHARS);
  return {
    text: `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ')}${to < text.length ? '…' : ''}`,
    match: text.slice(start, end),
  };
}

function searchable(record) {
  if (!record.search) {
    const transcript = (record.entries || []).filter((entry) => entry.role !== 'assistant').map((entry) => entry.text).join('\n');
    record.search = {
      title: fold(record.title || ''),
      summary: { source: record.summary || '', ...fold(record.summary || '') },
      transcript: { source: transcript, ...fold(transcript) },
    };
  }
  return record.search;
}

function scoreRecord(record, tokens) {
  const fields = searchable(record);
  let score = 0;
  let snippet = null;
  for (const token of tokens) {
    const inTitle = fields.title.folded.includes(token);
    const inSummary = fields.summary.folded.indexOf(token);
    const inTranscript = fields.transcript.folded.indexOf(token);
    if (!inTitle && inSummary < 0 && inTranscript < 0) return null;
    score += (inTitle ? 5 : 0) + (inSummary >= 0 ? 2 : 0) + (inTranscript >= 0 ? 1 : 0);
    if (!snippet) {
      // What was said is more telling than the summary when both match.
      const field = inTranscript >= 0 ? fields.transcript : inSummary >= 0 ? fields.summary : null;
      if (field) snippet = snippetAround(field.source, field.map, field.folded.indexOf(token), token.length);
    }
  }
  return { score, snippet };
}

function listItem(record, snippet = null) {
  const count = (role) => (record.entries || []).filter((entry) => entry.role === role).length;
  return {
    id: record.id,
    title: record.title,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    status: record.status,
    summaryError: record.summaryError || null,
    vaultFile: record.vaultFile || null,
    counts: { interlocutor: count('interlocutor'), user: count('user') },
    snippet,
  };
}

function publicRecord(record) {
  const { search, ...rest } = record;
  return rest;
}

/**
 * Finished meetings, one JSON file each. The meeting in progress is kept as a draft
 * so closing the app (or a crash) still leaves it in the history on the next start,
 * waiting for its summary and title.
 */
export function createMeetingHistory({ dir, onChange = () => {}, draftDelayMs = 2000, now = () => Date.now(), log = console }) {
  const records = new Map();
  let draft = null;
  let draftTimer = null;
  // Draft writes and removals run in order, so a late write never revives a cleared draft.
  let draftWrites = Promise.resolve();
  const draftFile = path.join(dir, DRAFT_FILE);

  const fileOf = (id) => path.join(dir, `${id}.json`);

  async function persist(record) {
    await mkdir(dir, { recursive: true });
    const file = fileOf(record.id);
    const temp = `${file}.tmp`;
    await writeFile(temp, JSON.stringify(publicRecord(record), null, 2));
    await rename(temp, file);
  }

  function save(record) {
    return persist(record).catch((error) => log.error?.(`[History] Could not save ${record.id}: ${error.message}`));
  }

  function newId(endedAt) {
    return `${endedAt}-${randomBytes(3).toString('hex')}`;
  }

  function insert({ entries, endedAt = entries.at(-1)?.at ?? now(), startedAt = entries[0]?.at ?? endedAt, status,
    title = null, summary = null, model = null }) {
    const record = {
      id: newId(endedAt), title, startedAt, endedAt, status, summary, model, summaryError: null,
      entries: entries.map(({ role, text, at }) => ({ role, text, at })),
    };
    records.set(record.id, record);
    return record;
  }

  return {
    // Reads the saved meetings; a draft left by the last run becomes a meeting waiting for its summary.
    load() {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch (error) {
        if (error.code !== 'ENOENT') log.error?.(`[History] Could not read ${dir}: ${error.message}`);
        return [];
      }
      for (const name of names) {
        if (!name.endsWith('.json') || name === DRAFT_FILE) continue;
        try {
          const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
          if (record?.id && Array.isArray(record.entries)) {
            // A summary cut short by a restart is retried like a draft.
            if (record.status === 'summarizing') record.status = 'pending';
            records.set(record.id, record);
          }
        } catch (error) {
          log.warn?.(`[History] Skipping ${name}: ${error.message}`);
        }
      }
      try {
        const left = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
        if (Array.isArray(left?.entries) && spokenLines(left.entries) >= MIN_SPOKEN_LINES) {
          const record = insert({ entries: left.entries, startedAt: left.startedAt ?? undefined, status: 'pending' });
          fs.writeFileSync(fileOf(record.id), JSON.stringify(publicRecord(record), null, 2));
          log.log?.(`[History] Recovered the meeting left open at ${new Date(record.endedAt).toISOString()}`);
        }
        fs.rmSync(draftFile, { force: true });
      } catch (error) {
        if (error.code !== 'ENOENT') log.warn?.(`[History] Could not recover the draft: ${error.message}`);
      }
      return [...records.values()].filter((record) => record.status === 'pending').map((record) => record.id);
    },

    list({ query = '', limit = 200 } = {}) {
      const tokens = queryTokens(query);
      const all = [...records.values()].sort((a, b) => b.endedAt - a.endedAt);
      if (!tokens.length) return all.slice(0, limit).map((record) => listItem(record));
      return all
        .map((record) => ({ record, found: scoreRecord(record, tokens) }))
        .filter(({ found }) => found)
        .sort((a, b) => b.found.score - a.found.score || b.record.endedAt - a.record.endedAt)
        .slice(0, limit)
        .map(({ record, found }) => listItem(record, found.snippet));
    },

    get(id) {
      const record = records.get(id);
      return record ? publicRecord(record) : null;
    },

    // Adds a finished meeting; returns null when too little was said to keep it.
    add({ entries, ...rest }) {
      if (spokenLines(entries) < MIN_SPOKEN_LINES) return null;
      const record = insert({ entries, status: 'pending', ...rest });
      save(record);
      onChange();
      return publicRecord(record);
    },

    update(id, patch) {
      const record = records.get(id);
      if (!record) return null;
      Object.assign(record, patch);
      delete record.search;
      save(record);
      onChange();
      return publicRecord(record);
    },

    async remove(id) {
      if (!records.delete(id)) return false;
      await rm(fileOf(id), { force: true });
      onChange();
      return true;
    },

    // The meeting in progress, written a moment after it changes.
    saveDraft(meeting) {
      draft = meeting;
      if (draftTimer) return;
      draftTimer = setTimeout(() => {
        draftTimer = null;
        const current = draft;
        draftWrites = draftWrites.then(async () => {
          if (!current || draft !== current) return;
          await mkdir(dir, { recursive: true });
          await writeFile(draftFile, JSON.stringify(current));
        }).catch((error) => log.warn?.(`[History] Could not save the draft: ${error.message}`));
      }, draftDelayMs);
      draftTimer.unref?.();
    },

    // On shutdown there is no time for the timer.
    flushDraft() {
      clearTimeout(draftTimer);
      draftTimer = null;
      if (!draft || spokenLines(draft.entries) < MIN_SPOKEN_LINES) return;
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(draftFile, JSON.stringify(draft));
      } catch (error) {
        log.warn?.(`[History] Could not save the draft: ${error.message}`);
      }
    },

    clearDraft() {
      clearTimeout(draftTimer);
      draftTimer = null;
      draft = null;
      fs.rmSync(draftFile, { force: true });
      draftWrites = draftWrites.then(() => rm(draftFile, { force: true })).catch(() => {});
    },
  };
}
