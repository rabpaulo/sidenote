import React, { useState } from 'react';
import { X, Sparkles, Bot, Asterisk, Zap, Check, RefreshCw, Terminal, Cpu, KeyRound, Search, HardDrive, ChevronDown, Loader2 } from 'lucide-react';
import { PROVIDERS } from '../config/models.js';
import { providerDetected, providerModels, unavailableReason } from '../../shared/provider-availability.js';

const LOCAL_ACCENT = {
  selected: 'border-teal-500/50 bg-teal-950/20 text-white', radio: 'border-teal-400 bg-teal-500 text-black',
  active: 'border-teal-500/60 bg-gradient-to-br from-teal-950/30 via-neutral-900/60 to-neutral-900/40 shadow-lg shadow-teal-500/10',
  iconClass: 'bg-teal-500/20 border-teal-500/30 text-teal-400', Icon: HardDrive,
};

const API_ACCENT = {
  selected: 'border-accent-500/50 bg-accent-950/20 text-white', radio: 'border-accent-400 bg-accent-500 text-black',
  active: 'border-accent-500/60 bg-gradient-to-br from-accent-950/30 via-neutral-900/60 to-neutral-900/40 shadow-lg shadow-accent-500/10',
  iconClass: 'bg-accent-500/20 border-accent-500/30 text-accent-400', Icon: Cpu,
};

const ACCENTS = {
  antigravity: {
    selected: 'border-accent-500/50 bg-accent-950/20 text-white', radio: 'border-accent-400 bg-accent-500 text-black',
    active: 'border-accent-500/60 bg-gradient-to-br from-accent-950/30 via-neutral-900/60 to-neutral-900/40 shadow-lg shadow-accent-500/10',
    iconClass: 'bg-accent-500/20 border-accent-500/30 text-accent-400', Icon: Sparkles,
  },
  codex: {
    selected: 'border-purple-500/50 bg-purple-950/20 text-white', radio: 'border-purple-400 bg-purple-500 text-white',
    active: 'border-purple-500/60 bg-gradient-to-br from-purple-950/30 via-neutral-900/60 to-neutral-900/40 shadow-lg shadow-purple-500/10',
    iconClass: 'bg-purple-500/20 border-purple-500/30 text-purple-400', Icon: Bot,
  },
  claude: {
    selected: 'border-amber-500/50 bg-amber-950/20 text-white', radio: 'border-amber-400 bg-amber-500 text-black',
    active: 'border-amber-500/60 bg-gradient-to-br from-amber-950/30 via-neutral-900/60 to-neutral-900/40 shadow-lg shadow-amber-500/10',
    iconClass: 'bg-amber-500/20 border-amber-500/30 text-amber-400', Icon: Asterisk,
  },
  opencode: {
    selected: 'border-emerald-500/50 bg-emerald-950/20 text-white', radio: 'border-emerald-400 bg-emerald-500 text-black',
    active: 'border-emerald-500/60 bg-gradient-to-br from-emerald-950/30 via-neutral-900/60 to-neutral-900/40 shadow-lg shadow-emerald-500/10',
    iconClass: 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400', Icon: Terminal,
  },
};

const accentOf = (id) => ACCENTS[id] || (PROVIDERS[id]?.kind === 'local' ? LOCAL_ACCENT : API_ACCENT);
// Long account lists get a search box.
const SEARCH_THRESHOLD = 8;

// What fixes an unavailable provider, when the app has a screen for it.
function setupOf(entry, { onOpenKeys, onOpenLocal }) {
  if (entry?.needsKey && onOpenKeys) return { label: 'Adicionar key', Icon: KeyRound, open: onOpenKeys };
  if (entry?.setup === 'local' && onOpenLocal) {
    const label = entry.installed === false ? 'Instalar' : entry.running === false ? 'Iniciar' : 'Baixar modelo';
    return { label, Icon: HardDrive, open: onOpenLocal };
  }
  return null;
}

