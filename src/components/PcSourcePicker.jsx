import React from 'react';
import { AppWindow, RefreshCw } from 'lucide-react';

const DESKTOP = '';
// Level from the backend's short sample above which a stream counts as making sound now.
const SOUND_LEVEL = 6;

const keyOf = (entry) => `${entry.id}#${entry.stream}`;

export function streamLabel(entry, position = null) {
  const detail = entry.window && entry.window !== entry.name ? entry.window : entry.media;
  const parts = [`${entry.name}${detail ? ` — ${detail}` : ''}`];
  if (entry.siblings > 1 && position) parts.push(`áudio ${position} de ${entry.siblings}`);
  if (entry.level >= SOUND_LEVEL) parts.push('com som agora');
  else if (!entry.playing) parts.push('pausado');
  return parts.join(' · ');
}

// Position of each stream among the streams of its program, for "áudio 1 de 2".
function positions(streams) {
  const seen = new Map();
  return new Map(streams.map((entry) => {
    const next = (seen.get(entry.id) || 0) + 1;
    seen.set(entry.id, next);
    return [keyOf(entry), next];
  }));
}

export function toSelection(entry) {
  return { id: entry.id, name: entry.name, stream: entry.stream, media: entry.media };
}

/**
 * Chooses what "PC CALL" listens to: the whole desktop or one application stream.
 * A browser plays every tab under the same program, so its streams are listed one
 * by one, with which of them is making sound right now.
 */
export function PcSourcePicker({ source, captureApp, isPcCapturing, onSelect }) {
  if (!source?.supported) return null;
  const { app, streams, loading, error, refresh } = source;
  const order = positions(streams);
  const selected = app && (streams.find((entry) => entry.id === app.id && entry.stream === app.stream)
    || (app.stream === null && streams.find((entry) => entry.id === app.id)));
  const missing = app && !selected;
  const value = !app ? DESKTOP : selected ? keyOf(selected) : 'missing';
  const siblings = app ? streams.filter((entry) => entry.id === app.id).length : 0;

  const choose = (next) => {
    if (next === 'missing') return;
    const picked = streams.find((entry) => keyOf(entry) === next);
    onSelect(picked ? toSelection(picked) : null);
  };

  return (
    <div className="pl-16 space-y-1 text-[10px]">
      <div className="flex items-center gap-1.5">
        <AppWindow size={11} className={app ? 'text-blue-300' : 'text-zinc-600'} />
        <select
          value={value}
          onChange={(event) => choose(event.target.value)}
          onFocus={refresh}
          aria-label="Fonte do áudio do PC"
          title="Ouvir o desktop inteiro ou só o áudio da reunião"
          className="flex-1 min-w-0 rounded bg-zinc-900 border border-white/10 px-1.5 py-0.5 text-[10px] text-zinc-200 cursor-pointer"
        >
          <option value={DESKTOP}>Desktop inteiro</option>
          {missing && <option value="missing">{app.name} (sem áudio agora)</option>}
          {streams.map((entry) => (
            <option key={keyOf(entry)} value={keyOf(entry)}>{streamLabel(entry, order.get(keyOf(entry)))}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          aria-label="Atualizar lista de aplicativos"
          title="Atualizar lista e medir o som de cada um"
          className="p-0.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-white/10 cursor-pointer disabled:opacity-40"
        >
          <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      {isPcCapturing && captureApp?.ambiguous ? (
        <p className="text-amber-300/90">Não dá para saber qual dos {captureApp.streams} áudios de {captureApp.name} é o da chamada. Escolha qual ouvir.</p>
      ) : isPcCapturing && captureApp?.waiting ? (
        <p className="text-amber-300/90">Aguardando {captureApp.name} tocar áudio…</p>
      ) : siblings > 1 ? (
        <p className="text-amber-300/90">
          {app.name} está tocando {siblings} áudios (abas ou janelas). Confira se o escolhido é o da chamada: ele aparece “com som agora” enquanto alguém fala.
        </p>
      ) : null}
      {!streams.length && !app && !error && <p className="text-zinc-500">Abra a chamada para escolher o áudio dela.</p>}
      {error && <p className="text-rose-300">{error}</p>}
    </div>
  );
}
