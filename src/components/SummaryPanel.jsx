import React, { useState } from 'react';
import { FileText, Sparkles, Copy, Check, FolderDown, BookOpen, Settings2, X, AlertCircle } from 'lucide-react';
import { FormattedAgentResponse } from './CodeBlock.jsx';
import { PROVIDERS } from '../config/models.js';
import { providerModels, unavailableReason } from '../../shared/provider-availability.js';

const SAME_MODEL = '';

function timeOf(ms) {
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function statusLine(summary) {
  if (!summary) return null;
  if (summary.status === 'running') return { text: 'Atualizando…', className: 'text-emerald-300' };
  if (summary.status === 'error') return { text: 'Falhou', className: 'text-rose-300' };
  if (!summary.text) return null;
  const pending = summary.total - summary.covered;
  if (summary.stale && pending > 0) {
    return { text: `${pending} ${pending === 1 ? 'fala nova' : 'falas novas'} desde ${timeOf(summary.updatedAt)}`, className: 'text-amber-300' };
  }
  return { text: `Atualizado às ${timeOf(summary.updatedAt)}`, className: 'text-zinc-500' };
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex items-center justify-between gap-2 cursor-pointer">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="accent-emerald-500 cursor-pointer" />
    </label>
  );
}

export function SummaryPanel({
  messages,
  summary,
  settings,
  onChangeSettings,
  onRequest,
  onExport,
  notice,
  onClearNotice,
  vaultConnected,
  availability,
}) {
  const [copied, setCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const totalInterlocutor = messages.filter((m) => m.role === 'interlocutor').length;
  const totalUser = messages.filter((m) => m.role === 'user').length;
  const totalAnswers = messages.filter((m) => m.role === 'copilot' || m.role === 'agent').length;
  const running = summary?.status === 'running';
  const body = (running && summary.draft) || summary?.text || '';
  const status = statusLine(summary);
  const hasLines = (summary?.total || 0) > 0;
  const modelValue = settings.provider ? `${settings.provider}:${settings.model}` : SAME_MODEL;

  const copy = () => {
    navigator.clipboard.writeText(body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const chooseModel = (value) => {
    if (value === SAME_MODEL) return onChangeSettings({ provider: null, model: null });
    const [provider, ...model] = value.split(':');
    onChangeSettings({ provider, model: model.join(':') });
  };

  return (
    <div className="app-transcript-feed flex-1 overflow-y-auto px-4 py-4 space-y-3 text-xs">
      <div className="rounded-xl border border-white/[0.06] bg-[#121218]/90 p-3 shadow-sm backdrop-blur-md">
        <div className="flex items-center justify-between pb-2 mb-2.5 border-b border-white/[0.06]">
          <div className="flex items-center gap-1.5 text-xs font-bold text-zinc-200">
            <FileText size={13} className="text-emerald-400" />
            <span>Resumo da Sessão</span>
          </div>
          <div className="flex items-center gap-1.5">
            {status && <span className={`text-[10px] font-mono ${status.className}`}>{status.text}</span>}
            <button
              type="button"
              onClick={() => setShowSettings((value) => !value)}
              className={`p-1 rounded cursor-pointer hover:bg-white/10 ${showSettings ? 'text-emerald-300' : 'text-zinc-500'}`}
              title="Configurações do resumo"
              aria-label="Configurações do resumo"
              aria-expanded={showSettings}
            >
              <Settings2 size={12} />
            </button>
          </div>
        </div>

        {showSettings && (
          <div className="mb-3 p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06] space-y-2 text-[11px] text-zinc-300">
            <Toggle label="Atualizar automaticamente durante a conversa" checked={settings.auto} onChange={(auto) => onChangeSettings({ auto })} />
            <Toggle label="Salvar sessão ao iniciar uma nova" checked={settings.saveOnReset} onChange={(saveOnReset) => onChangeSettings({ saveOnReset })} />
            <label className="block space-y-1">
              <span>Modelo do resumo</span>
              <select
                value={modelValue}
                onChange={(event) => chooseModel(event.target.value)}
                className="w-full rounded bg-zinc-900 border border-white/10 px-1.5 py-1 text-[11px] text-zinc-200 cursor-pointer"
              >
                <option value={SAME_MODEL}>Mesmo modelo da conversa</option>
                {Object.values(PROVIDERS).map((provider) => ({ provider, models: providerModels(provider, availability?.[provider.id]) }))
                  .filter(({ models }) => models.length)
                  .map(({ provider, models }) => (
                  <optgroup key={provider.id} label={provider.name}>
                    {models.map((model) => {
                      const reason = unavailableReason(availability, provider.id, model.id, model.name);
                      return (
                        <option key={model.id} value={`${provider.id}:${model.id}`} disabled={!!reason}>
                          {model.name}{reason ? ' (indisponível)' : ''}
                        </option>
                      );
                    })}
                  </optgroup>
                ))}
              </select>
              <span className="block text-[10px] text-zinc-500">Um modelo rápido (Flash, Haiku, Luna) basta para resumos e não disputa com as respostas ao vivo.</span>
            </label>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 mb-3">
          <div className="p-2 rounded bg-white/[0.03] border border-white/[0.04] text-center">
            <span className="block text-[10px] text-zinc-400">Interlocutor</span>
            <span className="text-sm font-bold text-indigo-300 font-mono">{totalInterlocutor}</span>
          </div>
          <div className="p-2 rounded bg-white/[0.03] border border-white/[0.04] text-center">
            <span className="block text-[10px] text-zinc-400">Você</span>
            <span className="text-sm font-bold text-cyan-300 font-mono">{totalUser}</span>
          </div>
          <div className="p-2 rounded bg-white/[0.03] border border-white/[0.04] text-center">
            <span className="block text-[10px] text-zinc-400">Respostas IA</span>
            <span className="text-sm font-bold text-emerald-300 font-mono">{totalAnswers}</span>
          </div>
        </div>

        {body ? (
          <div className="mb-3 p-2.5 rounded-lg bg-emerald-950/20 border border-emerald-500/20 text-zinc-100 leading-relaxed text-[12px] select-text">
            {summary?.title && <p className="mb-1.5 text-[13px] font-bold text-zinc-50">{summary.title}</p>}
            <FormattedAgentResponse text={body} />
          </div>
        ) : running ? (
          <div className="mb-3 flex items-center gap-2 text-[11px] text-zinc-400">
            <span className="w-1.5 h-1.5 rounded-full animate-pulse bg-emerald-400" />
            <span>Sintetizando resumo...</span>
          </div>
        ) : (
          <p className="mb-3 text-[11px] text-zinc-500 italic">
            {!hasLines
              ? 'Nenhuma fala registrada ainda.'
              : settings.auto
                ? 'O resumo aparece sozinho depois de algumas falas. Você também pode gerá-lo agora.'
                : 'Clique em "Gerar resumo" para resumir a conversa até aqui.'}
          </p>
        )}

        {summary?.status === 'error' && summary.error && (
          <div role="alert" className="mb-3 flex items-start gap-1.5 text-[11px] text-rose-300">
            <AlertCircle size={12} className="shrink-0 mt-0.5" />
            <span>{summary.error}</span>
          </div>
        )}

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onRequest}
            disabled={!hasLines || running}
            className="flex-1 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 text-xs font-semibold border border-emerald-500/30 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
          >
            <Sparkles size={12} />
            <span>{running ? 'Gerando…' : summary?.text ? 'Atualizar agora' : 'Gerar resumo'}</span>
          </button>
          <button
            type="button"
            onClick={copy}
            disabled={!body}
            className="p-1.5 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/10 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title="Copiar resumo"
            aria-label="Copiar resumo"
          >
            {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
          </button>
          <button
            type="button"
            onClick={() => onExport('sessions')}
            disabled={!hasLines}
            className="p-1.5 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/10 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title="Salvar resumo e transcrição em Markdown"
            aria-label="Salvar resumo e transcrição em Markdown"
          >
            <FolderDown size={13} />
          </button>
          <button
            type="button"
            onClick={() => onExport('vault')}
            disabled={!hasLines || !vaultConnected}
            className="p-1.5 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/10 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title={vaultConnected ? 'Salvar na vault do Obsidian (pasta InterviewAI)' : 'Conecte uma vault do Obsidian para salvar nela'}
            aria-label="Salvar na vault do Obsidian"
          >
            <BookOpen size={13} />
          </button>
        </div>

        {notice && (
          <div className={`mt-2.5 flex items-start justify-between gap-2 text-[10px] ${notice.error ? 'text-rose-300' : 'text-zinc-400'}`}>
            <span className="break-all select-text">
              {notice.error || `${notice.archived ? 'Sessão anterior salva em' : 'Salvo em'} ${notice.file}`}
            </span>
            <button type="button" onClick={onClearNotice} className="p-0.5 rounded hover:bg-white/10 cursor-pointer shrink-0" aria-label="Fechar aviso">
              <X size={10} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