function ProviderButton({ id, provider, availability, setProvider, onOpenKeys, onOpenLocal }) {
  const reason = unavailableReason(availability, id);
  // A provider that only lacks a key or a local model opens the screen that fixes it.
  const setup = reason ? setupOf(availability[id], { onOpenKeys, onOpenLocal }) : null;
  const needsKey = Boolean(setup);
  const notInstalled = availability[id]?.installed === false;
  const { Icon, active, iconClass } = accentOf(id);
  return (
    <button
      type="button"
      onClick={() => (setup ? setup.open() : setProvider(id))}
      disabled={Boolean(reason) && !needsKey}
      title={reason || PROVIDERS[id].tagline}
      className={`p-2.5 rounded-2xl border text-left transition-all relative overflow-hidden flex items-center gap-2 ${
        reason
          ? `border-neutral-800/60 bg-neutral-900/20 opacity-50 ${needsKey ? 'cursor-pointer hover:opacity-80' : 'cursor-not-allowed'}`
          : provider === id
            ? `${active} cursor-pointer`
            : 'border-neutral-800/80 bg-neutral-900/40 hover:bg-neutral-850 hover:border-neutral-700 cursor-pointer'
      }`}
    >
      <div className={`w-7 h-7 shrink-0 rounded-lg border flex items-center justify-center ${iconClass}`}>
        <Icon size={14} />
      </div>
      <div className="min-w-0">
        <h3 className="text-[13px] leading-tight font-bold text-white break-words">{PROVIDERS[id].shortName}</h3>
        {setup && <p className="text-[10px] text-neutral-400 truncate flex items-center gap-1"><setup.Icon size={9} /> {setup.label}</p>}
        {reason && !setup && <p className={`text-[10px] truncate ${notInstalled ? 'text-neutral-500' : 'text-rose-300'}`}>{notInstalled ? 'Não instalado' : 'Indisponível'}</p>}
        {availability[id]?.status === 'checking' && <p className="text-[10px] text-neutral-500">Verificando…</p>}
      </div>
      {provider === id && !reason && (
        <span className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-accent-200 flex items-center justify-center text-neutral-950">
          <Check size={10} strokeWidth={3} />
        </span>
      )}
    </button>
  );
}

