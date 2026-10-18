import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../backend.js';

async function requestNotes(path = '', method = 'GET', body) {
  const response = await apiFetch(`/api/notes${path}`, {
    method,
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || 'Não foi possível acessar as notas.'), { status: result.status });
  return result;
}

// Obsidian vault connection, indexed and searched by the backend.
export function useNotesVault() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = useCallback(async (request) => {
    setBusy(true);
    setError('');
    try {
      const result = await request();
      setStatus(result.status);
      return true;
    } catch (failure) {
      if (failure.status) setStatus(failure.status);
      setError(failure.message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  // The backend may still be starting when the window opens.
  useEffect(() => {
    let cancelled = false;
    let timer;
    const attempt = (left) => requestNotes().then((result) => { if (!cancelled) setStatus(result.status); }, () => {
      if (!cancelled && left > 0) timer = setTimeout(() => attempt(left - 1), 1500);
    });
    attempt(5);
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  const connect = useCallback((path) => run(() => requestNotes('', 'PUT', { path })), [run]);
  const reindex = useCallback(() => run(() => requestNotes('/reindex', 'POST')), [run]);
  const disconnect = useCallback(() => run(() => requestNotes('', 'DELETE')), [run]);
  const search = useCallback((query) => requestNotes(`/search?q=${encodeURIComponent(query)}`), []);

  return { status, busy, error, connect, reindex, disconnect, search };
}
