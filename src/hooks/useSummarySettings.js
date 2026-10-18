import { useEffect, useState } from 'react';
import { PROVIDERS } from '../config/models.js';

const STORAGE_KEY = 'interviewai_summary_settings_v1';
// No provider means the summary uses the conversation's model.
const DEFAULTS = { auto: true, provider: null, model: null, saveOnReset: true };

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const provider = PROVIDERS[saved.provider] ? saved.provider : null;
    // Providers whose models come from the account cannot be checked before it answers.
    const knownModel = provider && (PROVIDERS[provider].dynamicModels
      ? typeof saved.model === 'string' && saved.model
      : PROVIDERS[provider].models.some((entry) => entry.id === saved.model));
    const model = knownModel ? saved.model : null;
    return {
      auto: typeof saved.auto === 'boolean' ? saved.auto : DEFAULTS.auto,
      provider,
      model: provider ? model || PROVIDERS[provider].defaultModel : null,
      saveOnReset: typeof saved.saveOnReset === 'boolean' ? saved.saveOnReset : DEFAULTS.saveOnReset,
    };
  } catch {
    return DEFAULTS;
  }
}

export function useSummarySettings() {
  const [settings, setSettings] = useState(load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {}
  }, [settings]);

  const update = (patch) => setSettings((previous) => ({ ...previous, ...patch }));
  return { settings, update };
}