export function ModelSelectorModal({
  isOpen,
  onClose,
  provider,
  setProvider,
  models,
  setModel,
  reasoningEfforts,
  setReasoningEffort,
  fastMode,
  toggleFastMode,
  availability = {},
  onRefreshAvailability,
  onOpenKeys,
  onOpenLocal,
}) {
  const [query, setQuery] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [showOthers, setShowOthers] = useState(false);
  if (!isOpen) return null;

  const checking = Object.values(availability).some((entry) => entry?.status === 'checking');
  // Only what this machine has (installed CLIs and runtimes, keys) is offered up front;
  // the rest stays under "Outros provedores" with what each one needs.
  const ids = Object.keys(PROVIDERS);
  const found = ids.filter((id) => providerDetected(availability[id]) || id === provider);
  const others = ids.filter((id) => !found.includes(id) && providerDetected(availability[id]) === false);
  const buttonProps = { provider, availability, setProvider: (id) => chooseProvider(id), onOpenKeys, onOpenLocal };

  const currentProviderConfig = PROVIDERS[provider];
  const activeModelId = models[provider] || currentProviderConfig.defaultModel;
  const activeReasoning = reasoningEfforts[provider] || currentProviderConfig.defaultReasoning;
  const accent = accentOf(provider);
  const levelCount = currentProviderConfig.reasoningLevels.length;
  const allModels = providerModels(currentProviderConfig, availability[provider]);
  const search = query.trim().toLowerCase();
  const shownModels = search
    ? allModels.filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(search))
    : allModels;
  const chooseProvider = (id) => {
    setQuery('');
    setProvider(id);
  };
  const useCustomModel = (event) => {
    event.preventDefault();
    if (!customModel.trim()) return;
    setModel(customModel.trim(), provider);
    setCustomModel('');
  };
  // Only providers found here explain themselves; the others' buttons already say what they need.
  const notices = found.filter((id) => !availability[id]?.needsKey && !availability[id]?.setup);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/80 backdrop-blur-md transition-opacity animate-in fade-in duration-200"
        onClick={onClose}
      />

      {/* Modal Dialog */}
      <div className="relative w-full max-w-2xl rounded-3xl border border-neutral-800 bg-[#0e0e14] shadow-2xl overflow-hidden z-10 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800/80 bg-neutral-950/60">
          <h2 className="text-lg font-bold text-white tracking-tight">Modelo de IA</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-neutral-400 hover:text-white hover:bg-neutral-800/80 transition cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 custom-scrollbar">
          {/* Provider */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="text-xs font-bold uppercase tracking-wider text-neutral-400">
                Provedor
              </label>
              {onRefreshAvailability && (
                <button
                  type="button"
                  onClick={onRefreshAvailability}
                  disabled={checking}
                  className="flex items-center gap-1 text-[11px] text-neutral-400 hover:text-white disabled:opacity-50 disabled:cursor-default cursor-pointer"
                >
                  <RefreshCw size={11} className={checking ? 'animate-spin' : ''} />
                  {checking ? 'Verificando…' : 'Verificar novamente'}
                </button>
              )}
            </div>

            <p className="mb-2.5 text-[11px] text-neutral-500 flex items-center gap-1.5">
              {checking && <Loader2 size={11} className="animate-spin" />}
              {checking ? 'Procurando CLIs, keys e modelos locais neste computador…' : 'Encontrados neste computador'}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              {found.map((id) => <ProviderButton key={id} id={id} {...buttonProps} />)}
            </div>
            {!checking && !found.some((id) => !unavailableReason(availability, id)) && (
              <p className="mt-2 text-[11px] text-amber-300/90">
                Nenhum provedor pronto. Adicione uma API key, faça login num CLI ou baixe um modelo local.
              </p>
            )}
            <div className="flex items-center justify-between gap-2 mt-4 mb-2.5">
              <button
                type="button"
                onClick={() => setShowOthers((value) => !value)}
                disabled={!others.length}
                aria-expanded={showOthers}
                className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 hover:text-neutral-200 disabled:opacity-40 cursor-pointer disabled:cursor-default"
              >
                <ChevronDown size={12} className={`transition-transform ${showOthers ? '' : '-rotate-90'}`} />
                Outros provedores ({others.length})
              </button>
              <div className="flex items-center gap-3">
                {onOpenLocal && (
                  <button type="button" onClick={onOpenLocal} className="flex items-center gap-1 text-[11px] text-neutral-400 hover:text-white cursor-pointer">
                    <HardDrive size={11} /> Modelos locais
                  </button>
                )}
                {onOpenKeys && (
                  <button type="button" onClick={onOpenKeys} className="flex items-center gap-1 text-[11px] text-neutral-400 hover:text-white cursor-pointer">
                    <KeyRound size={11} /> Gerenciar keys
                  </button>
                )}
              </div>
            </div>
            {showOthers && others.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {others.map((id) => <ProviderButton key={id} id={id} {...buttonProps} />)}
              </div>
            )}
            {notices.map((id) => {
              const reason = unavailableReason(availability, id);
              const unverified = availability[id]?.status === 'unknown' ? availability[id].reason : null;
              if (!reason && !unverified) return null;
              return (
                <p key={id} className={`mt-2 text-[11px] ${reason ? 'text-rose-300/90' : 'text-neutral-500'}`}>
                  <span className="font-semibold">{PROVIDERS[id].name}:</span> {reason || `${unverified} O provedor continua liberado.`}
                </p>
              );
            })}
          </div>

          {/* Model */}
          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-neutral-400 mb-3 block">
              Modelo
            </label>

            {allModels.length > SEARCH_THRESHOLD && (
              <div className="relative mb-2">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={`Buscar entre ${allModels.length} modelos`}
                  spellCheck={false}
                  className="w-full rounded-xl border border-neutral-800 bg-black/40 pl-7 pr-2.5 py-2 text-xs text-neutral-100 outline-none focus:border-neutral-600"
                />
              </div>
            )}
            {!allModels.length && (
              <p className="mb-2 text-[11px] text-neutral-500">
                {availability[provider]?.status === 'checking'
                  ? 'Carregando os modelos da sua conta…'
                  : 'Nenhum modelo listado. Informe o ID de um modelo abaixo.'}
              </p>
            )}
            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
              {activeModelId && !allModels.some((mod) => mod.id === activeModelId) && (
                <div className={`p-3 rounded-xl border flex items-center gap-3 ${accent.selected}`}>
                  <div className={`w-4 h-4 rounded-full border flex items-center justify-center ${accent.radio}`}>
                    <div className="w-1.5 h-1.5 rounded-full bg-current" />
                  </div>
                  <span className="font-semibold text-xs sm:text-sm font-mono break-all">{activeModelId}</span>
                  <span className="ml-auto text-[10px] text-neutral-400">ID informado</span>
                </div>
              )}
              {shownModels.map((mod) => {
                const reason = unavailableReason(availability, provider, mod.id, mod.name);
                const isSelected = mod.id === activeModelId && !reason;
                return (
                  <div
                    key={mod.id}
                    onClick={reason ? undefined : () => setModel(mod.id, provider)}
                    aria-disabled={Boolean(reason)}
                    title={reason || undefined}
                    className={`p-3 rounded-xl border flex items-center gap-3 transition ${
                      reason
                        ? 'border-neutral-800/50 bg-neutral-900/10 text-neutral-500 opacity-60 cursor-not-allowed'
                        : isSelected
                          ? `${accent.selected} cursor-pointer`
                          : 'border-neutral-800/80 bg-neutral-900/30 hover:bg-neutral-900/70 text-neutral-300 cursor-pointer'
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                        isSelected ? accent.radio : 'border-neutral-700 bg-neutral-900'
                      }`}
                    >
                      {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-current" />}
                    </div>
                    <span className="font-semibold text-xs sm:text-sm break-all">{mod.name}</span>
                    {reason && <span className="ml-auto text-[10px] text-neutral-500">Indisponível na sua conta</span>}
                  </div>
                );
              })}
            </div>
          </div>

          {currentProviderConfig.dynamicModels && (
            <form onSubmit={useCustomModel} className="-mt-3 flex gap-1.5">
              <input
                value={customModel}
                onChange={(event) => setCustomModel(event.target.value)}
                placeholder={provider === 'opencode' ? 'Outro modelo: provedor/modelo' : 'Outro modelo: ID do modelo'}
                spellCheck={false}
                aria-label="ID de outro modelo"
                className="flex-1 min-w-0 rounded-xl border border-neutral-800 bg-black/40 px-2.5 py-1.5 text-[11px] font-mono text-neutral-100 outline-none focus:border-neutral-600"
              />
              <button type="submit" disabled={!customModel.trim()} className="px-3 rounded-xl border border-neutral-800 text-[11px] text-neutral-300 hover:bg-white/5 disabled:opacity-40 cursor-pointer disabled:cursor-default">
                Usar
              </button>
            </form>
          )}

          {/* Reasoning Effort */}
          {levelCount > 1 && <div>
            <label className="text-xs font-bold uppercase tracking-wider text-neutral-400 mb-2.5 block">
              Raciocínio
            </label>

            <div className={`grid gap-2 ${levelCount > 4 ? 'grid-cols-3 sm:grid-cols-5' : levelCount === 4 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'}`}>
              {currentProviderConfig.reasoningLevels.map((lvl, levelIndex) => {
                const isSelected = lvl.id === activeReasoning;
                return (
                  <button
                    key={lvl.id}
                    type="button"
                    onClick={() => setReasoningEffort(lvl.id, provider)}
                    className={`py-2.5 px-3 rounded-xl border transition cursor-pointer flex items-center justify-center gap-1.5 ${
                      isSelected
                        ? 'border-amber-500/50 bg-amber-500/10 text-amber-300 shadow-md shadow-amber-500/5'
                        : 'border-neutral-800 bg-neutral-900/40 hover:bg-neutral-900 hover:border-neutral-700 text-neutral-300'
                    }`}
                  >
                    <div className="flex gap-0.5 items-end h-3">
                      {currentProviderConfig.reasoningLevels.map((_, barIndex) => (
                        <span
                          key={barIndex}
                          className={`w-1 rounded-full bg-current ${barIndex > levelIndex ? 'opacity-30' : ''}`}
                          style={{ height: `${4 + (barIndex * 8) / Math.max(1, levelCount - 1)}px` }}
                        />
                      ))}
                    </div>
                    <span className="font-bold text-xs">{lvl.label}</span>
                  </button>
                );
              })}
            </div>
          </div>}

          {/* Fast Mode (Codex Only) */}
          {provider === 'codex' && (
            <div className="p-4 rounded-2xl border border-purple-500/30 bg-purple-950/20 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Zap size={18} className={fastMode ? 'text-accent-300' : 'text-neutral-400'} />
                <h4 className="text-sm font-bold text-white">Fast Mode</h4>
              </div>

              <button
                type="button"
                onClick={toggleFastMode}
                className={`relative inline-flex h-7 w-13 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  fastMode ? 'bg-accent-200' : 'bg-neutral-700'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-neutral-950 shadow-lg ring-0 transition duration-200 ease-in-out ${
                    fastMode ? 'translate-x-6' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-neutral-800/80 bg-neutral-950/80 flex justify-end">
          <button
            onClick={onClose}
            className="w-full sm:w-auto px-5 py-2 rounded-full bg-white hover:bg-neutral-200 text-black font-semibold text-xs transition cursor-pointer"
          >
            Pronto
          </button>
        </div>
      </div>
    </div>
  );
}
