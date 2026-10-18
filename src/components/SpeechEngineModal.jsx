import React, { useState } from 'react';
import { X, AudioLines, Download, Trash2, Loader2, Copy, Check, RefreshCw, CircleCheck, CircleAlert, ChevronDown } from 'lucide-react';
import { SPEECH_ENGINES, SPEECH_MODELS } from '../../shared/speech-engines.js';

const megabytes = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1).replace('.', ',')} GB` : `${Math.round(bytes / 1e6)} MB`);

export function speechEngineName(status) {
  const engine = SPEECH_ENGINES.find((entry) => entry.id === status?.engine);
  if (!engine) return 'Google';
  return engine.variants ? `Whisper ${status.variant}` : engine.name.replace(' TDT 0.6B v3', '');
}

function CopyCommand({ command }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex items-start gap-1.5 rounded-lg border border-zinc-800 bg-black/40 p-2">
      <code className="flex-1 min-w-0 break-all font-mono text-[10px] text-zinc-200 select-text">{command}</code>
      <button type="button" onClick={copy} aria-label="Copiar comando" title="Copiar comando" className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 cursor-pointer">
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}

export function ModelRow({ id, state, busy, onDownload, onCancel, onRemove }) {
  const model = SPEECH_MODELS[id];
  const download = state?.download;
  const percent = download?.total ? Math.min(100, Math.round((download.received / download.total) * 100)) : 0;
  return (
    <div className="rounded-lg border border-zinc-800/80 bg-black/20 px-2.5 py-1.5 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-zinc-200">{model.label}</span>
        <span className="text-[10px] text-zinc-500">
          {state?.installed && state.bytes ? `${megabytes(state.bytes)} no disco` : `download de ${megabytes(model.bytes)}`}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {state?.installed && !download && <span className="text-[10px] text-emerald-300">Instalado</span>}
          {download ? (
            <button type="button" onClick={() => onCancel(id)} disabled={download.phase === 'extracting'} className="px-2 py-0.5 rounded border border-zinc-700 text-[10px] text-zinc-300 hover:bg-white/10 cursor-pointer disabled:opacity-40">
              Cancelar
            </button>
          ) : state?.installed ? (
            <button type="button" onClick={() => onRemove(id)} disabled={busy} title="Apagar o modelo" aria-label={`Apagar ${model.label}`} className="p-1 rounded text-zinc-500 hover:text-rose-300 hover:bg-rose-500/10 cursor-pointer disabled:opacity-40">
              <Trash2 size={12} />
            </button>
          ) : (
            <button type="button" onClick={() => onDownload(id)} disabled={busy} className="flex items-center gap-1 px-2 py-0.5 rounded bg-blue-500/20 border border-blue-500/30 text-[10px] text-blue-200 hover:bg-blue-500/30 cursor-pointer disabled:opacity-40">
              <Download size={11} /> Baixar
            </button>
          )}
        </span>
      </div>
      {download && (
        <div className="space-y-1">
          <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
            <div className="h-full bg-blue-400 transition-all" style={{ width: `${download.phase === 'extracting' ? 100 : percent}%` }} />
          </div>
          <p className="text-[10px] text-zinc-500 tabular-nums">
            {download.phase === 'extracting' ? 'Extraindo…' : `${megabytes(download.received)} de ${megabytes(download.total)} · ${percent}%`}
          </p>
        </div>
      )}
      {state?.error && <p className="text-[10px] text-rose-300">Falha no download: {state.error}</p>}
    </div>
  );
}

// What still blocks the engine besides its Python packages, which the Instalar button handles.
function missingText(engine, engineStatus) {
  if (!engineStatus) return null;
  const missing = [];
  if (engineStatus.binary && !engineStatus.binary.found) missing.push('o whisper-server');
  if (!engineStatus.modelsReady) missing.push(engine.id === 'vosk' ? 'baixar um modelo' : 'baixar o modelo');
  return missing.length ? `Falta ${missing.join(' e ')}` : null;
}

function EngineAction({ engine, engineStatus, selected, ready, busy, actions, status }) {
  if (selected) return <span className="flex items-center gap-1 text-[10px] font-medium text-blue-200"><CircleCheck size={12} /> Em uso</span>;
  if (engineStatus?.installing) return <span className="flex items-center gap-1 text-[10px] text-zinc-400"><Loader2 size={12} className="animate-spin" /> Instalando…</span>;
  const button = 'px-2.5 py-1 rounded-lg bg-blue-500/20 border border-blue-500/30 text-[11px] text-blue-200 hover:bg-blue-500/30 cursor-pointer disabled:opacity-40 disabled:cursor-default';
  if (engineStatus?.missingPackages.length && !status?.python?.error) {
    return (
      <button type="button" onClick={() => actions.install(engine.id)} disabled={!!busy} title={`Instala ${engineStatus.missingPackages.join(', ')} no Python do app`} className={button}>
        {busy === `install:${engine.id}` ? <Loader2 size={12} className="animate-spin" /> : 'Instalar'}
      </button>
    );
  }
  return (
    <button type="button" onClick={() => actions.select(engine.id, status?.variant)} disabled={!ready || !!busy} title={ready ? `Usar ${engine.name}` : missingText(engine, engineStatus) || ''} className={button}>
      {busy === `select:${engine.id}` ? <Loader2 size={12} className="animate-spin" /> : 'Usar'}
    </button>
  );
}

function EngineCard({ engine, status, busy, actions }) {
  const [showDetails, setShowDetails] = useState(false);
  const engineStatus = status?.engines?.[engine.id];
  const selected = status?.engine === engine.id;
  const ready = engine.id === 'google' || engineStatus?.ready;
  const missing = engine.id === 'google' ? null : missingText(engine, engineStatus);
  const active = selected ? status?.active : null;
  const models = engine.variants
    ? engine.models.filter((id) => SPEECH_MODELS[id].variant === status?.variant).concat(engine.models.filter((id) => SPEECH_MODELS[id].variant !== status?.variant))
    : engine.models;

  return (
    <div className={`rounded-xl border p-2.5 space-y-1.5 ${selected ? 'border-blue-500/50 bg-blue-500/[0.06]' : 'border-zinc-800/80 bg-zinc-900/30'}`}>
      <div className="flex items-center gap-2">
        <span className="font-semibold text-zinc-100">{engine.name}</span>
        <span className="text-[10px] text-zinc-500">{engine.tag}</span>
        <span className="ml-auto">
          <EngineAction engine={engine} engineStatus={engineStatus} selected={selected} ready={ready} busy={busy} actions={actions} status={status} />
        </span>
      </div>

      <div className="flex items-start gap-2">
        <p className="flex-1 text-zinc-400">{engine.summary}</p>
        <button type="button" onClick={() => setShowDetails(!showDetails)} aria-expanded={showDetails} className="flex items-center gap-0.5 text-[10px] text-zinc-500 hover:text-zinc-300 cursor-pointer">
          Detalhes <ChevronDown size={11} className={showDetails ? 'rotate-180' : ''} />
        </button>
      </div>
      {showDetails && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px]">
          {engine.details.map(([label, value]) => (
            <React.Fragment key={label}>
              <dt className="text-zinc-500">{label}</dt>
              <dd className="text-zinc-300">{value}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}

      {active && engine.id !== 'google' && (
        <p className={`text-[10px] ${active.status === 'ready' ? 'text-emerald-300' : active.status === 'loading' || active.status === 'idle' ? 'text-zinc-400' : 'text-amber-300'}`}>
          {active.status === 'ready' && `Carregado em ${active.device}${active.loadMs !== null ? ` · ${(active.loadMs / 1000).toFixed(1).replace('.', ',')} s para carregar` : ''}`}
          {active.status === 'loading' && 'Carregando o modelo…'}
          {active.status === 'idle' && 'Carrega quando a captura começar.'}
          {(active.status === 'failed' || active.status === 'fallback') && `Não funcionou, usando o Google: ${active.error}`}
        </p>
      )}

      {engine.variants && (
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="text-zinc-500">Tamanho</span>
          {engine.variants.map((variant) => (
            <button
              key={variant}
              type="button"
              onClick={() => actions.select(status.engine, variant)}
              disabled={!!busy || status?.variant === variant}
              className={`px-2 py-0.5 rounded border cursor-pointer disabled:cursor-default ${status?.variant === variant ? 'border-blue-500/50 text-blue-200' : 'border-zinc-700 text-zinc-400 hover:bg-white/10'}`}
            >
              {variant}
            </button>
          ))}
        </div>
      )}

      {missing && <p className="flex items-center gap-1 text-[11px] text-amber-300"><CircleAlert size={12} /> {missing}</p>}
      {engineStatus?.installError && (
        <div className="space-y-1">
          <p className="text-[10px] text-rose-300">Falha ao instalar: {engineStatus.installError}</p>
          {engineStatus.pip && <CopyCommand command={engineStatus.pip} />}
        </div>
      )}
      {engineStatus?.binary && !engineStatus.binary.found && (
        <p className="text-[10px] text-zinc-500">
          Compile o whisper.cpp com Vulkan e coloque o <code className="text-zinc-300">whisper-server</code> em{' '}
          <code className="text-zinc-300 break-all select-text">{status.binDir}</code> (docs/development.md).
        </p>
      )}

      {models.map((id) => (
        <ModelRow key={id} id={id} state={status?.models?.[id]} busy={!!busy}
          onDownload={actions.download} onCancel={actions.cancel} onRemove={actions.remove} />
      ))}
    </div>
  );
}

/** Menu → Reconhecimento de voz: choose Google or a local engine and manage its downloads. */
export function SpeechEngineModal({ isOpen, onClose, speech }) {
  if (!isOpen) return null;
  const { status, busy, error, refresh } = speech;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 overflow-y-auto">
      <div className="fixed inset-0 bg-black/80 backdrop-blur-md" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby="speech-title" className="relative w-full max-w-lg rounded-2xl border border-zinc-800 bg-[#0e0e14] shadow-2xl overflow-hidden z-10 flex flex-col max-h-[90vh] text-[12px]">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800/80 bg-zinc-950/60">
          <h2 id="speech-title" className="flex items-center gap-2 text-base font-bold text-white tracking-tight">
            <AudioLines size={16} className="text-blue-300" />
            Reconhecimento de voz
          </h2>
          <button type="button" onClick={onClose} aria-label="Fechar" className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800/80 transition cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 overflow-y-auto space-y-2">
          <p className="text-zinc-500">Os locais rodam offline neste PC. Se um falhar, o app volta ao Google.</p>
          {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-200">{error}</p>}
          {!status && !error && <p className="flex items-center gap-2 text-zinc-500"><Loader2 size={13} className="animate-spin" /> Verificando…</p>}
          {status && SPEECH_ENGINES.map((engine) => (
            <EngineCard key={engine.id} engine={engine} status={status} busy={busy} actions={speech} />
          ))}
          {status && (
            <div className="flex items-start gap-2 pt-1 text-[10px] text-zinc-600">
              <p className="flex-1 font-mono break-all leading-relaxed">
                {status.python?.error || (status.python ? `Python ${status.python.version} · ${status.python.path}` : 'Python: verificando…')}
                <br />Modelos em {status.modelsDir}
              </p>
              <button type="button" onClick={refresh} disabled={!!busy} className="flex items-center gap-1 px-2 py-1 rounded border border-zinc-800 text-zinc-400 hover:text-white hover:bg-white/10 cursor-pointer disabled:opacity-40">
                <RefreshCw size={11} className={busy === 'refresh' ? 'animate-spin' : ''} /> Verificar de novo
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
