import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { saveSessionMarkdown, sessionMarkdown } from './session-summary.js';

// Notes written by the app go in one folder, so they are easy to find or exclude.
export const VAULT_FOLDER = 'Sidenote';

function insideVault(vaultPath, file) {
  const relative = path.relative(vaultPath, file);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// The note a meeting already has in this vault, if it is still there.
export async function existingNote(vaultPath, record) {
  const file = record.vaultFile;
  if (!file || !insideVault(vaultPath, file)) return null;
  const info = await stat(file).catch(() => null);
  return info?.isFile() ? file : null;
}

// Writes a history meeting as a Markdown note in the vault. Saving the same meeting
// again rewrites its note instead of adding a copy.
export async function writeMeetingNote(vaultPath, record) {
  const markdown = sessionMarkdown({
    entries: record.entries, startedAt: record.startedAt, summary: record.summary,
    model: record.model, title: record.title, now: record.endedAt,
  });
  const previous = await existingNote(vaultPath, record);
  if (previous) {
    await writeFile(previous, markdown);
    return previous;
  }
  return saveSessionMarkdown(path.join(vaultPath, VAULT_FOLDER), markdown, record.endedAt, record.title);
}
