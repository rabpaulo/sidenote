import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../backend.js';

const EVENTS_REFRESH_MS = 5 * 60 * 1000;

async function request(path = '', method = 'GET', body) {
  const response = await apiFetch(`/api/google${path}`, {
    method,
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Não foi possível acessar o Google.');
  return result;
}

/**
 * Google account state, the next calendar events and the event chosen for this
 * meeting. The backend pushes status and event changes over the socket; the events
 * are read again every few minutes while connected.
 */
export function useGoogle({ pushedStatus, pushedEvent }) {
  const [status, setStatus] = useState(null);
  const [file, setFile] = useState('');
  const [events, setEvents] = useState(null);
  const [event, setEvent] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => request().then((result) => {
    setStatus(result.status);
    setFile(result.file || '');
    setEvent(result.event || null);
    setError('');
  }, (failure) => setError(failure.message)), []);
  useEffect(() => { load(); }, [load]);
  // The socket's status means the backend is reachable: a failed first read is retried.
  useEffect(() => {
    if (!pushedStatus) return;
    setStatus(pushedStatus);
    if (!file) load();
  }, [pushedStatus]);
  useEffect(() => { if (pushedEvent !== undefined) setEvent(pushedEvent); }, [pushedEvent]);

  const connected = Boolean(status?.connected);
  const loadEvents = useCallback(async () => {
    try {
      setEvents((await request('/events')).events || []);
    } catch (failure) {
      setError(failure.message);
    }
  }, []);

  useEffect(() => {
    if (!connected) { setEvents(null); return undefined; }
    loadEvents();
    const timer = setInterval(loadEvents, EVENTS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [connected, loadEvents]);

  const run = useCallback(async (label, action) => {
    setBusy(label);
    setError('');
    try {
      return await action();
    } catch (failure) {
      setError(failure.message);
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  const apply = (result) => {
    if (result?.status) setStatus(result.status);
    return result;
  };

  return {
    status, file, events, event, busy, error, clearError: () => setError(''),
    connected,
    refreshEvents: () => run('events', loadEvents),
    saveClient: (clientId, clientSecret) => run('client', async () => apply(await request('/client', 'PUT', { clientId, clientSecret }))),
    removeClient: () => run('client', async () => apply(await request('/client', 'DELETE'))),
    // The sign-in page opens in the browser (Electron sends window.open there).
    connect: () => run('connect', async () => {
      const result = apply(await request('/connect', 'POST'));
      if (result?.authUrl) window.open(result.authUrl, '_blank', 'noopener');
      return result;
    }),
    cancelConnect: () => run('connect', async () => apply(await request('/connect/cancel', 'POST'))),
    disconnect: () => run('disconnect', async () => apply(await request('', 'DELETE'))),
    chooseEvent: (id) => run(`event:${id}`, async () => {
      const result = await request('/meeting-event', 'PUT', { id });
      setEvent(result.event);
      return result;
    }),
    clearEvent: () => run('event', async () => {
      await request('/meeting-event', 'DELETE');
      setEvent(null);
    }),
  };
}

/** The event happening now (or starting within 10 minutes), if any. */
export function currentEvent(events, now = Date.now()) {
  return (events || []).find((event) => !event.allDay && event.start && event.end
    && event.start - 10 * 60 * 1000 <= now && now < event.end) || null;
}
