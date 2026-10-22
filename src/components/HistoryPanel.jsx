import React, { useEffect, useState } from 'react';
import { Search, ArrowLeft, Trash2, Copy, Check, Sparkles, X, AlertCircle, History, BookOpen, FileUp, CalendarDays } from 'lucide-react';
import { FormattedAgentResponse } from './CodeBlock.jsx';

const ROLE_LABELS = { interlocutor: 'Interlocutor', user: 'Você', assistant: 'Sugestão da IA' };
const ROLE_COLORS = { interlocutor: 'text-accent-300', user: 'text-accent-300', assistant: 'text-emerald-300' };

function endedLabel(ms) {
  const date = new Date(ms);
  return `${date.toLocaleDateString('pt-BR')} · ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

function duration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h${String(minutes).padStart(2, '0')}`;
  return minutes ? `${minutes} min` : `${total % 60} s`;
}

function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return total >= 3600 ? `${Math.floor(total / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}

const summarizing = (meeting) => meeting.status === 'pending' || meeting.status === 'summarizing';

function titleOf(meeting) {
  if (meeting.title) return meeting.title;
  return summarizing(meeting) ? 'Gerando título…' : 'Reunião sem título';
}

function Snippet({ snippet }) {
  if (!snippet?.text) return null;
  const at = snippet.match ? snippet.text.indexOf(snippet.match) : -1;
  if (at < 0) return <p className="mt-1 text-[10px] text-neutral-500 line-clamp-2">{snippet.text}</p>;
  return (
    <p className="mt-1 text-[10px] text-neutral-500 line-clamp-2">
      {snippet.text.slice(0, at)}
      <mark className="bg-amber-400/20 text-amber-200 rounded-sm">{snippet.match}</mark>
      {snippet.text.slice(at + snippet.match.length)}
    </p>
  );
}

function vaultTitle(vaultConnected, meeting) {
  if (!vaultConnected) return 'Conecte uma vault do Obsidian para salvar nela';
  return meeting.vaultFile ? 'Atualizar a nota na vault do Obsidian' : 'Salvar na vault do Obsidian (pasta Sidenote)';
}

function MeetingDetail({ meeting, onBack, onDelete, onSummarize, onSaveToVault, vaultConnected, onSaveToGoogleDocs, googleConnected }) {
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const running = summarizing(meeting);

  useEffect(() => {
    if (!confirmDelete) return undefined;
    const timer = setTimeout(() => setConfirmDelete(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  const copy = () => {
    navigator.clipboard.writeText(`# ${titleOf(meeting)}\n\n${meeting.summary || ''}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="rounded-xl border border-white/[0.06] bg-[#161616]/90 p-3 shadow-sm backdrop-blur-md">
      <div className="flex items-center justify-between gap-2 pb-2 mb-2.5 border-b border-white/[0.06]">
        <button type="button" onClick={onBack} className="flex items-center gap-1 text-[11px] text-neutral-400 hover:text-neutral-100 cursor-pointer">
          <ArrowLeft size={12} />
          <span>Histórico</span>
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copy}
            disabled={!meeting.summary}
            title="Copiar título e resumo"
            aria-label="Copiar título e resumo"
            className="p-1 rounded text-neutral-400 hover:bg-white/10 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          </button>
          <button
            type="button"
            onClick={() => onSaveToVault(meeting.id)}
            disabled={!vaultConnected || running}
            title={vaultTitle(vaultConnected, meeting)}
            aria-label={vaultTitle(vaultConnected, meeting)}
            className={`p-1 rounded hover:bg-white/10 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${meeting.vaultFile ? 'text-emerald-300' : 'text-neutral-400'}`}
          >
            <BookOpen size={12} />
          </button>
          <button
            type="button"
            onClick={() => onSaveToGoogleDocs(meeting.id)}
            disabled={(!googleConnected && !meeting.googleDoc) || running}
            title={meeting.googleDoc ? 'Abrir no Google Docs' : googleConnected ? 'Salvar no Google Docs' : 'Conecte o Google (Menu → Google) para salvar no Docs'}
            aria-label={meeting.googleDoc ? 'Abrir no Google Docs' : 'Salvar no Google Docs'}
            className={`p-1 rounded hover:bg-white/10 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${meeting.googleDoc ? 'text-accent-300' : 'text-neutral-400'}`}
          >
            <FileUp size={12} />
          </button>
          <button
            type="button"
            onClick={() => (confirmDelete ? onDelete(meeting.id) : setConfirmDelete(true))}
            title="Apagar reunião"
            aria-label={confirmDelete ? 'Confirmar exclusão' : 'Apagar reunião'}
            className={`flex items-center gap-1 px-1 py-1 rounded cursor-pointer text-[10px] ${confirmDelete ? 'bg-rose-500/20 text-rose-200' : 'text-neutral-400 hover:bg-white/10'}`}
          >
            <Trash2 size={12} />
            {confirmDelete && <span>Confirmar</span>}
          </button>
        </div>
      </div>

      <h2 className="text-sm font-bold text-neutral-100 leading-snug select-text">{titleOf(meeting)}</h2>
      <p className="mt-0.5 mb-3 text-[10px] text-neutral-500 font-mono">
        Terminou em {endedLabel(meeting.endedAt)} · {duration(meeting.endedAt - meeting.startedAt)}
        {meeting.event?.title && <> · <CalendarDays size={9} className="inline -mt-0.5" /> {meeting.event.title}</>}
      </p>

      {meeting.summary ? (
        <div className="mb-3 p-2.5 rounded-lg bg-emerald-950/20 border border-emerald-500/20 text-neutral-100 leading-relaxed text-[12px] select-text">
          <FormattedAgentResponse text={meeting.summary} />
        </div>
      ) : running ? (
        <div className="mb-3 flex items-center gap-2 text-[11px] text-neutral-400">
          <span className="w-1.5 h-1.5 rounded-full animate-pulse bg-emerald-400" />
          <span>O modelo está escrevendo o resumo e o título…</span>
        </div>
      ) : (
        <div className="mb-3 space-y-2">
          {meeting.summaryError && (
            <div role="alert" className="flex items-start gap-1.5 text-[11px] text-rose-300">
              <AlertCircle size={12} className="shrink-0 mt-0.5" />
              <span>O resumo falhou: {meeting.summaryError}</span>
            </div>
          )}
          <button
            type="button"
            onClick={() => onSummarize(meeting.id)}
            className="w-full py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 text-xs font-semibold border border-emerald-500/30 cursor-pointer flex items-center justify-center gap-1.5"
          >
            <Sparkles size={12} />
            <span>Gerar resumo e título</span>
          </button>
        </div>
      )}

      <details className="group">
        <summary className="cursor-pointer text-[11px] font-semibold text-neutral-300 hover:text-white">
          Transcrição ({meeting.entries.length} {meeting.entries.length === 1 ? 'fala' : 'falas'})
        </summary>
        <div className="mt-2 space-y-1.5 text-[11px] leading-relaxed select-text">
          {meeting.entries.map((entry, index) => (
            <p key={index} className="text-neutral-300">
              <span className="font-mono text-[10px] text-neutral-600">[{clock(entry.at - meeting.startedAt)}] </span>
              <span className={`font-semibold ${ROLE_COLORS[entry.role] || ''}`}>{ROLE_LABELS[entry.role] || entry.role}: </span>
              <span className="whitespace-pre-wrap">{entry.text}</span>
            </p>
          ))}
        </div>
      </details>
    </div>
  );
}

