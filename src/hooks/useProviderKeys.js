import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../backend.js';

async function requestKeys(path = '', method = 'GET', body) {
  const response = await apiFetch(`/api/provider-keys${path}`, {
    method,
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Não foi possível acessar as chaves de API.');
  return result;
}

// API keys are kept by the backend; the client only learns whether each one exists.
export function useProviderKeys(isOpen) {
  const [keys, setKeys] = useState({});
  const [file, setFile] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  const apply = (result) => {
    setKeys(result.keys || {});
    setFile(result.file || '');
  };

  useEffect(() => {
    if (!isOpen) return;
    setError('');
    requestKeys().then(apply, (failure) => setError(failure.message));
  }, [isOpen]);

  const run = useCallback(async (provider, request) => {
    setBusy(provider);
    setError('');
    try {
      apply(await request());
      return true;
    } catch (failure) {
      setError(failure.message);
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  const save = useCallback((provider, key) => run(provider, () => requestKeys(`/${provider}`, 'PUT', { key })), [run]);
  const remove = useCallback((provider) => run(provider, () => requestKeys(`/${provider}`, 'DELETE')), [run]);

  return { keys, file, busy, error, save, remove };
}
