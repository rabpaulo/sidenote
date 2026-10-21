import React, { useState, useEffect, useCallback } from 'react';
import { AlertCircle, X, RefreshCw } from 'lucide-react';
import { CompactTabs } from './components/CompactTabs.jsx';
import { CompactTranscriptFeed } from './components/CompactTranscriptFeed.jsx';
import { SummaryPanel } from './components/SummaryPanel.jsx';
import { HistoryPanel } from './components/HistoryPanel.jsx';
import { streamLabel, toSelection } from './components/PcSourcePicker.jsx';
import { CompactAudioMeters } from './components/CompactAudioMeters.jsx';
import { CompactBottomBar } from './components/CompactBottomBar.jsx';
import { CompactModeBar } from './components/CompactModeBar.jsx';
import { ModelSelectorModal } from './components/ModelSelectorModal.jsx';
import { PersonaSelectorModal } from './components/PersonaSelectorModal.jsx';
import { CandidateContextEditor } from './components/CandidateContextEditor.jsx';
import { NotesVaultModal } from './components/NotesVaultModal.jsx';
import { ApiKeysModal } from './components/ApiKeysModal.jsx';
import { SpeechEngineModal, speechEngineName } from './components/SpeechEngineModal.jsx';
import { WelcomeModal } from './components/WelcomeModal.jsx';
import { LocalModelsModal } from './components/LocalModelsModal.jsx';
import { GoogleModal } from './components/GoogleModal.jsx';
import { MeetingEventBar } from './components/MeetingEventBar.jsx';
import { useGoogle } from './hooks/useGoogle.js';
import { welcomeNeeds } from './components/welcome.js';
import { useSpeechEngines } from './hooks/useSpeechEngines.js';
import { useVoiceCopilot } from './hooks/useVoiceCopilot.js';
import { useAgentSocket } from './hooks/useAgentSocket.js';
import { useAgentSettings } from './hooks/useAgentSettings.js';
import { useSummarySettings } from './hooks/useSummarySettings.js';
import { useCandidateProfile } from './hooks/useCandidateProfile.js';
import { useNotesVault } from './hooks/useNotesVault.js';
import { useMeetingHistory } from './hooks/useMeetingHistory.js';
import { usePcAudioSource } from './hooks/usePcAudioSource.js';
import { useTextZoom } from './hooks/useTextZoom.js';
import { AUTO_LANGUAGE } from '../shared/language.js';
import { availableSelection, unavailableReason } from '../shared/provider-availability.js';
import { PROVIDERS } from './config/models.js';

