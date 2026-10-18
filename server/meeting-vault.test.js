import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existingNote, writeMeetingNote } from './meeting-vault.js';

const record = (patch = {}) => ({
  id: 'm1', title: 'Planejamento do Q4', startedAt: Date.UTC(2026, 9, 16, 13), endedAt: Date.UTC(2026, 9, 16, 14),
  summary: '## Visão geral\nOrçamento fechado', model: 'claude-haiku-5-5',
  entries: [
    { role: 'interlocutor', text: 'Como fica o orçamento?', at: Date.UTC(2026, 9, 16, 13) },
    { role: 'user', text: 'Fechamos em março', at: Date.UTC(2026, 9, 16, 14) },
  ],
  ...patch,
});

test('a meeting becomes a note in the Sidenote folder and saving again updates it', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'sidenote-vault-'));
  try {
    const file = await writeMeetingNote(vault, record());
    assert.equal(path.dirname(file), path.join(vault, 'Sidenote'));
    assert.match(path.basename(file), /^2026-10-16 \d{4} Planejamento do Q4\.md$/);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /titulo: "Planejamento do Q4"/);
    assert.match(text, /Orçamento fechado/);
    assert.match(text, /Fechamos em março/);

    const again = await writeMeetingNote(vault, record({ vaultFile: file, summary: '## Visão geral\nRevisado' }));
    assert.equal(again, file, 'same note');
    assert.match(fs.readFileSync(file, 'utf8'), /Revisado/);
    assert.equal(fs.readdirSync(path.join(vault, 'Sidenote')).length, 1);

    fs.rmSync(file);
    assert.equal(await existingNote(vault, record({ vaultFile: file })), null, 'a deleted note is written anew');
    assert.notEqual(await writeMeetingNote(vault, record({ vaultFile: '/etc/passwd' })), '/etc/passwd', 'never writes outside the vault');
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});
