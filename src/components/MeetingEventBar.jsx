import React, { useState } from 'react';
import { CalendarDays, X, Loader2 } from 'lucide-react';
import { currentEvent } from '../hooks/useGoogle.js';
import { eventTimeLabel } from './GoogleModal.jsx';

/**
 * The calendar event in this meeting's context, or an offer to use the one happening
 * now. Hidden when Google is not connected.
 */
export function MeetingEventBar({ google, onOpen }) {
  const [dismissed, setDismissed] = useState(null);
  if (!google.connected) return null;
  const chosen = google.event;
  const now = !chosen ? currentEvent(google.events) : null;
  if (!chosen && (!now || dismissed === now.id)) return null;
  const event = chosen || now;
  const busy = google.busy === `event:${event.id}` || google.busy === 'event';

  return (
    <div className="flex items-center gap-1.5 border-b border-blue-500/15 bg-blue-500/5 px-3 py-1.5 text-[11px] text-blue-100">
      <CalendarDays size={12} className="shrink-0 text-blue-300" />
      <button type="button" onClick={onOpen} className="min-w-0 truncate text-left hover:underline cursor-pointer" title="Abrir a agenda">
        {chosen ? 'No contexto: ' : 'Agora na agenda: '}
        <b>{event.title}</b> <span className="text-blue-200/60">· {eventTimeLabel(event)}</span>
      </button>
      {!chosen && (
        <button
          type="button"
          onClick={() => google.chooseEvent(event.id)}
          disabled={busy}
          className="ml-auto shrink-0 flex items-center gap-1 px-2 py-0.5 rounded bg-blue-500/20 border border-blue-500/30 hover:bg-blue-500/30 disabled:opacity-50 cursor-pointer"
        >
          {busy && <Loader2 size={10} className="animate-spin" />} Usar como contexto
        </button>
      )}
      <button
        type="button"
        onClick={() => (chosen ? google.clearEvent() : setDismissed(event.id))}
        aria-label={chosen ? 'Tirar o evento do contexto' : 'Dispensar'}
        title={chosen ? 'Tirar o evento do contexto' : 'Dispensar'}
        className={`${chosen ? 'ml-auto' : ''} shrink-0 p-0.5 rounded hover:bg-blue-500/20 cursor-pointer`}
      >
        <X size={11} />
      </button>
    </div>
  );
}