export function HistoryPanel({ history, vaultConnected, googleConnected }) {
  const {
    query, setQuery, meetings, error, clearError, notice, clearNotice, selectedId, select, selected, remove, summarize, saveToVault, saveToGoogleDocs,
  } = history;
  const [savingAll, setSavingAll] = useState(false);

  const saveAll = async () => {
    setSavingAll(true);
    await saveToVault();
    setSavingAll(false);
  };

  return (
    <div className="app-transcript-feed flex-1 overflow-y-auto px-4 py-4 space-y-3 text-xs">
      {error && (
        <div role="alert" className="flex items-start justify-between gap-2 text-[11px] text-rose-300">
          <span>{error}</span>
          <button type="button" onClick={clearError} className="p-0.5 rounded hover:bg-white/10 cursor-pointer shrink-0" aria-label="Fechar aviso">
            <X size={10} />
          </button>
        </div>
      )}

      {notice && (
        <div role="status" className="flex items-start justify-between gap-2 text-[11px] text-emerald-300">
          <span className="break-all">{notice}</span>
          <button type="button" onClick={clearNotice} className="p-0.5 rounded hover:bg-white/10 cursor-pointer shrink-0" aria-label="Fechar aviso">
            <X size={10} />
          </button>
        </div>
      )}

      {selectedId && selected ? (
        <MeetingDetail
          meeting={selected}
          onBack={() => select(null)}
          onDelete={remove}
          onSummarize={summarize}
          onSaveToVault={saveToVault}
          vaultConnected={vaultConnected}
          onSaveToGoogleDocs={(id) => (selected.googleDoc ? window.open(selected.googleDoc.url, '_blank', 'noopener') : saveToGoogleDocs(id))}
          googleConnected={googleConnected}
        />
      ) : (
        <>
          <div className="flex items-center gap-1.5">
            <label className="flex-1 min-w-0 flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 focus-within:border-accent-500/50">
              <Search size={12} className="text-neutral-500 shrink-0" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar por título, assunto ou fala…"
                aria-label="Buscar no histórico"
                className="flex-1 min-w-0 bg-transparent text-[12px] text-neutral-100 outline-none placeholder:text-neutral-600"
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} aria-label="Limpar busca" className="p-0.5 rounded text-neutral-500 hover:text-neutral-200 cursor-pointer">
                  <X size={11} />
                </button>
              )}
            </label>
            <button
              type="button"
              onClick={saveAll}
              disabled={!vaultConnected || savingAll || !meetings?.length}
              title={vaultConnected ? 'Salvar na vault as reuniões que ainda não estão lá' : 'Conecte uma vault do Obsidian para salvar nela'}
              aria-label="Salvar todas as reuniões na vault do Obsidian"
              className="shrink-0 p-1.5 rounded-lg border border-white/10 text-neutral-300 hover:bg-white/10 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <BookOpen size={13} className={savingAll ? 'animate-pulse' : ''} />
            </button>
          </div>

          {meetings === null ? (
            <p className="text-[11px] text-neutral-500">Carregando…</p>
          ) : !meetings.length ? (
            <div className="pt-6 text-center text-[11px] text-neutral-500 space-y-2">
              <History size={20} className="mx-auto text-neutral-700" />
              <p>
                {query
                  ? `Nada encontrado para “${query}”.`
                  : 'Nenhuma reunião ainda. Ao iniciar uma nova sessão (Alt+N) ou fechar o app, a reunião atual entra aqui com título e resumo.'}
              </p>
            </div>
          ) : (
            <ul className="space-y-1.5">
              {meetings.map((meeting) => (
                <li key={meeting.id}>
                  <button
                    type="button"
                    onClick={() => select(meeting.id)}
                    className="w-full text-left rounded-lg border border-white/[0.06] bg-[#161616]/80 hover:bg-white/[0.05] px-3 py-2 cursor-pointer transition"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={`font-semibold text-[12px] truncate ${meeting.title ? 'text-neutral-100' : 'text-neutral-400 italic'}`}>
                        {titleOf(meeting)}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-neutral-500">{endedLabel(meeting.endedAt)}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-neutral-500">
                      <span>{duration(meeting.endedAt - meeting.startedAt)}</span>
                      <span>·</span>
                      <span>{meeting.counts.interlocutor + meeting.counts.user} falas</span>
                      {summarizing(meeting) && <span className="text-emerald-300/80">· resumindo…</span>}
                      {!summarizing(meeting) && meeting.summaryError && <span className="text-rose-300/80">· sem resumo</span>}
                      {meeting.vaultFile && <span className="text-emerald-300/70" title={meeting.vaultFile}>· na vault</span>}
                      {meeting.googleDoc && <span className="text-accent-300/70">· no Docs</span>}
                    </div>
                    <Snippet snippet={meeting.snippet} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
