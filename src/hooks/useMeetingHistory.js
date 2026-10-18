import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../backend.js';

async function requestHistory(path = '', method = 'GET') {
  const response = await apiFetch(`/api/history${path}`, { method, cache: 'no-store' });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Não foi possível acessar o histórico.');
  return result;
}

/**
 * Saved meetings from the backend, searched as the user types. `version` changes
 * when the backend saves, titles or deletes a meeting, so open views refresh.
 */
export function useMeetingHistory(version) {
  const [query, setQuery] = useState('');
  const [meetings, setMeetings] = useState(null);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      requestHistory(`?q=${encodeURIComponent(query)}`).then(
        (result) => { if (!cancelled) { setMeetings(result.meetings || []); setError(''); } },
        (failure) => { if (!cancelled) setError(failure.message); },
      );
    }, query ? 150 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, version]);

  useEffect(() => {
    if (!selectedId) { setSelected(null); return undefined; }
    let cancelled = false;
    requestHistory(`/${encodeURIComponent(selectedId)}`).then(
      (result) => { if (!cancelled) setSelected(result.meeting); },
      (failure) => {
        if (cancelled) return;
        setError(failure.message);
        setSelectedId(null);
      },
    );
    return () => { cancelled = true; };
  }, [selectedId, version]);

  const remove = useCallback(async (id) => {
    try {
      await requestHistory(`/${encodeURIComponent(id)}`, 'DELETE');
      setSelectedId((current) => (current === id ? null : current));
    } catch (failure) {
      setError(failure.message);
    }
  }, []);

  const summarize = useCallback(async (id) => {
    try {
      await requestHistory(`/${encodeURIComponent(id)}/summarize`, 'POST');
    } catch (failure) {
      setError(failure.message);
    }
  }, []);

  return { query, setQuery, meetings, error, clearError: () => setError(''), selectedId, select: setSelectedId, selected, remove, summarize };
}
