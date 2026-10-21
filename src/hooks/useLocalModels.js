import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../backend.js';

async function request(path, method = 'GET', body) {
  const response = await apiFetch(`/api/local-ai${path}`, {
    method,
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Não foi possível acessar os modelos locais.');
  return result;
}

/**
 * Hardware, recommended models and the Ollama / LM Studio state, read while the
 * screen is open. Download progress arrives over the socket (`pushedPulls`).
 */
export function useLocalModels({ isOpen, pushedPulls }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async (rescan = false) => {
    try {
      setStatus(await request(rescan ? '?rescan=1' : ''));
      setError('');
    } catch (failure) {
      setError(failure.message);
    }
  }, []);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

  // A download that finished or failed changes the installed list.
  const pulls = pushedPulls ?? status?.pulls ?? {};
  const pullKey = Object.entries(pulls).map(([id, entry]) => `${id}:${entry.status}`).join(',');
  useEffect(() => {
    if (isOpen && pushedPulls) load();
  }, [pullKey]);

  const run = useCallback(async (label, action) => {
    setBusy(label);
    setError('');
    try {
      await action();
      await load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(null);
    }
  }, [load]);

  return {
    status,
    pulls,
    busy,
    error,
    rescan: () => run('rescan', () => load(true)),
    pull: (model) => run(`pull:${model}`, () => request('/models/pull', 'POST', { model })),
    cancel: (model) => run(`cancel:${model}`, () => request('/models/cancel', 'POST', { model })),
    remove: (model) => run(`delete:${model}`, () => request('/models/delete', 'POST', { model })),
    start: (runtime) => run(`start:${runtime}`, () => request(`/${runtime}/start`, 'POST')),
  };
}
