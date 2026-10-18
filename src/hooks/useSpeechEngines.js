import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../backend.js';

async function requestSpeech(path = '', method = 'GET', body) {
  const response = await apiFetch(`/api/speech${path}`, {
    method,
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Não foi possível acessar o reconhecimento de voz.');
  return result;
}

/**
 * The speech recognition engine, what each one still lacks and the model downloads.
 * `pushed` is the status the backend sends over the WebSocket (download progress,
 * a model that finished loading); opening the dialog also checks the Python
 * packages again, since the user may have just installed one.
 */
export function useSpeechEngines({ isOpen, pushed }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (pushed) setStatus(pushed);
  }, [pushed]);

  useEffect(() => {
    if (isOpen) setError('');
    requestSpeech(isOpen ? '?refresh=1' : '').then(setStatus, (failure) => setError(failure.message));
  }, [isOpen]);

  const run = useCallback(async (key, request) => {
    setBusy(key);
    setError('');
    try {
      setStatus(await request());
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(null);
    }
  }, []);

  return {
    status,
    busy,
    error,
    select: (engine, variant) => run(`select:${engine}`, () => requestSpeech('', 'PUT', { engine, variant })),
    install: (engine) => run(`install:${engine}`, () => requestSpeech(`/engines/${encodeURIComponent(engine)}/install`, 'POST')),
    download: (id) => run(`download:${id}`, () => requestSpeech(`/models/${encodeURIComponent(id)}/download`, 'POST')),
    cancel: (id) => run(`cancel:${id}`, () => requestSpeech(`/models/${encodeURIComponent(id)}/download`, 'DELETE')),
    remove: (id) => run(`remove:${id}`, () => requestSpeech(`/models/${encodeURIComponent(id)}`, 'DELETE')),
    refresh: () => run('refresh', () => requestSpeech('?refresh=1')),
  };
}
