import { useState, useEffect, useMemo } from 'react';
import { PROVIDERS } from '../config/models.js';

const STORAGE_KEY = 'perssua_agent_settings_v1';
const byProvider = (value) => Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, value(id)]));

export function useAgentSettings() {
  const [provider, setProviderState] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (PROVIDERS[parsed.provider]) return parsed.provider;
      }
    } catch {}
    return 'antigravity';
  });

  const [models, setModelsState] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        return byProvider((id) => parsed.models?.[id] || PROVIDERS[id].defaultModel);
      }
    } catch {}
    return byProvider((id) => PROVIDERS[id].defaultModel);
  });

  const [reasoningEfforts, setReasoningEffortsState] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        return byProvider((id) => parsed.reasoningEfforts?.[id] || PROVIDERS[id].defaultReasoning);
      }
    } catch {}
    return byProvider((id) => PROVIDERS[id].defaultReasoning);
  });

  const [fastMode, setFastModeState] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.fastMode === 'boolean') return parsed.fastMode;
      }
    } catch {}
    return true;
  });

  // Persist to localStorage
  useEffect(() => {
    try {
      // Keeps keys this hook doesn't own (e.g. a legacy context awaiting migration).
      const previous = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          ...previous,
          provider,
          models,
          reasoningEfforts,
          fastMode,
        })
      );
    } catch (e) {
      console.warn('Failed to save agent settings:', e);
    }
  }, [provider, models, reasoningEfforts, fastMode]);

  const setProvider = (newProvider) => {
    if (PROVIDERS[newProvider]) {
      setProviderState(newProvider);
    }
  };

  const setModel = (modelId, targetProvider = provider) => {
    setModelsState((prev) => ({
      ...prev,
      [targetProvider]: modelId,
    }));
  };

  const setReasoningEffort = (effort, targetProvider = provider) => {
    setReasoningEffortsState((prev) => ({
      ...prev,
      [targetProvider]: effort,
    }));
  };

  const toggleFastMode = () => {
    setFastModeState((prev) => !prev);
  };

  const setFastMode = (val) => {
    setFastModeState(Boolean(val));
  };

  const currentProviderConfig = PROVIDERS[provider];
  const currentModelId = models[provider] || currentProviderConfig.defaultModel;
  // Providers whose models come from the account have no fixed entry: the id is the name.
  const currentModel = useMemo(() => {
    return (
      currentProviderConfig.models.find((m) => m.id === currentModelId) ||
      (currentModelId ? { id: currentModelId, name: currentModelId } : currentProviderConfig.models[0])
    );
  }, [currentProviderConfig, currentModelId]);

  const savedReasoning = reasoningEfforts[provider];
  const currentReasoning = currentProviderConfig.reasoningLevels.some((level) => level.id === savedReasoning)
    ? savedReasoning
    : currentProviderConfig.defaultReasoning;

  return {
    provider,
    setProvider,
    models,
    setModel,
    reasoningEfforts,
    setReasoningEffort,
    fastMode,
    setFastMode,
    toggleFastMode,
    currentProviderConfig,
    currentModelId,
    currentModel,
    currentReasoning,
  };
}
