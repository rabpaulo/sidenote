import React, { useRef, useState } from 'react';
import { FileUp, Loader2 } from 'lucide-react';
import { apiFetch } from '../backend.js';

const ACCEPT = '.pdf,.docx,.txt,.md';
const MAX_BYTES = 10 * 1024 * 1024;
// Reading the file is instant; the model structuring it can take a while.
const TIMEOUT_MS = 150000;

/** Drop or pick a PDF/DOCX/TXT/MD; the backend returns profile fields read from it. */
export function DocumentDropZone({ kind, title, hint, onImported }) {
  const inputRef = useRef(null);
  const requestRef = useRef(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [busyFile, setBusyFile] = useState('');
  const [message, setMessage] = useState(null);
  // A pending import is not aborted on unmount: switching tabs while the model
  // reads the file must still merge the result into the editor's draft.

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
    const controller = new AbortController();
    requestRef.current = controller;
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    setBusyFile(file.name);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/profile/import?kind=${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
        body: file,
        signal: controller.signal,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Não foi possível importar o arquivo.');
      onImported(result.fields || {});
      setMessage(result.warning
        ? { ok: false, text: result.warning }
        : { ok: true, text: `Campos preenchidos a partir de ${file.name}. Revise e salve.` });
    } catch (failure) {
      if (requestRef.current === controller) {
        setMessage({ ok: false, text: controller.signal.aborted ? 'A leitura demorou demais. Tente novamente.' : failure.message });
      }
    } finally {
      clearTimeout(timer);
      if (requestRef.current === controller) {
        requestRef.current = null;
        setBusyFile('');
      }
    }
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
      {message && <p role={message.ok ? 'status' : 'alert'} className={`text-[11px] leading-snug ${message.ok ? 'text-emerald-300/90' : 'text-amber-300'}`}>{message.text}</p>}
    </div>
  );
}
