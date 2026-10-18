import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../backend.js';

const STORAGE_KEY = 'interviewai_pc_app_v1';

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved?.id) return null;
    return {
      id: String(saved.id),
      name: String(saved.name || saved.id),
      stream: Number.isInteger(saved.stream) ? saved.stream : null,
      media: typeof saved.media === 'string' ? saved.media : null,
    };
  } catch {
    return null;
  }
}

/**
 * What the PC capture listens to: the whole desktop (null) or one application
 * stream ({ id, name, stream, media }), remembered between launches. `streams`
 * lists what is playing now; the backend only supports this on Linux.
 */
export function usePcAudioSource() {
  const [app, setApp] = useState(load);
  const [streams, setStreams] = useState([]);
  const [supported, setSupported] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(app));
    } catch {}
  }, [app]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiFetch('/api/audio-apps', { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setSupported(!!result.supported);
      setStreams(result.streams || []);
      setError(result.error || '');
    } catch {
      setError('Não foi possível listar os aplicativos com áudio.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Options for start_pc_capture.
  const captureOptions = useCallback(() => (app ? { app } : {}), [app]);

  return { app, setApp, streams, supported, loading, error, refresh, captureOptions };
}
