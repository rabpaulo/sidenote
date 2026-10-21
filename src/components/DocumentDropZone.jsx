import React, { useRef, useState } from 'react';
import { FileUp, Loader2, Link2 } from 'lucide-react';
import { apiFetch } from '../backend.js';

const ACCEPT = '.pdf,.docx,.txt,.md';
const MAX_BYTES = 10 * 1024 * 1024;
// Reading the file is instant; the model structuring it can take a while.
const TIMEOUT_MS = 150000;

/**
 * Drop or pick a PDF/DOCX/TXT/MD, or paste a Google Docs link when Google is
 * connected; the backend returns profile fields read from it.
 */
export function DocumentDropZone({ kind, title, hint, onImported, googleConnected = false }) {
  const inputRef = useRef(null);
  const requestRef = useRef(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [busyFile, setBusyFile] = useState('');
  const [message, setMessage] = useState(null);
  const [docUrl, setDocUrl] = useState('');
  // A pending import is not aborted on unmount: switching tabs while the model
  // reads the file must still merge the result into the editor's draft.

  // Same request lifecycle for a file and a Google Docs link.
  async function send(label, makeRequest) {
    const controller = new AbortController();
    requestRef.current = controller;
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    setBusyFile(label);
    setMessage(null);
    try {
      const response = await makeRequest(controller.signal);
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Não foi possível importar o arquivo.');
      onImported(result.fields || {});
      setMessage(result.warning
        ? { ok: false, text: result.warning }
        : { ok: true, text: `Campos preenchidos a partir de ${result.title || label}. Revise e salve.` });
      return true;
    } catch (failure) {
      if (requestRef.current === controller) {
        setMessage({ ok: false, text: controller.signal.aborted ? 'A leitura demorou demais. Tente novamente.' : failure.message });
      }
      return false;
    } finally {
      clearTimeout(timer);
      if (requestRef.current === controller) {
        requestRef.current = null;
        setBusyFile('');
      }
    }
  }

  async function importGoogleDoc(event) {
    event.preventDefault();
    const url = docUrl.trim();
    if (!url || busyFile) return;
    const done = await send('Google Docs', (signal) => apiFetch('/api/profile/import-google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, url }),
      signal,
    }));
    if (done) setDocUrl('');
  }

  async function upload(file) {
    if (!file || busyFile) return;
    if (!/\.(pdf|docx|txt|md)$/i.test(file.name)) {
      setMessage({ ok: false, text: 'Use um arquivo PDF, DOCX, TXT ou MD.' });
      return;
    }
    if (file.size > MAX_BYTES) {
      setMessage({ ok: false, text: 'O arquivo passa de 10 MB.' });
      return;
    }
    await send(file.name, (signal) => apiFetch(`/api/profile/import?kind=${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
      body: file,
      signal,
    }));
  }

  const drag = (event, delta) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current + delta);
    setDragging(dragDepth.current > 0);
  };

  return (
    <div className="space-y-1.5">
      <div
        role="button"
        tabIndex={0}
        aria-busy={Boolean(busyFile)}
        aria-label={title}
        onClick={() => !busyFile && inputRef.current?.click()}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && !busyFile) {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragEnter={(event) => drag(event, 1)}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
        onDragLeave={(event) => drag(event, -1)}
        onDrop={(event) => {
          drag(event, -dragDepth.current);
          upload(event.dataTransfer.files?.[0]);
        }}
        className={`app-dropzone ${dragging ? 'app-dropzone--active' : ''}`}
      >
        <span className="app-dropzone__icon">
          {busyFile ? <Loader2 size={15} className="animate-spin" /> : <FileUp size={15} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-zinc-100">
            {busyFile ? 'Lendo e organizando com a IA…' : dragging ? 'Solte o arquivo aqui' : title}
          </span>
          <span className="block truncate text-[11px] text-zinc-500">{busyFile || hint}</span>
        </span>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(event) => {
            upload(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </div>
      {googleConnected && (
        <form onSubmit={importGoogleDoc} className="flex gap-1.5">
          <label className="flex-1 min-w-0 flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/30 px-2 py-1 focus-within:border-blue-500/50">
            <Link2 size={11} className="text-zinc-500 shrink-0" />
            <input
              value={docUrl}
              onChange={(event) => setDocUrl(event.target.value)}
              placeholder="Ou cole o link de um Google Docs"
              spellCheck={false}
              aria-label={`Link do Google Docs para ${title.toLowerCase()}`}
              className="flex-1 min-w-0 bg-transparent text-[11px] text-zinc-100 outline-none placeholder:text-zinc-600"
            />
          </label>
          <button type="submit" disabled={!docUrl.trim() || Boolean(busyFile)} className="px-2.5 rounded-lg border border-white/10 text-[11px] text-zinc-300 hover:bg-white/5 disabled:opacity-40 cursor-pointer disabled:cursor-default">
            Importar
          </button>
        </form>
      )}
      {message && <p role={message.ok ? 'status' : 'alert'} className={`text-[11px] leading-snug ${message.ok ? 'text-emerald-300/90' : 'text-amber-300'}`}>{message.text}</p>}
    </div>
  );
}
