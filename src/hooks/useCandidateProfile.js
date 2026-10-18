import { useCallback, useEffect, useState } from 'react';
import { EMPTY_PROFILE, isProfileEmpty, normalizeProfile } from '../../shared/candidate-profile.js';
import { apiFetch } from '../backend.js';

const LEGACY_KEY = 'perssua_agent_settings_v1';

// Older versions kept a free-text context in localStorage; it is moved once into the profile file.
function readLegacyContext() {
  try {
    const saved = JSON.parse(localStorage.getItem(LEGACY_KEY) || '{}');
    return typeof saved.candidateContext === 'string' ? saved.candidateContext.trim() : '';
  } catch {
    return '';
  }
}

function forgetLegacyContext() {
  try {
    const { candidateContext, ...rest } = JSON.parse(localStorage.getItem(LEGACY_KEY) || '{}');
    localStorage.setItem(LEGACY_KEY, JSON.stringify(rest));
  } catch {}
}

async function requestProfile(method = 'GET', profile) {
  const response = await apiFetch('/api/profile', {
    method,
    cache: 'no-store',
    headers: profile ? { 'Content-Type': 'application/json' } : undefined,
    body: profile ? JSON.stringify({ profile }) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Não foi possível acessar o perfil.');
  return result;
}

export function useCandidateProfile() {
  const [profile, setProfile] = useState(EMPTY_PROFILE);
  const [file, setFile] = useState('');
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');

  const apply = (result) => {
    setProfile(normalizeProfile(result.profile));
    setFile(result.file || '');
  };

  const load = useCallback(async () => {
    setStatus('loading');
    setError('');
    try {
      let result = await requestProfile();
      const legacy = readLegacyContext();
      if (legacy) {
        if (isProfileEmpty(result.profile)) {
          result = await requestProfile('PUT', { ...result.profile, notes: legacy });
        }
        forgetLegacyContext();
      }
      apply(result);
      setStatus('ready');
      return true;
    } catch (failure) {
      setError(failure.message);
      setStatus('error');
      return false;
    }
  }, []);

  // The backend may still be starting when the window opens, so retry a few times.
  useEffect(() => {
    let cancelled = false;
    let timer;
    const attempt = async (left) => {
      if (cancelled || (await load()) || left <= 0 || cancelled) return;
      timer = setTimeout(() => attempt(left - 1), 1500);
    };
    attempt(5);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [load]);

  const save = useCallback(async (next) => {
    const result = await requestProfile('PUT', next);
    apply(result);
    setStatus('ready');
    return result.profile;
  }, []);

  return { profile, file, status, error, save, reload: load, isEmpty: isProfileEmpty(profile) };
}
