import React, { useState, useEffect, useRef } from 'react';
import {
  Menu,
  Sparkles,
  Bot,
  Asterisk,
  Briefcase,
  Languages,
  RotateCcw,
  Droplet,
  Pin,
  Minus,
  X,
  ChevronRight,
  Zap,
  Type,
  Camera,
  Minimize2,
  NotebookText,
  KeyRound,
  Terminal,
  Cpu,
  AudioLines,
  HardDrive,
  CalendarDays,
} from 'lucide-react';

import { getPersonaById } from '../config/personas.js';
import { AUTO_LANGUAGE, LANGUAGES } from '../../shared/language.js';

const LANGUAGE_OPTIONS = [AUTO_LANGUAGE, ...LANGUAGES];
const languageLabel = (language) => language.split('-')[0].toUpperCase();
const CURSOR_MONITOR = 'cursor';
const shortcutLabel = (accelerator) => accelerator.replace('Control', 'Ctrl');
import { useWindowOpacity, MIN_OPACITY, MAX_OPACITY } from '../hooks/useWindowOpacity.js';

export function AppMenu({
  language,
  setLanguage,
  detectedLanguage,
  agentSettings,
  selectedPersona,
  onOpenModelModal,
  onOpenPersonaModal,
  onOpenNotesModal,
  onOpenKeysModal,
  onOpenSpeechModal,
  onOpenLocalModal,
  onOpenGoogleModal,
  googleStatus,
  speechLabel,
  notesStatus,
  onNewSession,
  onOpenChange,
  isCompact = false,
  onToggleCompact,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(true);
  const [screenshot, setScreenshot] = useState(null);
  const [compositor, setCompositor] = useState(null);
  const { opacity, setOpacity, solidText, setSolidText, canSolidText, isSupported: isDesktop } = useWindowOpacity();
  const menuRef = useRef(null);

  const setOpen = (open) => {
    setIsOpen(open);
    onOpenChange?.(open);
  };

  useEffect(() => {
    if (isOpen) window.sidenoteDesktop?.getCompositor?.().then(setCompositor, () => {});
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handlePointerDown = (event) => {
      if (!menuRef.current?.contains(event.target)) setOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    window.sidenoteDesktop?.getAlwaysOnTop?.().then((pinned) => setIsPinned(!!pinned));
  }, []);

  // Monitors are listed each time the menu opens, since they can be plugged in or out.
  useEffect(() => {
    if (!isOpen) return;
    window.sidenoteDesktop?.getScreenshotSettings?.().then(setScreenshot).catch(() => setScreenshot(null));
  }, [isOpen]);

  const cycleScreenshotMonitor = async () => {
    const options = [CURSOR_MONITOR, ...screenshot.monitors.map((monitor) => monitor.name)];
    const next = options[(options.indexOf(screenshot.monitor) + 1) % options.length];
    const monitor = await window.sidenoteDesktop.setScreenshotMonitor(next);
    setScreenshot((current) => ({ ...current, monitor }));
  };

  const screenshotMonitorLabel = () => {
    if (screenshot.monitor === CURSOR_MONITOR) return 'Auto · cursor';
    const connected = screenshot.monitors.some((monitor) => monitor.name === screenshot.monitor);
    return connected ? screenshot.monitor : `${screenshot.monitor} · desconectado`;
  };

  const handleTogglePin = async () => {
    if (window.sidenoteDesktop?.toggleAlwaysOnTop) {
      setIsPinned(!!(await window.sidenoteDesktop.toggleAlwaysOnTop()));
    } else {
      setIsPinned(!isPinned);
    }
  };

  const runAndClose = (action) => () => {
    setOpen(false);
    action?.();
  };

  const { provider, currentProviderConfig, currentModel, fastMode } = agentSettings;
  const currentPersona = getPersonaById(selectedPersona);
  const ProviderIcon = { antigravity: Sparkles, codex: Bot, claude: Asterisk, opencode: Terminal, ollama: HardDrive, lmstudio: HardDrive }[provider] || Cpu;

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!isOpen)}
        aria-label="Menu"
        aria-expanded={isOpen}
        title="Menu"
        className={`p-2 rounded-xl transition cursor-pointer ${isOpen ? 'bg-white/10 text-white' : 'app-quiet-button text-zinc-400'}`}
      >
        <Menu size={15} />
      </button>

      {isOpen && (
        <div role="menu" className="app-menu absolute left-0 bottom-full mb-2 z-40 w-64 max-h-[calc(100dvh-4rem)] overflow-y-auto rounded-xl p-1.5 text-[12px]">
          <button type="button" role="menuitem" onClick={runAndClose(onOpenModelModal)} className="app-menu-item">
            <ProviderIcon size={14} className="text-blue-300 shrink-0" />
            <span className="text-zinc-400">Modelo</span>
            <span className="ml-auto flex items-center gap-1 truncate text-zinc-100 font-medium">
              <span className="truncate">{currentModel?.name || currentProviderConfig.shortName}</span>
              {fastMode && provider === 'codex' && <Zap size={10} className="text-amber-400 shrink-0" />}
            </span>
            <ChevronRight size={12} className="text-zinc-500 shrink-0" />
          </button>

          <button type="button" role="menuitem" onClick={runAndClose(onOpenPersonaModal)} className="app-menu-item">
            <Briefcase size={14} className="text-zinc-400 shrink-0" />
            <span className="text-zinc-400">Modo</span>
            <span className="ml-auto truncate text-zinc-100 font-medium">{currentPersona?.shortName || 'Reunião Geral'}</span>
            <ChevronRight size={12} className="text-zinc-500 shrink-0" />
          </button>

          {onOpenKeysModal && (
            <button type="button" role="menuitem" onClick={runAndClose(onOpenKeysModal)} className="app-menu-item">
              <KeyRound size={14} className="text-zinc-400 shrink-0" />
              <span className="text-zinc-400">Chaves de API</span>
              <ChevronRight size={12} className="ml-auto text-zinc-500 shrink-0" />
            </button>
          )}

          {onOpenLocalModal && (
            <button type="button" role="menuitem" onClick={runAndClose(onOpenLocalModal)} className="app-menu-item">
              <HardDrive size={14} className="text-zinc-400 shrink-0" />
              <span className="text-zinc-400">Modelos locais</span>
              <ChevronRight size={12} className="ml-auto text-zinc-500 shrink-0" />
            </button>
          )}

          {onOpenGoogleModal && (
            <button type="button" role="menuitem" onClick={runAndClose(onOpenGoogleModal)} className="app-menu-item">
              <CalendarDays size={14} className={`shrink-0 ${googleStatus?.connected ? 'text-emerald-300' : 'text-zinc-400'}`} />
              <span className="text-zinc-400">Google</span>
              <span className="ml-auto truncate text-zinc-100 font-medium">
                {googleStatus?.connected ? 'Agenda e Docs' : googleStatus?.connecting ? 'Entrando…' : 'Conectar'}
              </span>
              <ChevronRight size={12} className="text-zinc-500 shrink-0" />
            </button>
          )}

          {onOpenSpeechModal && (
            <button type="button" role="menuitem" onClick={runAndClose(onOpenSpeechModal)} className="app-menu-item">
              <AudioLines size={14} className="text-zinc-400 shrink-0" />
              <span className="text-zinc-400">Reconhecimento de voz</span>
              <span className="ml-auto truncate text-zinc-100 font-medium">{speechLabel || ''}</span>
              <ChevronRight size={12} className="text-zinc-500 shrink-0" />
            </button>
          )}

          {onOpenNotesModal && (
            <button type="button" role="menuitem" onClick={runAndClose(onOpenNotesModal)} className="app-menu-item">
              <NotebookText size={14} className={`shrink-0 ${notesStatus?.connected ? 'text-emerald-300' : 'text-zinc-400'}`} />
              <span className="text-zinc-400">Notas</span>
              <span className="ml-auto truncate text-zinc-100 font-medium">
                {notesStatus?.connected ? `${notesStatus.files.toLocaleString('pt-BR')} no Obsidian` : notesStatus?.error ? 'Erro' : 'Conectar'}
              </span>
              <ChevronRight size={12} className="text-zinc-500 shrink-0" />
            </button>
          )}

          <button
            type="button"
            role="menuitem"
            onClick={() => setLanguage(LANGUAGE_OPTIONS[(LANGUAGE_OPTIONS.indexOf(language) + 1) % LANGUAGE_OPTIONS.length])}
            className="app-menu-item"
          >
            <Languages size={14} className="text-zinc-400 shrink-0" />
            <span className="text-zinc-400">Idioma</span>
            <span className="ml-auto text-zinc-100 font-semibold">
              {language === AUTO_LANGUAGE ? `Auto${detectedLanguage ? ` · ${languageLabel(detectedLanguage)}` : ''}` : languageLabel(language)}
            </span>
          </button>

          {screenshot && (
            <button
              type="button"
              role="menuitem"
              onClick={cycleScreenshotMonitor}
              className="app-menu-item"
              title={`Monitor capturado por ${shortcutLabel(screenshot.shortcut)} e enviado ao agente. Clique para alternar.`}
            >
              <Camera size={14} className="text-zinc-400 shrink-0" />
              <span className="text-zinc-400">Captura</span>
              <span className="ml-auto truncate text-zinc-100 font-semibold">{screenshotMonitorLabel()}</span>
              <span className="text-[10px] text-zinc-500 shrink-0">{shortcutLabel(screenshot.shortcut)}</span>
            </button>
          )}

          {onToggleCompact && (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={isCompact}
              onClick={runAndClose(onToggleCompact)}
              className="app-menu-item"
              title="Mostra só a resposta do agente, as configurações e os medidores de áudio"
            >
              <Minimize2 size={14} className={`shrink-0 ${isCompact ? 'text-blue-300' : 'text-zinc-400'}`} />
              <span className="text-zinc-100">Modo compacto</span>
              <span className="ml-auto text-[10px] text-zinc-500">Alt+C</span>
              <span className={`app-menu-switch ${isCompact ? 'app-menu-switch--on' : ''}`} aria-hidden="true" />
            </button>
          )}

          <button type="button" role="menuitem" onClick={runAndClose(onNewSession)} className="app-menu-item">
            <RotateCcw size={14} className="text-zinc-400 shrink-0" />
            <span className="text-zinc-100">Nova sessão</span>
            <span className="ml-auto text-[10px] text-zinc-500">Alt+N</span>
          </button>

          {isDesktop && (
            <>
              <div className="app-menu-divider" />

              <div className="px-2.5 py-2">
                <div className="flex items-center gap-2 mb-2">
                  <Droplet size={14} className="text-zinc-400 shrink-0" />
                  <span className="text-zinc-400">Opacidade</span>
                  <span className="ml-auto text-zinc-100 tabular-nums">{Math.round(opacity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={MIN_OPACITY * 100}
                  max={MAX_OPACITY * 100}
                  step={5}
                  value={Math.round(opacity * 100)}
                  onChange={(event) => setOpacity(Number(event.target.value) / 100)}
                  className="app-opacity-slider w-full cursor-pointer"
                  aria-label="Opacidade da janela"
                />
                {compositor === false && (
                  <p className="mt-1.5 text-[10px] leading-snug text-amber-300">
                    Sem compositor ativo. Inicie o picom ou o xcompmgr e a janela reabre transparente.
                  </p>
                )}
              </div>

              {canSolidText && (
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={solidText}
                  onClick={() => setSolidText(!solidText)}
                  className="app-menu-item"
                  title="Deixa só o fundo transparente e mantém o texto 100% opaco e com alto contraste"
                >
                  <Type size={14} className={`shrink-0 ${solidText ? 'text-blue-300' : 'text-zinc-400'}`} />
                  <span className="text-zinc-100">Texto nítido</span>
                  <span className={`app-menu-switch ml-auto ${solidText ? 'app-menu-switch--on' : ''}`} aria-hidden="true" />
                </button>
              )}

              <button type="button" role="menuitemcheckbox" aria-checked={isPinned} onClick={handleTogglePin} className="app-menu-item">
                <Pin size={14} className={`shrink-0 ${isPinned ? 'rotate-45 text-blue-300' : 'text-zinc-400'}`} />
                <span className="text-zinc-100">Fixar no topo</span>
                <span className={`app-menu-switch ml-auto ${isPinned ? 'app-menu-switch--on' : ''}`} aria-hidden="true" />
              </button>

              <div className="app-menu-divider" />

              <div className="flex gap-1">
                <button type="button" role="menuitem" onClick={runAndClose(() => window.sidenoteDesktop?.minimize?.())} className="app-menu-item flex-1">
                  <Minus size={14} className="text-zinc-400 shrink-0" />
                  <span className="text-zinc-100">Minimizar</span>
                </button>
                <button type="button" role="menuitem" onClick={() => window.sidenoteDesktop?.close?.()} className="app-menu-item app-menu-item--danger flex-1">
                  <X size={14} className="shrink-0" />
                  <span>Fechar</span>
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
