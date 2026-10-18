import React, { useState } from 'react';
import { X, KeyRound, ExternalLink, Trash2, Check, Loader2 } from 'lucide-react';
import { API_PROVIDER_LIST } from '../config/models.js';
import { useProviderKeys } from '../hooks/useProviderKeys.js';

function statusOf(entry, key) {
  if (!key?.configured) return { text: 'Sem key', className: 'text-zinc-500' };
  if (!entry || entry.status === 'checking') return { text: 'Verificando…', className: 'text-zinc-400' };
  if (entry.status === 'available') {
    const count = entry.models?.length;
    return { text: count ? `${count} modelo${count === 1 ? '' : 's'}` : 'Disponível', className: 'text-emerald-300' };
  }
  if (entry.status === 'unavailable') return { text: 'Inválida', className: 'text-rose-300', detail: entry.reason };
  return { text: 'Não verificada', className: 'text-amber-300', detail: entry.reason };
}

function KeyRow({ provider, keyInfo, entry, busy, onSave, onRemove }) {
  const [value, setValue] = useState('');
  const status = statusOf(entry, keyInfo);

  const submit = async (event) => {
    event.preventDefault();
    if (value.trim() && await onSave(provider.id, value.trim())) setValue('');
  };

  return (
    <form onSubmit={submit} className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-zinc-100">{provider.name}</span>
        {keyInfo?.configured && (
          <span className="font-mono text-[10px] text-zinc-500">
            {keyInfo.hint}{keyInfo.source === 'env' ? ' · variável de ambiente' : ''}
          </span>
        )}
        <span className={`ml-auto text-[10px] font-medium ${status.className}`}>{status.text}</span>
      </div>
      {status.detail && <p className="text-[10px] text-zinc-500 leading-snug">{status.detail}</p>}
      <div className="flex gap-1.5">
        <input
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={keyInfo?.configured ? 'Substituir key' : `${provider.keyPrefix || ''}…`}
          autoComplete="off"
          spellCheck={false}
          aria-label={`API key de ${provider.name}`}
          className="flex-1 min-w-0 rounded-lg border border-zinc-800 bg-black/40 px-2.5 py-1.5 text-zinc-100 font-mono text-[11px] outline-none focus:border-blue-500/60"
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          title="Salvar"
          aria-label={`Salvar API key de ${provider.name}`}
          className="px-2.5 rounded-lg bg-blue-500/20 border border-blue-500/30 text-blue-200 hover:bg-blue-500/30 disabled:opacity-40 cursor-pointer disabled:cursor-default"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
        </button>
        {keyInfo?.source === 'saved' && (
          <button
            type="button"
            onClick={() => onRemove(provider.id)}
            disabled={busy}
            title="Remover key salva"
            aria-label={`Remover API key de ${provider.name}`}
            className="px-2.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-rose-300 hover:bg-rose-500/10 disabled:opacity-40 cursor-pointer"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
      <a href={provider.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-200">
        Obter uma key <ExternalLink size={9} />
      </a>
    </form>
  );
}

export function ApiKeysModal({ isOpen, onClose, availability = {} }) {
  const { keys, file, busy, error, save, remove } = useProviderKeys(isOpen);
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 overflow-y-auto">
      <div className="fixed inset-0 bg-black/80 backdrop-blur-md" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby="api-keys-title" className="relative w-full max-w-lg rounded-2xl border border-zinc-800 bg-[#0e0e14] shadow-2xl overflow-hidden z-10 flex flex-col max-h-[90vh] text-[12px]">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800/80 bg-zinc-950/60">
          <h2 id="api-keys-title" className="flex items-center gap-2 text-base font-bold text-white tracking-tight">
            <KeyRound size={16} className="text-blue-300" />
            Chaves de API
          </h2>
          <button type="button" onClick={onClose} aria-label="Fechar" className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800/80 transition cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-3">
          <p className="text-zinc-400 leading-relaxed">
            Com uma key, o provedor aparece em <strong className="text-zinc-200">Modelo de IA</strong> com os modelos da sua conta.
            As keys ficam só neste computador e também são repassadas ao OpenCode, se ele estiver instalado.
          </p>
          {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-200">{error}</p>}
          {API_PROVIDER_LIST.map((provider) => (
            <KeyRow
              key={provider.id}
              provider={provider}
              keyInfo={keys[provider.id]}
              entry={availability[provider.id]}
              busy={busy === provider.id}
              onSave={save}
              onRemove={remove}
            />
          ))}
          {file && <p className="text-[10px] text-zinc-600 font-mono break-all">Salvas em {file}</p>}
        </div>
      </div>
    </div>
  );
}
