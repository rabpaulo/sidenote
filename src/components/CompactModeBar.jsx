import React from 'react';
import { Maximize2 } from 'lucide-react';
import { AppMenu } from './AppMenu.jsx';
import { InlineAudioMeters } from './CompactAudioMeters.jsx';

// Compact mode controls: settings menu, audio meters and the way back. It is
// also the window drag handle, since the tab strip is hidden in this mode.
export function CompactModeBar({ menuProps, agentSettings, meterProps, onExitCompact, isDraggable = true }) {
  return (
    <div className={`app-bottom-bar ${isDraggable ? 'app-drag-region' : ''} flex items-center gap-2 px-2.5 py-1.5`}>
      <div className="app-no-drag">
        <AppMenu {...menuProps} agentSettings={agentSettings} />
      </div>
      <InlineAudioMeters {...meterProps} />
      <button
        type="button"
        onClick={onExitCompact}
        aria-label="Desativar modo compacto"
        title="Desativar modo compacto"
        className="app-no-drag app-quiet-button p-2 rounded-xl transition cursor-pointer text-zinc-400"
      >
        <Maximize2 size={15} />
      </button>
    </div>
  );
}
