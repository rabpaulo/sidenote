import React, { useState } from 'react';
import { X, HardDrive, Cpu, MonitorCog, RefreshCw, Download, Trash2, Check, Loader2, Play, Copy, ExternalLink, Star } from 'lucide-react';
import { useLocalModels } from '../hooks/useLocalModels.js';
import { LOCAL_PROVIDERS } from '../../shared/local-providers.js';

const FIT_LABELS = {
  gpu: { text: 'Cabe na placa de vídeo', className: 'text-emerald-300' },
  partial: { text: 'Divide placa de vídeo e RAM', className: 'text-amber-300' },
  cpu: { text: 'Roda na CPU', className: 'text-amber-300' },
  none: { text: 'Não cabe nesta máquina', className: 'text-neutral-500' },
};
const SPEED_LABELS = { fast: 'rápido', medium: 'velocidade média', slow: 'lento ao vivo' };
const LINUX_INSTALL = 'curl -fsSL https://ollama.com/install.sh | sh';

function CopyCommand({ command }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-neutral-800 bg-black/40 px-2.5 py-1.5 font-mono text-[11px] text-neutral-200">
      <span className="flex-1 min-w-0 break-all select-text">{command}</span>
      <button
        type="button"
        onClick={() => { navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        aria-label="Copiar comando"
        className="p-1 rounded text-neutral-400 hover:text-white hover:bg-white/10 cursor-pointer"
      >
        {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
      </button>
    </div>
  );
}

function HardwareCard({ hardware, busy, onRescan }) {
  if (!hardware) return null;
  const gpus = hardware.gpus || [];
  const amd = gpus.some((gpu) => gpu.vendor === 'amd' && gpu.dedicated);
  return (
    <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-3 space-y-1.5">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-neutral-100">Este computador</h3>
        <button type="button" onClick={onRescan} disabled={busy === 'rescan'} className="flex items-center gap-1 text-[11px] text-neutral-400 hover:text-white disabled:opacity-50 cursor-pointer">
          <RefreshCw size={11} className={busy === 'rescan' ? 'animate-spin' : ''} /> Escanear de novo
        </button>
      </div>
      <p className="flex items-center gap-1.5 text-neutral-300"><Cpu size={12} className="text-neutral-500" />
        {hardware.cpu || 'CPU'} · {hardware.cores} threads · {hardware.ramGb} GB de RAM
      </p>
      {gpus.length ? gpus.map((gpu, index) => (
        <p key={index} className="flex items-center gap-1.5 text-neutral-300"><MonitorCog size={12} className="text-neutral-500" />
          {gpu.name}{gpu.unified ? '' : gpu.dedicated ? ` · ${gpu.vramGb} GB de vídeo` : ' · integrada (usa a RAM)'}
        </p>
      )) : <p className="flex items-center gap-1.5 text-neutral-400"><MonitorCog size={12} className="text-neutral-500" /> Nenhuma placa de vídeo dedicada encontrada: os modelos rodam na CPU.</p>}
      {amd && (
        <p className="text-[10px] text-neutral-500 leading-snug">
          Placas AMD usam ROCm ou Vulkan no Ollama. Se a sua não for compatível, o modelo roda na CPU e fica mais lento; veja a coluna “na placa” depois de usar.
        </p>
      )}
    </section>
  );
}

function OllamaCard({ ollama, busy, onStart, platform }) {
  if (ollama.running) {
    return <p className="text-[11px] text-emerald-300/90 flex items-center gap-1.5"><Check size={12} /> Ollama rodando em {ollama.url}</p>;
  }
  if (ollama.installed) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-amber-200">
        <span>O Ollama está instalado, mas parado.</span>
        <button type="button" onClick={() => onStart('ollama')} disabled={busy === 'start:ollama'} className="flex items-center gap-1 px-3 py-1 rounded-lg bg-amber-500/20 border border-amber-500/30 hover:bg-amber-500/30 disabled:opacity-50 cursor-pointer">
          {busy === 'start:ollama' ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Iniciar
        </button>
      </div>
    );
  }
  return (
    <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-3 space-y-2">
      <h3 className="font-semibold text-neutral-100">Instale o Ollama para baixar modelos</h3>
      <p className="text-neutral-400 leading-relaxed">
        O Ollama roda os modelos abertos neste computador, sem internet e sem conta. Depois de instalar, volte aqui e clique em Escanear de novo.
      </p>
      {platform === 'linux' && <CopyCommand command={LINUX_INSTALL} />}
      <a href={LOCAL_PROVIDERS.ollama.installUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-accent-300 hover:text-accent-200">
        {platform === 'linux' ? 'Outras formas de instalar' : 'Baixar o Ollama'} <ExternalLink size={10} />
      </a>
    </section>
  );
}

function Progress({ pull, onCancel }) {
  const percent = pull.total ? Math.min(100, Math.round((pull.completed / pull.total) * 100)) : 0;
  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-1.5 rounded-full bg-neutral-800 overflow-hidden">
        <div className="h-full bg-teal-400 transition-all" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-[10px] font-mono text-neutral-400 w-24 text-right truncate" title={pull.detail}>{pull.total ? `${percent}%` : pull.detail}</span>
      <button type="button" onClick={onCancel} aria-label="Cancelar download" className="p-0.5 rounded text-neutral-400 hover:text-rose-300 cursor-pointer"><X size={11} /></button>
    </div>
  );
}

function ModelRow({ model, pull, inUse, ollamaRunning, busy, onPull, onCancel, onRemove, onUse }) {
  const fit = FIT_LABELS[model.fit];
  return (
    <li className={`rounded-xl border p-2.5 space-y-1.5 ${model.recommended ? 'border-teal-500/40 bg-teal-950/20' : 'border-neutral-800/80 bg-neutral-900/30'}`}>
      <div className="flex items-center gap-2">
        <span className="font-semibold text-neutral-100">{model.name}</span>
        {model.recommended && <span className="flex items-center gap-0.5 rounded-full bg-teal-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase text-teal-200"><Star size={8} /> Recomendado</span>}
        <span className="ml-auto font-mono text-[10px] text-neutral-500">{model.sizeGb} GB</span>
      </div>
      <p className="text-[10px] text-neutral-400 leading-snug">{model.note}</p>
      <p className={`text-[10px] ${fit.className}`}>
        {fit.text}{model.speed ? ` · ${SPEED_LABELS[model.speed]}` : ''} · precisa de ~{model.needGb} GB
      </p>
      {pull?.status === 'downloading' ? (
        <Progress pull={pull} onCancel={() => onCancel(model.id)} />
      ) : (
        <div className="flex items-center gap-1.5">
          {pull?.status === 'error' && <span className="text-[10px] text-rose-300 truncate" title={pull.error}>{pull.error}</span>}
          {model.installed ? (
            <>
              <button type="button" onClick={() => onUse(model.id)} disabled={inUse} className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-lg bg-teal-500/20 border border-teal-500/30 text-teal-100 text-[11px] hover:bg-teal-500/30 disabled:opacity-60 cursor-pointer disabled:cursor-default">
                <Check size={11} /> {inUse ? 'Em uso' : 'Usar'}
              </button>
              <button type="button" onClick={() => onRemove(model.id)} disabled={busy === `delete:${model.id}`} aria-label={`Apagar ${model.name}`} title="Apagar do disco" className="p-1.5 rounded-lg border border-neutral-800 text-neutral-400 hover:text-rose-300 hover:bg-rose-500/10 cursor-pointer">
                <Trash2 size={11} />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => onPull(model.id)}
              disabled={!ollamaRunning || model.fit === 'none'}
              title={!ollamaRunning ? 'Instale e inicie o Ollama primeiro' : model.fit === 'none' ? 'Este modelo não cabe na memória desta máquina' : `Baixar ${model.sizeGb} GB`}
              className={`ml-auto flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11px] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed ${
                model.recommended ? 'border-teal-500/40 bg-teal-500/20 text-teal-100 hover:bg-teal-500/30' : 'border-neutral-700 text-neutral-200 hover:bg-white/5'}`}
            >
              <Download size={11} /> Baixar
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** Local models: what this machine can run, downloads through Ollama, and LM Studio. */
export function LocalModelsModal({ isOpen, onClose, pushedPulls, agentSettings }) {
  const local = useLocalModels({ isOpen, pushedPulls });
  const [showAll, setShowAll] = useState(false);
  if (!isOpen) return null;
  const { status, pulls, busy, error } = local;
  const ollama = status?.ollama;
  const lmstudio = status?.lmstudio;
  const catalog = status?.catalog || [];
  // The recommended model leads; the rest keep the catalog order (smallest first).
  const shown = (showAll ? catalog : catalog.filter((model) => model.fit !== 'none' || model.installed))
    .slice().sort((a, b) => Number(b.recommended) - Number(a.recommended));
  const catalogIds = new Set(catalog.flatMap((model) => [model.id, `${model.id}:latest`]));
  const extra = (ollama?.models || []).filter((model) => !catalogIds.has(model.id) && !model.remote);
  const use = (provider) => (model) => {
    agentSettings.setProvider(provider);
    agentSettings.setModel(model, provider);
  };
  const inUse = (provider, model) => agentSettings.provider === provider && agentSettings.currentModelId === model;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 overflow-y-auto">
      <div className="fixed inset-0 bg-black/80 backdrop-blur-md" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby="local-models-title" className="relative w-full max-w-lg rounded-2xl border border-neutral-800 bg-[#0e0e14] shadow-2xl overflow-hidden z-10 flex flex-col max-h-[90vh] text-[12px]">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-800/80 bg-neutral-950/60">
          <h2 id="local-models-title" className="flex items-center gap-2 text-base font-bold text-white tracking-tight">
            <HardDrive size={16} className="text-teal-300" />
            Modelos locais
          </h2>
          <button type="button" onClick={onClose} aria-label="Fechar" className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800/80 transition cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-3">
          <p className="text-neutral-400 leading-relaxed">
            A IA roda no seu computador: nada da reunião vai para a internet. A lista abaixo foi escolhida para o hardware desta máquina; o recomendado é o melhor que ainda responde rápido ao vivo.
          </p>
          {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-200">{error}</p>}
          {!status ? (
            <p className="flex items-center gap-1.5 text-neutral-400"><Loader2 size={12} className="animate-spin" /> Escaneando o hardware…</p>
          ) : (
            <>
              <HardwareCard hardware={status.hardware} busy={busy} onRescan={local.rescan} />
              <OllamaCard ollama={ollama} busy={busy} onStart={local.start} platform={status.hardware?.platform} />

              <ul className="space-y-2">
                {shown.map((model) => (
                  <ModelRow
                    key={model.id}
                    model={model}
                    pull={pulls[model.id]}
                    inUse={inUse('ollama', model.id)}
                    ollamaRunning={ollama?.running}
                    busy={busy}
                    onPull={local.pull}
                    onCancel={local.cancel}
                    onRemove={local.remove}
                    onUse={use('ollama')}
                  />
                ))}
              </ul>
              {catalog.length > shown.length || showAll ? (
                <button type="button" onClick={() => setShowAll((value) => !value)} className="text-[11px] text-neutral-400 hover:text-white underline cursor-pointer">
                  {showAll ? 'Mostrar só os que cabem' : `Mostrar também os ${catalog.length - shown.length} que não cabem`}
                </button>
              ) : null}

              {extra.length > 0 && (
                <section className="space-y-1.5">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Outros modelos no Ollama</h3>
                  {extra.map((model) => (
                    <div key={model.id} className="flex items-center gap-2 rounded-lg border border-neutral-800/80 bg-neutral-900/30 px-2.5 py-1.5">
                      <span className="font-mono text-[11px] text-neutral-200 truncate">{model.id}</span>
                      <span className="text-[10px] text-neutral-500">{model.sizeGb} GB{model.gpuShare !== null ? ` · ${model.gpuShare}% na placa` : ''}</span>
                      <button type="button" onClick={() => use('ollama')(model.id)} disabled={inUse('ollama', model.id)} className="ml-auto text-[11px] text-teal-200 hover:text-white disabled:opacity-60 cursor-pointer">
                        {inUse('ollama', model.id) ? 'Em uso' : 'Usar'}
                      </button>
                      <button type="button" onClick={() => local.remove(model.id)} aria-label={`Apagar ${model.id}`} className="p-1 rounded text-neutral-500 hover:text-rose-300 cursor-pointer"><Trash2 size={11} /></button>
                    </div>
                  ))}
                </section>
              )}

              {(ollama?.models || []).some((model) => model.gpuShare !== null) && (
                <p className="text-[10px] text-neutral-500">
                  Carregado agora: {ollama.models.filter((model) => model.gpuShare !== null).map((model) => `${model.id} (${model.gpuShare}% na placa de vídeo)`).join(', ')}.
                </p>
              )}

              <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-semibold text-neutral-100">LM Studio</h3>
                  <span className={`text-[10px] ${lmstudio?.running ? 'text-emerald-300' : 'text-neutral-500'}`}>
                    {lmstudio?.running ? `Servidor em ${lmstudio.url}` : lmstudio?.installed ? 'Servidor desligado' : 'Não instalado'}
                  </span>
                </div>
                {lmstudio?.running ? (
                  lmstudio.models.length ? lmstudio.models.map((id) => (
                    <div key={id} className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-neutral-300 truncate">{id}</span>
                      <button type="button" onClick={() => use('lmstudio')(id)} disabled={inUse('lmstudio', id)} className="ml-auto text-[11px] text-teal-200 hover:text-white disabled:opacity-60 cursor-pointer">
                        {inUse('lmstudio', id) ? 'Em uso' : 'Usar'}
                      </button>
                    </div>
                  )) : <p className="text-neutral-400">Nenhum modelo baixado no LM Studio.</p>
                ) : lmstudio?.installed ? (
                  <button type="button" onClick={() => local.start('lmstudio')} disabled={busy === 'start:lmstudio'} className="flex items-center gap-1 px-3 py-1 rounded-lg border border-neutral-700 text-neutral-200 hover:bg-white/5 disabled:opacity-50 cursor-pointer">
                    {busy === 'start:lmstudio' ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Ligar o servidor
                  </button>
                ) : (
                  <p className="text-neutral-400">
                    Já usa o LM Studio? Ligue o servidor local nele e os modelos aparecem aqui.{' '}
                    <a href={LOCAL_PROVIDERS.lmstudio.installUrl} target="_blank" rel="noreferrer" className="text-accent-300 hover:text-accent-200">Baixar</a>
                  </p>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
