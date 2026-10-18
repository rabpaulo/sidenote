import React, { useEffect, useState } from 'react';
import { X, FolderOpen, RefreshCw, Unplug, Search, NotebookText } from 'lucide-react';
import { NotesCard } from './NotesCard.jsx';

export function NotesVaultModal({ isOpen, onClose, vault }) {
  const { status, busy, error, connect, reindex, disconnect, search } = vault;
  const [path, setPath] = useState('');
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (isOpen) setPath(status?.path || '');
  }, [isOpen, status?.path]);

  // Searches as the user types, like the copilot does with partial transcripts.
  useEffect(() => {
    if (!isOpen || !status?.connected || !query.trim()) { setResult(null); return undefined; }
    let cancelled = false;
    const timer = setTimeout(() => {
      search(query).then((found) => { if (!cancelled) setResult(found); }, () => { if (!cancelled) setResult(null); });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [isOpen, query, search, status?.connected, status?.chunks]);

  if (!isOpen) return null;

  const pickFolder = async () => {
    const picked = await window.interviewaiDesktop?.pickDirectory?.('Escolha a pasta da vault do Obsidian');
    if (picked) {
      setPath(picked);
      connect(picked);
    }
  };

  const submit = (event) => {
    event.preventDefault();
    if (path.trim()) connect(path.trim());
  };

  const canPick = !!window.interviewaiDesktop?.pickDirectory;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="fixed inset-0 bg-black/80 backdrop-blur-md" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby="notes-vault-title" className="relative w-full max-w-md rounded-2xl border border-zinc-800 bg-[#0e0e14] shadow-2xl overflow-hidden z-10 flex flex-col max-h-[90vh] text-[12px]">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800/80 bg-zinc-950/60">
          <h2 id="notes-vault-title" className="flex items-center gap-2 text-base font-bold text-white tracking-tight">
            <NotebookText size={16} className="text-emerald-300" />
            Notas do Obsidian
          </h2>
          <button type="button" onClick={onClose} aria-label="Fechar" className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800/80 transition cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4">
          <p className="text-zinc-400 leading-relaxed">
            O app indexa os arquivos <code>.md</code> da vault neste computador. Durante a fala, os trechos relacionados à pergunta
            aparecem num card e vão junto no prompt. Nada é enviado ao modelo além desses trechos.
          </p>

          <form onSubmit={submit} className="space-y-2">
            <label htmlFor="notes-vault-path" className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Pasta da vault</label>
            <div className="flex gap-1.5">
              <input
                id="notes-vault-path"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="~/Documentos/Obsidian/MinhaVault"
                spellCheck={false}
                className="flex-1 min-w-0 rounded-lg border border-zinc-800 bg-black/40 px-2.5 py-2 text-zinc-100 font-mono text-[11px] outline-none focus:border-emerald-500/60"
              />
              {canPick && (
                <button type="button" onClick={pickFolder} disabled={busy} title="Escolher pasta" aria-label="Escolher pasta" className="px-2.5 rounded-lg border border-zinc-800 text-zinc-300 hover:bg-white/5 disabled:opacity-50 cursor-pointer">
                  <FolderOpen size={14} />
                </button>
              )}
            </div>
            <button type="submit" disabled={busy || !path.trim()} className="w-full rounded-lg bg-emerald-500/20 border border-emerald-500/30 py-2 font-semibold text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50 cursor-pointer">
              {busy ? 'Indexando…' : status?.connected && status.path === path.trim() ? 'Conectar de novo' : 'Conectar'}
            </button>
          </form>

          {error && <p role="alert" className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-rose-300">{error}</p>}
          {!error && status?.error && <p role="alert" className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-rose-300">{status.error}</p>}

          {status?.connected && (
            <div className="rounded-lg border border-zinc-800 bg-white/[0.02] px-3 py-2.5 space-y-2">
              <div className="flex items-center gap-2 text-zinc-300">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span>
                  {status.files.toLocaleString('pt-BR')} notas · {status.chunks.toLocaleString('pt-BR')} seções
                  {status.indexedAt ? ` · indexado em ${status.indexMs} ms` : ''}
                </span>
              </div>
              {status.truncated && <p className="text-amber-300 text-[11px]">A vault tem mais arquivos que o limite; só os primeiros foram indexados.</p>}
              <p className="text-[11px] text-zinc-500">Edições na vault são reindexadas automaticamente.</p>
              <div className="flex gap-1.5">
                <button type="button" onClick={reindex} disabled={busy} className="flex-1 flex items-center justify-center gap-1.5 rounded-lg border border-zinc-800 py-1.5 text-zinc-300 hover:bg-white/5 disabled:opacity-50 cursor-pointer">
                  <RefreshCw size={12} /> Reindexar
                </button>
                <button type="button" onClick={disconnect} disabled={busy} className="flex-1 flex items-center justify-center gap-1.5 rounded-lg border border-rose-500/20 py-1.5 text-rose-300 hover:bg-rose-500/10 disabled:opacity-50 cursor-pointer">
                  <Unplug size={12} /> Desconectar
                </button>
              </div>
            </div>
          )}

          {status?.connected && (
            <div className="space-y-2">
              <label htmlFor="notes-vault-test" className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Testar uma pergunta</label>
              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  id="notes-vault-test"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Qual foi a latência do projeto de pagamentos?"
                  className="w-full rounded-lg border border-zinc-800 bg-black/40 pl-7 pr-2.5 py-2 text-zinc-100 outline-none focus:border-emerald-500/60"
                />
              </div>
              {result && (result.hits.length
                ? <NotesCard hits={result.hits} />
                : <p className="text-zinc-500">Nenhum trecho relevante. O copiloto responde sem notas.</p>)}
              {result && <p className="text-[10px] text-zinc-600 text-right">busca em {result.ms} ms</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
