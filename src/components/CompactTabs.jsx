import React from 'react';
import { Mic, MessageSquare, FileText, History } from 'lucide-react';

const formatTimer = (totalSec) => {
  const mins = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const secs = (totalSec % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
};

export function CompactTabs({
  activeTab,
  setActiveTab,
  countMessages = 0,
  isListening,
  isTranscribing,
  isProcessing,
  elapsedSeconds = 0,
  isDraggable = true,
}) {
  const isBusy = isListening || isTranscribing || isProcessing;
  const statusLabel = isListening ? 'Ouvindo' : isTranscribing ? 'Transcrevendo' : isProcessing ? 'Gerando' : 'Pronto';

  const tabs = [
    { id: 'transcription', label: 'Transcrição', icon: Mic },
    { id: 'session', label: 'Sessão', icon: MessageSquare, badge: countMessages > 0 ? countMessages : null },
    { id: 'summary', label: 'Resumo', icon: FileText },
    // Icon only until opened, so four tabs and the timer fit the narrow window.
    { id: 'history', label: 'Histórico', icon: History, compact: true },
  ];

  return (
    <div className={`app-tabs ${isDraggable ? 'app-drag-region' : ''} flex items-center justify-between px-4 py-2 select-none`}>
      <div className="flex items-center gap-1 app-no-drag">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              title={tab.label}
              aria-label={tab.label}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition cursor-pointer ${
                isActive
                  ? 'app-tab-active text-white font-semibold'
                  : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04]'
              }`}
            >
              <Icon size={12} className={isActive ? 'text-blue-300' : 'text-zinc-500'} />
              {(!tab.compact || isActive) && <span>{tab.label}</span>}
              {tab.badge && (
                <span
                  className={`text-[9px] px-1 py-0.2 rounded-full font-mono ${
                    isActive ? 'bg-blue-500/15 text-blue-200' : 'bg-white/10 text-zinc-400'
                  }`}
                >
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Live status & timer (the tab strip doubles as the window drag handle) */}
      <div className="flex items-center gap-1.5 pr-1 text-[10px]" title={statusLabel}>
        <span className="relative flex h-1.5 w-1.5">
          {isBusy && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-40" />}
          <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${isBusy ? 'bg-blue-400' : 'bg-zinc-600'}`} />
        </span>
        <span className="font-mono tabular-nums text-zinc-400">{formatTimer(elapsedSeconds)}</span>
      </div>
    </div>
  );
}
