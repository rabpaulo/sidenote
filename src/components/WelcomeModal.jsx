import React, { useState } from 'react';
import { X, Sparkles, CircleCheck, RefreshCw, Loader2, HardDrive } from 'lucide-react';
import { CLI_PROVIDER_IDS, PROVIDERS } from '../config/models.js';
import { useProviderKeys } from '../hooks/useProviderKeys.js';
import { KeyRow } from './ApiKeysModal.jsx';
import { ModelRow, speechEngineName } from './SpeechEngineModal.jsx';
import { PARAKEET_MODEL } from './welcome.js';

// Providers with a free tier, offered first to someone with no AI account set up.
const FREE_PROVIDERS = ['gemini', 'groq'];

function Step({ number, title, done, children }) {
  return (
    <section className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-3.5 space-y-2.5">
      <h3 className="flex items-center gap-2 font-semibold text-zinc-100">
        {done
          ? <CircleCheck size={16} className="text-emerald-400 shrink-0" />
          : <span className="w-4 h-4 rounded-full border border-zinc-600 text-[10px] leading-[14px] text-center text-zinc-400 shrink-0">{number}</span>}
        {title}
      </h3>
      {children}
    </section>
  );
}

function ProviderStep({ needed, availability, agentSettings, onRefresh, onOpenKeys, onOpenLocal }) {
  const [choice, setChoice] = useState(FREE_PROVIDERS[0]);
  const { keys, busy, error, save, remove } = useProviderKeys(true);
  const current = PROVIDERS[agentSettings.provider];
  const installedClis = CLI_PROVIDER_IDS.filter((id) => availability[id] && availability[id].installed !== false && availability[id].status === 'unavailable');

  if (!needed) {
    return (
      <Step number={1} title="Modelo de IA" done>
        <p className="text-zinc-400">Usando {current?.name}{agentSettings.currentModel?.name ? ` · ${agentSettings.currentModel.name}` : ''}.</p>
      </Step>
    );
  }

  const saveAndUse = async (provider, key) => {
    const saved = await save(provider, key);
    // The model is chosen once the key's model list arrives (App picks the first usable one).
    if (saved) agentSettings.setProvider(provider);
    return saved;
  };

  return (
    <Step number={1} title="Modelo de IA">
      <p className="text-zinc-400 leading-relaxed">
        Cole uma API key. Gemini e Groq têm plano gratuito; a key fica só neste computador.
      </p>
      <div role="tablist" className="flex gap-1.5">
        {FREE_PROVIDERS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={choice === id}
            onClick={() => setChoice(id)}
            className={`px-3 py-1 rounded-lg border text-[11px] cursor-pointer ${choice === id ? 'border-blue-500/50 bg-blue-500/15 text-blue-100' : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
          >
            {PROVIDERS[id].shortName || PROVIDERS[id].name}
          </button>
        ))}
        <button type="button" onClick={onOpenKeys} className="px-3 py-1 rounded-lg border border-zinc-800 text-[11px] text-zinc-400 hover:text-zinc-200 cursor-pointer">
          Outros…
        </button>
      </div>
      {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-200">{error}</p>}
      <KeyRow
        key={choice}
        provider={PROVIDERS[choice]}
        keyInfo={keys[choice]}
        entry={availability[choice]}
        busy={busy === choice}
        onSave={saveAndUse}
        onRemove={remove}
      />
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        {installedClis.length
          ? <>Encontrei {installedClis.map((id) => PROVIDERS[id].shortName).join(', ')} neste computador, sem login. Faça login no terminal e{' '}</>
          : <>Nenhum CLI de IA (Codex, Claude Code, Antigravity, OpenCode) foi encontrado. Se instalar um, faça login e{' '}</>}
        <button type="button" onClick={onRefresh} className="inline-flex items-center gap-1 underline hover:text-zinc-200 cursor-pointer">
          verifique de novo <RefreshCw size={10} />
        </button>.
      </p>
      {onOpenLocal && (
        <button type="button" onClick={onOpenLocal} className="flex items-center gap-1.5 text-[11px] text-teal-200 hover:text-teal-100 cursor-pointer">
          <HardDrive size={11} /> Sem conta nenhuma: rodar um modelo local escolhido para o seu hardware
        </button>
      )}
    </Step>
  );
}

function SpeechStep({ needed, speech }) {
  const status = speech.status;
  if (!status) {
    return (
      <Step number={2} title="Reconhecimento de voz">
        <p className="flex items-center gap-1.5 text-zinc-400"><Loader2 size={12} className="animate-spin" /> Verificando…</p>
      </Step>
    );
  }
  if (!needed) {
    return (
      <Step number={2} title="Reconhecimento de voz" done>
        <p className="text-zinc-400">Usando {speechEngineName(status)}.</p>
      </Step>
    );
  }

  // Parakeet becomes the engine as soon as its download starts; it is used once complete.
  const download = async (id) => {
    if (status.engine !== 'parakeet') await speech.select('parakeet');
    await speech.download(id);
  };

  return (
    <Step number={2} title="Reconhecimento de voz">
      <p className="text-zinc-400 leading-relaxed">
        Baixe o Parakeet uma vez: ele transcreve português e inglês no seu computador, sem internet e sem instalar mais nada.
      </p>
      <ModelRow
        id={PARAKEET_MODEL}
        state={status.models?.[PARAKEET_MODEL]}
        busy={!!speech.busy}
        onDownload={download}
        onCancel={speech.cancel}
        onRemove={speech.remove}
      />
      {speech.error && <p className="text-[11px] text-rose-300">{speech.error}</p>}
    </Step>
  );
}

/** First run: what the app needs before it can listen and answer, in two steps. */
export function WelcomeModal({ isOpen, onClose, needs, availability, agentSettings, speech, onRefreshProviders, onOpenKeys, onOpenLocal }) {
  if (!isOpen) return null;
  const ready = !needs.provider && !needs.speech;

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center p-4 overflow-y-auto">
      <div className="fixed inset-0 bg-black/80 backdrop-blur-md" />
      <div role="dialog" aria-modal="true" aria-labelledby="welcome-title" className="relative w-full max-w-lg rounded-2xl border border-zinc-800 bg-[#0e0e14] shadow-2xl overflow-hidden z-10 flex flex-col max-h-[90vh] text-[12px]">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800/80 bg-zinc-950/60">
          <h2 id="welcome-title" className="flex items-center gap-2 text-base font-bold text-white tracking-tight">
            <Sparkles size={16} className="text-blue-300" />
            Bem-vindo ao Sidenote
          </h2>
          <button type="button" onClick={onClose} aria-label="Fechar" className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800/80 transition cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-3">
          <p className="text-zinc-400 leading-relaxed">
            O Sidenote ouve a chamada, transcreve e sugere o que responder. Faltam dois passos para começar.
          </p>
          <ProviderStep
            needed={needs.provider}
            availability={availability}
            agentSettings={agentSettings}
            onRefresh={onRefreshProviders}
            onOpenKeys={onOpenKeys}
            onOpenLocal={onOpenLocal}
          />
          <SpeechStep needed={needs.speech} speech={speech} />
        </div>

        <div className="flex justify-end px-5 py-3 border-t border-zinc-800/80 bg-zinc-950/60">
          <button
            type="button"
            onClick={onClose}
            className={`px-4 py-1.5 rounded-lg text-[12px] font-semibold cursor-pointer ${ready ? 'bg-blue-500 text-white hover:bg-blue-400' : 'border border-zinc-700 text-zinc-300 hover:bg-white/5'}`}
          >
            {ready ? 'Começar' : 'Fazer isso depois'}
          </button>
        </div>
      </div>
    </div>
  );
}
