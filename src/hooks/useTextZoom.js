import { useState, useEffect } from 'react';

const STORAGE_KEY = 'interviewai_text_zoom_v1';
export const MIN_TEXT_ZOOM = 0.7;
export const MAX_TEXT_ZOOM = 2;
const STEP = 0.1;

const clampZoom = (value) => Math.min(MAX_TEXT_ZOOM, Math.max(MIN_TEXT_ZOOM, Math.round((Number(value) || 1) * 10) / 10));

/** Ctrl/Cmd with =/+ zooms in, -/_ zooms out and 0 resets; also matches the numpad keys. */
export function textZoomAction({ key, code, ctrlKey, metaKey, altKey }) {
  if (!(ctrlKey || metaKey) || altKey) return null;
  if (key === '=' || key === '+' || code === 'NumpadAdd') return 'in';
  if (key === '-' || key === '_' || code === 'NumpadSubtract') return 'out';
  if (key === '0' || code === 'Numpad0') return 'reset';
  return null;
}

export function nextTextZoom(zoom, action) {
  if (action === 'reset') return 1;
  return clampZoom(zoom + (action === 'in' ? STEP : -STEP));
}

const readZoom = () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved !== null ? clampZoom(saved) : 1;
  } catch {
    return 1;
  }
};

// Scales only the reading feed (see .app-transcript-feed in index.css), and only
// while the window has focus: the keys arrive as page key events, never as global shortcuts.
export function useTextZoom() {
  const [zoom, setZoom] = useState(readZoom);

  useEffect(() => {
    document.documentElement.style.setProperty('--text-zoom', String(zoom));
    try {
      localStorage.setItem(STORAGE_KEY, String(zoom));
    } catch {}
  }, [zoom]);

  useEffect(() => {
    const apply = (action) => action && setZoom((current) => nextTextZoom(current, action));
    const handleKeyDown = (event) => {
      const action = textZoomAction(event);
      if (!action) return;
      event.preventDefault();
      apply(action);
    };
    window.addEventListener('keydown', handleKeyDown);
    // Electron intercepts these keys before the page to disable its whole-page zoom and forwards them here.
    const cleanup = window.interviewaiDesktop?.onShortcut?.((action) => apply(action.match(/^text_zoom_(in|out|reset)$/)?.[1]));
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      cleanup?.();
    };
  }, []);

  return zoom;
}