export default function App() {
  const [activeTab, setActiveTab] = useState('transcription'); // transcription | session | summary | history
  const [language, setLanguage] = useState(() => {
    try {
      return localStorage.getItem('sidenote_language_v1') || AUTO_LANGUAGE;
    } catch {
      return AUTO_LANGUAGE;
    }
  });
  const [detectedLanguage, setDetectedLanguage] = useState(null);
  const [isModelModalOpen, setIsModelModalOpen] = useState(false);
  const [isPersonaModalOpen, setIsPersonaModalOpen] = useState(false);
  const [isContextOpen, setIsContextOpen] = useState(false);
  const [isNotesOpen, setIsNotesOpen] = useState(false);
  const [isKeysOpen, setIsKeysOpen] = useState(false);
  const [isSpeechOpen, setIsSpeechOpen] = useState(false);
  const [isLocalOpen, setIsLocalOpen] = useState(false);
  const [isGoogleOpen, setIsGoogleOpen] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [sessionToast, setSessionToast] = useState(null);
  const [isCompact, setIsCompact] = useState(() => {
    try {
      return localStorage.getItem('sidenote_compact_v1') === '1';
    } catch {
      return false;
    }
  });
  const toggleCompact = useCallback(() => setIsCompact((value) => !value), []);

  // Agent Settings (Provider: Antigravity / Codex, Model, Reasoning Effort, Fast Mode)
  const agentSettings = useAgentSettings();
  const summarySettings = useSummarySettings();
  // Candidate profile, persisted by the backend in a file outside the app's own data.
  const candidateProfile = useCandidateProfile();
  const notesVault = useNotesVault();
  // Whole desktop or only the meeting app (Linux).
  const pcSource = usePcAudioSource();
  // Ctrl +/-/0 scale the reading feed while the window has focus.
  useTextZoom();

  // Agent WebSocket connection hook with PC Loopback & Copilot
  const {
    isConnected,
    isProcessing,
    conversationIds,
    messages,
    summary,
    summaryNotice,
    clearSummaryNotice,
    requestSummary,
    syncSummarySettings,
    exportSummary,
    currentToolCall,
    sendMessage,
    abortAgent,
    resetSession,
    syncSettings,
    syncLanguage,
    providerAvailability,
    refreshProviders,
    agentNotice,
    clearAgentNotice,
    pcDetectedLanguage,

    pcAudioLevel,
    isPcCapturing,
    pcCaptureApp,
    historyVersion,
    googleStatus,
    meetingEvent,
    localPulls,
    speechStatus,
    speechFallback,
    clearSpeechFallback,
    isPcSpeaking,
    isTranscribingPc,
    pcAudioError,
    pcLiveTranscripts,
    utteranceNotes,
    clearPcAudioError,
    autoRespond,
    selectedPersona,
    changePersona,
    startPcCapture,
    stopPcCapture,
    triggerCopilot,
  } = useAgentSocket();
  const meetingHistory = useMeetingHistory(historyVersion);
  const speech = useSpeechEngines({ isOpen: isSpeechOpen, pushed: speechStatus });
  const google = useGoogle({ pushedStatus: googleStatus, pushedEvent: meetingEvent });

  // A provider or model the account cannot use is replaced by the first usable one.
  const selectionReason = unavailableReason(providerAvailability, agentSettings.provider,
    agentSettings.currentModelId, agentSettings.currentModel?.name);
  const selectionFallback = selectionReason
    ? availableSelection(providerAvailability, PROVIDERS, agentSettings.provider, agentSettings.currentModelId)
    : null;
  useEffect(() => {
    if (!selectionFallback) return;
    if (selectionFallback.provider !== agentSettings.provider) agentSettings.setProvider(selectionFallback.provider);
    agentSettings.setModel(selectionFallback.model, selectionFallback.provider);
    // A provider with no model chosen yet just takes the first listed one.
    if (selectionFallback.provider === agentSettings.provider && !agentSettings.currentModelId) return;
    setSessionToast(`${selectionReason} Usando ${PROVIDERS[selectionFallback.provider].name} · ${selectionFallback.modelName}.`);
  }, [selectionFallback?.provider, selectionFallback?.model]);
  // With nothing usable, the selection stays and this banner explains why.
  const availabilityAlert = agentNotice || (selectionReason && !selectionFallback ? selectionReason : null);

  // First run: shown once something is known to be missing, and kept open until
  // closed, so finishing a step does not make it vanish.
  const WELCOME_KEY = 'sidenote_welcome_v1';
  const needs = welcomeNeeds(providerAvailability, speech.status);
  const [isWelcomeOpen, setIsWelcomeOpen] = useState(false);
  useEffect(() => {
    if (!needs.known || (!needs.provider && !needs.speech)) return;
    try {
      if (localStorage.getItem(WELCOME_KEY) === 'done') return;
    } catch {}
    setIsWelcomeOpen(true);
  }, [needs.known, needs.provider, needs.speech]);
  const closeWelcome = () => {
    setIsWelcomeOpen(false);
    try {
      localStorage.setItem(WELCOME_KEY, 'done');
    } catch {}
  };

  // Sincroniza configurações do modelo com o servidor em tempo real
  useEffect(() => {
    syncSettings({
      provider: agentSettings.provider,
      model: agentSettings.currentModelId,
      reasoningEffort: agentSettings.currentReasoning,
      fastMode: agentSettings.fastMode,
    });
  }, [
    syncSettings,
    agentSettings.provider,
    agentSettings.currentModelId,
    agentSettings.currentReasoning,
    agentSettings.fastMode,
  ]);

  useEffect(() => {
    syncSummarySettings(summarySettings.settings);
  }, [syncSummarySettings, summarySettings.settings]);

  // The previous session's file is saved after the reset, so say where it went.
  useEffect(() => {
    if (summaryNotice?.archived) setSessionToast(`Sessão anterior salva em ${summaryNotice.file}`);
  }, [summaryNotice]);

  useEffect(() => {
    syncLanguage(language);
    try {
      localStorage.setItem('sidenote_language_v1', language);
    } catch {}
  }, [syncLanguage, language]);

  useEffect(() => {
    try {
      localStorage.setItem('sidenote_compact_v1', isCompact ? '1' : '0');
    } catch {}
    window.sidenoteDesktop?.setMode?.(isCompact ? 'compact' : 'normal');
  }, [isCompact]);

  // Callback when a final voice message is recognized
  const handleFinalTranscript = useCallback(
    (transcript) => {
      console.log('[App] Voice recognized:', transcript);
      sendMessage(transcript, 'voice', {
        provider: agentSettings.provider,
        model: agentSettings.currentModelId,
        reasoningEffort: agentSettings.currentReasoning,
        fastMode: agentSettings.fastMode,
      });
    },
    [
      sendMessage,
      agentSettings.provider,
      agentSettings.currentModelId,
      agentSettings.currentReasoning,
      agentSettings.fastMode,
    ]
  );

  // Unified Voice Copilot hook (Microphone, Web Audio, MediaRecorder & Web Speech)
  const {
    isListening,
    isTranscribing,
    interimTranscript,
    audioLevel,
    frequencyBars,
    micPermission,
    errorMessage,
    clearError,
    toggleListening,
    startRecording,
    cancelRecording,
    detectedLanguage: micDetectedLanguage,
  } = useVoiceCopilot({
    language,
    onFinalTranscript: handleFinalTranscript,
  });

  // Whichever side spoke last decides the language shown in the menu.
  useEffect(() => { if (micDetectedLanguage) setDetectedLanguage(micDetectedLanguage); }, [micDetectedLanguage]);
  useEffect(() => { if (pcDetectedLanguage) setDetectedLanguage(pcDetectedLanguage); }, [pcDetectedLanguage]);

  // Nova Sessão: limpa todo o chat, reseta cronômetro, aborta processos e reinicia do zero
  const handleNewSession = useCallback(() => {
    cancelRecording();
    abortAgent();
    resetSession();
    setElapsedSeconds(0);
    setActiveTab('transcription');
    setSessionToast('Nova sessão iniciada. Chat resetado.');
    setTimeout(() => setSessionToast(null), 3000);
  }, [abortAgent, resetSession, cancelRecording]);

  // Timer counter when active or listening
  useEffect(() => {
    let timer;
    if (isListening || isPcSpeaking || isProcessing) {
      timer = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isListening, isPcSpeaking, isProcessing]);

  // The backend follows a restarted stream; remember the new one for the next launch.
  useEffect(() => {
    const { app, setApp } = pcSource;
    if (!app || !pcCaptureApp || pcCaptureApp.id !== app.id || pcCaptureApp.stream === null) return;
    if (pcCaptureApp.stream !== app.stream) setApp({ ...app, stream: pcCaptureApp.stream });
  }, [pcCaptureApp?.id, pcCaptureApp?.stream]);

  // The chosen stream ended and the app has several others: list them to choose from.
  useEffect(() => {
    if (pcCaptureApp?.ambiguous) pcSource.refresh();
  }, [pcCaptureApp?.ambiguous, pcCaptureApp?.streams]);

  // Auto-connect PC loopback audio capture on launch, from the source chosen last time.
  useEffect(() => {
    startPcCapture(pcSource.captureOptions());
  }, [startPcCapture]);

  // Desktop keyboard shortcuts (Alt+Space toggles mic, Ctrl+D triggers copilot, Alt+N / Ctrl+Shift+R for new session)
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Alt+Space -> Toggle microphone
      if (e.altKey && e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        toggleListening();
      }

      // Ctrl+D / Cmd+D -> Trigger Copilot
      if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        triggerCopilot(null, {
          provider: agentSettings.provider,
          model: agentSettings.currentModelId,
          persona: selectedPersona,
          reasoningEffort: agentSettings.currentReasoning,
          fastMode: agentSettings.fastMode,
        });
      }

      // Alt+C -> Modo compacto
      if (e.altKey && e.code === 'KeyC' && !e.repeat) {
        e.preventDefault();
        toggleCompact();
      }

      // Alt+N or Ctrl+Shift+R -> Nova Sessão
      if ((e.altKey && (e.key === 'n' || e.key === 'N')) || ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'r' || e.key === 'R'))) {
        e.preventDefault();
        handleNewSession();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    triggerCopilot,
    handleNewSession,
    toggleListening,
    toggleCompact,
    agentSettings.provider,
    agentSettings.currentModelId,
    agentSettings.currentReasoning,
    agentSettings.fastMode,
    selectedPersona,
  ]);

  // Electron Desktop shortcuts & IPC synchronization
  useEffect(() => {
    if (window.sidenoteDesktop?.onShortcut) {
      const cleanup = window.sidenoteDesktop.onShortcut((action) => {
        console.log('[Desktop IPC] Shortcut received:', action);
        if (action === 'ask_copilot') {
          triggerCopilot(null, {
            provider: agentSettings.provider,
            model: agentSettings.currentModelId,
            persona: selectedPersona,
            reasoningEffort: agentSettings.currentReasoning,
            fastMode: agentSettings.fastMode,
          });
        } else if (action === 'new_session') {
          handleNewSession();
        } else if (action === 'toggle_pc_audio') {
          if (isPcCapturing) stopPcCapture();
          else startPcCapture(pcSource.captureOptions());
        } else if (action === 'toggle_mic') {
          toggleListening();
        }
      });
      return cleanup;
    }
  }, [
    triggerCopilot,
    handleNewSession,
    isPcCapturing,
    startPcCapture,
    stopPcCapture,
    pcSource.captureOptions,
    toggleListening,
    agentSettings.provider,
    agentSettings.currentModelId,
    agentSettings.currentReasoning,
    agentSettings.fastMode,
    selectedPersona,
  ]);

  // Ctrl+Alt+S: the main process captures the screen and the image goes straight to the agent.
  useEffect(() => {
    if (!window.sidenoteDesktop?.onScreenshot) return undefined;
    return window.sidenoteDesktop.onScreenshot(({ image, error }) => {
      if (error || !image) {
        setSessionToast(`Falha na captura de tela: ${error || 'imagem vazia'}`);
        setTimeout(() => setSessionToast(null), 4000);
        return;
      }
      sendMessage('', 'screenshot', {
        provider: agentSettings.provider,
        model: agentSettings.currentModelId,
        reasoningEffort: agentSettings.currentReasoning,
        fastMode: agentSettings.fastMode,
        images: [image],
      });
    });
  }, [
    sendMessage,
    agentSettings.provider,
    agentSettings.currentModelId,
    agentSettings.currentReasoning,
    agentSettings.fastMode,
  ]);

  const togglePcCapture = () => {
    if (isPcCapturing) stopPcCapture();
    else startPcCapture(pcSource.captureOptions());
  };
  // Choosing a source means listening to it, so the capture switches (or starts) right away.
  const selectPcSource = (app) => {
    pcSource.setApp(app);
    // Picked from the list just shown, so the stream index is current (see startAppCapture).
    startPcCapture(app ? { app: { ...app, fresh: true } } : {});
  };
  const ambiguousStreams = isPcCapturing && pcCaptureApp?.ambiguous
    ? pcSource.streams.filter((entry) => entry.id === pcCaptureApp.id) : null;
  const isWindowDraggable = !isModelModalOpen && !isPersonaModalOpen && !isContextOpen && !isNotesOpen && !isKeysOpen && !isSpeechOpen
    && !isLocalOpen && !isGoogleOpen;
  const menuProps = {
    language,
    setLanguage,
    detectedLanguage,
    selectedPersona,
    onOpenModelModal: () => setIsModelModalOpen(true),
    onOpenPersonaModal: () => setIsPersonaModalOpen(true),
    onOpenNotesModal: () => setIsNotesOpen(true),
    onOpenKeysModal: () => setIsKeysOpen(true),
    onOpenSpeechModal: () => setIsSpeechOpen(true),
    onOpenLocalModal: () => setIsLocalOpen(true),
    onOpenGoogleModal: () => setIsGoogleOpen(true),
    googleStatus: google.status,
    speechLabel: speech.status ? speechEngineName(speech.status) : null,
    notesStatus: notesVault.status,
    onNewSession: handleNewSession,
    isCompact,
    onToggleCompact: toggleCompact,
  };

  return (
    <div className="app-shell text-zinc-100 flex flex-col h-dvh w-screen overflow-hidden select-none">
      {/* Frameless Desktop Window Container */}
      <div className="app-frame flex flex-col h-full w-full">

        {/* New Session Feedback Banner */}
        {sessionToast && (
          <div className="bg-blue-500/10 border-b border-blue-500/25 px-3 py-1.5 flex items-center justify-between text-[11px] text-blue-200 animate-in fade-in slide-in-from-top-1 duration-150">
            <div className="flex items-center gap-1.5 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              <span>{sessionToast}</span>
            </div>
            <button
              type="button"
              onClick={() => setSessionToast(null)}
              className="p-0.5 hover:bg-blue-500/20 rounded transition text-blue-200 hover:text-white cursor-pointer"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {availabilityAlert && (
          <div role="alert" className="bg-rose-500/10 border-b border-rose-500/20 px-3 py-2 flex items-start justify-between gap-2 text-[11px] text-rose-300">
            <div className="flex items-start gap-1.5">
              <AlertCircle size={13} className="shrink-0 mt-0.5" />
              <span>
                {availabilityAlert}{' '}
                <button type="button" onClick={() => setIsModelModalOpen(true)} className="underline font-semibold hover:text-white cursor-pointer">
                  Escolher outro modelo
                </button>
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button type="button" onClick={refreshProviders} aria-label="Verificar provedores novamente" title="Verificar novamente" className="p-0.5 hover:bg-rose-500/20 rounded cursor-pointer">
                <RefreshCw size={12} />
              </button>
              {agentNotice && (
                <button type="button" onClick={clearAgentNotice} aria-label="Fechar aviso do provedor" className="p-0.5 hover:bg-rose-500/20 rounded cursor-pointer">
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
        )}

        {ambiguousStreams && (
          <div role="alert" className="bg-amber-500/10 border-b border-amber-500/20 px-3 py-2 space-y-1.5 text-[11px] text-amber-200">
            <div className="flex items-start gap-1.5">
              <AlertCircle size={13} className="shrink-0 mt-0.5" />
              <span>
                Não dá para saber qual dos {pcCaptureApp.streams} áudios de {pcCaptureApp.name} é o da chamada.
                Nada está sendo transcrito até você escolher.
              </span>
            </div>
            <div className="flex items-center gap-1.5 pl-5">
              <select
                value=""
                onChange={(event) => {
                  const picked = ambiguousStreams.find((entry) => String(entry.stream) === event.target.value);
                  if (picked) selectPcSource(toSelection(picked));
                }}
                aria-label={`Escolher o áudio de ${pcCaptureApp.name}`}
                className="flex-1 min-w-0 rounded bg-zinc-900 border border-white/10 px-1.5 py-0.5 text-[10px] text-zinc-200 cursor-pointer"
              >
                <option value="" disabled>Escolher o áudio da chamada…</option>
                {ambiguousStreams.map((entry, index) => (
                  <option key={entry.stream} value={String(entry.stream)}>{streamLabel(entry, index + 1)}</option>
                ))}
              </select>
              <button type="button" onClick={pcSource.refresh} aria-label="Medir o som de novo" title="Medir o som de novo" className="p-0.5 rounded hover:bg-amber-500/20 cursor-pointer">
                <RefreshCw size={11} className={pcSource.loading ? 'animate-spin' : ''} />
              </button>
              <button type="button" onClick={() => selectPcSource(null)} className="shrink-0 underline font-semibold hover:text-white cursor-pointer">
                Desktop inteiro
              </button>
            </div>
          </div>
        )}

        {speechFallback && (
          <div role="alert" className="bg-amber-500/10 border-b border-amber-500/20 px-3 py-2 flex items-start justify-between gap-2 text-[11px] text-amber-200">
            <div className="flex items-start gap-1.5">
              <AlertCircle size={13} className="shrink-0 mt-0.5" />
              <span>
                O reconhecimento local ({speechEngineName({ engine: speechFallback.engine, variant: speech.status?.variant })}) falhou:{' '}
                {speechFallback.error}. {speechFallback.permanent ? 'O app passou a usar o Google' : 'Esta fala foi transcrita pelo Google'}.{' '}
                <button type="button" onClick={() => setIsSpeechOpen(true)} className="underline font-semibold hover:text-white cursor-pointer">Ver</button>
              </span>
            </div>
            <button type="button" onClick={clearSpeechFallback} aria-label="Fechar aviso do reconhecimento de voz" className="p-0.5 shrink-0 hover:bg-amber-500/20 rounded cursor-pointer">
              <X size={12} />
            </button>
          </div>
        )}

        {/* Mic Permission / Error Banner */}
        {pcAudioError && (
          <div role="alert" className="bg-rose-500/10 border-b border-rose-500/20 px-3 py-2 flex items-start justify-between gap-2 text-[11px] text-rose-300">
            <div className="flex items-start gap-1.5">
              <AlertCircle size={13} className="shrink-0 mt-0.5" />
              <span>Áudio do PC: {pcAudioError}. A fala não foi enviada ao modelo. Tente novamente.</span>
            </div>
            <button type="button" onClick={clearPcAudioError} aria-label="Fechar erro do áudio do PC" className="p-0.5 shrink-0 hover:bg-rose-500/20 rounded cursor-pointer">
              <X size={12} />
            </button>
          </div>
        )}
        {errorMessage && (
          <div className="bg-rose-500/10 border-b border-rose-500/20 px-3 py-1.5 flex items-center justify-between text-[11px] text-rose-300">
            <div className="flex items-center gap-1.5">
              <AlertCircle size={13} className="text-rose-400 shrink-0" />
              <span className="truncate max-w-[260px]">{errorMessage}</span>
              {micPermission === 'denied' && (
                <button
                  type="button"
                  onClick={startRecording}
                  className="underline font-semibold hover:text-white cursor-pointer flex items-center gap-1"
                >
                  <RefreshCw size={10} /> Tentar
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={clearError}
              className="p-0.5 hover:bg-rose-500/20 rounded transition text-rose-300 hover:text-white cursor-pointer"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {/* Sidenote Tabs (Transcrição • Sessão • Resumo); also the window drag handle,
            released while a modal is open because drag regions swallow clicks under overlays. */}
        {!isCompact && (
          <CompactTabs
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            countMessages={messages.length}
            isListening={isListening}
            isTranscribing={isTranscribing}
            isProcessing={isProcessing}
            elapsedSeconds={elapsedSeconds}
            isDraggable={isWindowDraggable}
          />
        )}

        {!isCompact && activeTab === 'transcription' && <MeetingEventBar google={google} onOpen={() => setIsGoogleOpen(true)} />}

        {/* Core Feed ("Mostra só o que deve mostrar") */}
        {!isCompact && activeTab === 'history' ? (
          <HistoryPanel history={meetingHistory} vaultConnected={!!notesVault.status?.connected} googleConnected={google.connected} />
        ) : !isCompact && activeTab === 'summary' ? (
          <SummaryPanel
            messages={messages}
            summary={summary}
            settings={summarySettings.settings}
            onChangeSettings={summarySettings.update}
            onRequest={requestSummary}
            onExport={exportSummary}
            notice={summaryNotice}
            onClearNotice={clearSummaryNotice}
            vaultConnected={!!notesVault.status?.connected}
            googleConnected={google.connected}
            availability={providerAvailability}
          />
        ) : (
          <CompactTranscriptFeed
            activeTab={isCompact ? 'transcription' : activeTab}
            isCompact={isCompact}
            messages={messages}
            interimTranscript={interimTranscript}
            isListening={isListening}
            isPcCapturing={isPcCapturing}
            isPcSpeaking={isPcSpeaking}
            isTranscribingPc={isTranscribingPc}
            pcLiveTranscripts={pcLiveTranscripts}
            utteranceNotes={utteranceNotes}
            autoRespond={autoRespond}
            isProcessing={isProcessing}
            currentToolCall={currentToolCall}
            frequencyBars={frequencyBars}
            onAbort={abortAgent}
            onTriggerCopilot={triggerCopilot}
            agentSettings={agentSettings}
          />
        )}

        {isCompact ? (
          <CompactModeBar
            menuProps={menuProps}
            agentSettings={agentSettings}
            meterProps={{ audioLevel, isListening, pcAudioLevel, isPcCapturing, isPcSpeaking, onTogglePcCapture: togglePcCapture, pcCaptureApp }}
            onExitCompact={toggleCompact}
            isDraggable={isWindowDraggable}
          />
        ) : (
          <>
            {/* Slim Audio Meters (Você • PC Call • Agente) */}
            <CompactAudioMeters
              audioLevel={audioLevel}
              isListening={isListening}
              isProcessing={isProcessing}
              pcAudioLevel={pcAudioLevel}
              isPcCapturing={isPcCapturing}
              isPcSpeaking={isPcSpeaking}
              onTogglePcCapture={togglePcCapture}
              agentSettings={agentSettings}
              pcSource={pcSource}
              pcCaptureApp={pcCaptureApp}
              onSelectPcSource={selectPcSource}
            />

            {/* Compact Bottom Controls Bar (Context • Keyboard Drawer • Mic) */}
            <CompactBottomBar
              isListening={isListening}
              isProcessing={isProcessing}
              toggleListening={toggleListening}
              onSendMessage={sendMessage}
              agentSettings={agentSettings}
              onOpenContext={() => setIsContextOpen(true)}
              hasContext={!candidateProfile.isEmpty}
              menuProps={menuProps}
            />
          </>
        )}
      </div>

      {/* Model & AI Settings Modal */}
      <ModelSelectorModal
        isOpen={isModelModalOpen}
        onClose={() => setIsModelModalOpen(false)}
        provider={agentSettings.provider}
        setProvider={agentSettings.setProvider}
        models={agentSettings.models}
        setModel={agentSettings.setModel}
        reasoningEfforts={agentSettings.reasoningEfforts}
        setReasoningEffort={agentSettings.setReasoningEffort}
        fastMode={agentSettings.fastMode}
        setFastMode={agentSettings.setFastMode}
        toggleFastMode={agentSettings.toggleFastMode}
        availability={providerAvailability}
        onRefreshAvailability={refreshProviders}
        onOpenKeys={() => setIsKeysOpen(true)}
        onOpenLocal={() => setIsLocalOpen(true)}
      />

      <WelcomeModal
        isOpen={isWelcomeOpen}
        onClose={closeWelcome}
        needs={needs}
        availability={providerAvailability}
        agentSettings={agentSettings}
        speech={speech}
        onRefreshProviders={refreshProviders}
        onOpenKeys={() => setIsKeysOpen(true)}
        onOpenLocal={() => setIsLocalOpen(true)}
      />

      <ApiKeysModal isOpen={isKeysOpen} onClose={() => setIsKeysOpen(false)} availability={providerAvailability} />
      <SpeechEngineModal isOpen={isSpeechOpen} onClose={() => setIsSpeechOpen(false)} speech={speech} />
      <LocalModelsModal isOpen={isLocalOpen} onClose={() => setIsLocalOpen(false)} pushedPulls={localPulls} agentSettings={agentSettings} />
      <GoogleModal isOpen={isGoogleOpen} onClose={() => setIsGoogleOpen(false)} google={google} />

      {isContextOpen && (
        <CandidateContextEditor
          profile={candidateProfile.profile}
          file={candidateProfile.file}
          status={candidateProfile.status}
          loadError={candidateProfile.error}
          onRetry={candidateProfile.reload}
          onSave={candidateProfile.save}
          googleConnected={google.connected}
          onClose={() => setIsContextOpen(false)}
        />
      )}

      <NotesVaultModal isOpen={isNotesOpen} onClose={() => setIsNotesOpen(false)} vault={notesVault} />

      {/* Persona / Interview Type Modal */}
      <PersonaSelectorModal
        isOpen={isPersonaModalOpen}
        onClose={() => setIsPersonaModalOpen(false)}
        selectedPersona={selectedPersona}
        onSelectPersona={changePersona}
      />
    </div>
  );
}
