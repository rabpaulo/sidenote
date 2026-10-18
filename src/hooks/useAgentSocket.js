import { useState, useEffect, useRef, useCallback } from 'react';
import { startSystemLoopback } from '../audio/system-loopback.js';
import { apiFetch, backendSocketUrl } from '../backend.js';

const MAX_UTTERANCE_NOTES = 32;

// The agent message of a turn, found by its id; without one, the newest still streaming.
// PC transcripts can land after the reply started, so "the last message" is not it.
function updateAgentMessage(messages, turnId, update) {
  let index = turnId ? messages.findIndex((item) => item.id === `agent-${turnId}`) : -1;
  if (index < 0) index = messages.findLastIndex((item) => item.role === 'agent' && item.status === 'streaming');
  if (index < 0) return messages;
  const next = [...messages];
  next[index] = { ...next[index], ...update(next[index]) };
  return next;
}

/**
 * Hook to manage WebSocket connection with the Backend and Antigravity / Codex Agents.
 * Tracks message turns, streaming token updates, and tool calls.
 */
export function useAgentSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [conversationIds, setConversationIds] = useState({ antigravity: null, codex: null, claude: null });
  const [messages, setMessages] = useState([]);
  // Summary of the session, kept up to date by the backend.
  const [summary, setSummary] = useState(null);
  // Where the last export or finished session was saved, or why it failed.
  const [summaryNotice, setSummaryNotice] = useState(null);
  const summarySettingsRef = useRef(null);
  const [currentThought, setCurrentThought] = useState('');
  const [currentToolCall, setCurrentToolCall] = useState(null);

  // PC Loopback Audio & Copilot States
  const [pcAudioLevel, setPcAudioLevel] = useState(0);
  const [isPcCapturing, setIsPcCapturing] = useState(false);
  // 'renderer' when this window must capture the PC audio itself (Windows) and stream it to the backend.
  const [pcCaptureSource, setPcCaptureSource] = useState(null);
  // The application captured instead of the whole desktop: { id, name, waiting } or null.
  const [pcCaptureApp, setPcCaptureApp] = useState(null);
  // Bumps when the backend saves, titles or deletes a meeting in the history.
  const [historyVersion, setHistoryVersion] = useState(0);
  // Speech recognition engine, packages and model downloads, as the backend pushes them.
  const [speechStatus, setSpeechStatus] = useState(null);
  // A local engine that failed and was replaced by Google: { engine, error, permanent }.
  const [speechFallback, setSpeechFallback] = useState(null);
  const [isPcSpeaking, setIsPcSpeaking] = useState(false);
  const [isTranscribingPc, setIsTranscribingPc] = useState(false);
  const [pcAudioError, setPcAudioError] = useState(null);
  const [pcLiveTranscripts, setPcLiveTranscripts] = useState([]);
  // Notes found for each PC utterance, from its partial transcripts onward.
  const [utteranceNotes, setUtteranceNotes] = useState({});
  const speakingUtteranceRef = useRef(null);
  const pendingUtterancesRef = useRef(new Set());
  const [selectedProvider, setSelectedProvider] = useState('antigravity');
  const [selectedModel, setSelectedModel] = useState('gemini-3.8-flash');
  const [selectedPersona, setSelectedPersona] = useState(() => {
    try {
      return localStorage.getItem('sidenote_persona_v1') || 'general';
    } catch {
      return 'general';
    }
  });
  const [autoRespond, setAutoRespond] = useState(true);
  const [availableModels, setAvailableModels] = useState([]);
  const [availableSinks, setAvailableSinks] = useState([]);
  // Login and account models per provider, checked by the backend.
  const [providerAvailability, setProviderAvailability] = useState({});
  // Why the backend refused to start the selected provider or model.
  const [agentNotice, setAgentNotice] = useState(null);
  const [lastPcTranscript, setLastPcTranscript] = useState('');
  const [pcDetectedLanguage, setPcDetectedLanguage] = useState(null);
  const languageRef = useRef(null);

  const socketRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const activeSettingsRef = useRef({
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    reasoningEffort: 'medium',
    fastMode: true,
  });

  const connect = useCallback(() => {
    const wsUrl = backendSocketUrl();
    // The URL carries the token; logs show only where it connects.
    const shownUrl = wsUrl.replace(/\?.*$/, '');

    console.log('[WS Hook] Connecting to:', shownUrl);
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      console.warn('[WS Hook] Failed to create WebSocket:', e);
      reconnectTimeoutRef.current = setTimeout(connect, 2000);
      return;
    }

    socketRef.current = ws;

    ws.onopen = () => {
      if (socketRef.current !== ws) return;
      console.log('[WS Hook] Connected successfully to', shownUrl);
      setIsConnected(true);
      ws.send(JSON.stringify({ type: 'sync_settings', ...activeSettingsRef.current }));
      if (languageRef.current) ws.send(JSON.stringify({ type: 'set_language', language: languageRef.current }));
      if (summarySettingsRef.current) ws.send(JSON.stringify({ type: 'summary_settings', settings: summarySettingsRef.current }));
      try {
        const savedPersona = localStorage.getItem('sidenote_persona_v1');
        if (savedPersona) {
          ws.send(JSON.stringify({ type: 'set_persona', persona: savedPersona }));
        }
      } catch {}
    };

    ws.onmessage = (event) => {
      if (socketRef.current !== ws) return;
      try {
        const payload = JSON.parse(event.data);
        handleServerEvent(payload);
      } catch (err) {
        console.error('[WS Hook] JSON parse error:', err);
      }
    };

    ws.onclose = () => {
      if (socketRef.current !== ws) return;
      socketRef.current = null;
      console.warn('[WS Hook] Disconnected. Reconnecting in 2s...');
      setIsConnected(false);
      setIsPcCapturing(false);
      setIsPcSpeaking(false);
      setIsTranscribingPc(false);
      setPcLiveTranscripts([]);
      speakingUtteranceRef.current = null;
      pendingUtterancesRef.current.clear();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectTimeoutRef.current = null;
        connect();
      }, 2000);
    };

    ws.onerror = () => {
      if (socketRef.current !== ws) return;
      console.warn('[WS Hook] WebSocket connection failed; retrying after close.');
      try {
        ws.close();
      } catch {}
    };
  }, []);

  const handleServerEvent = useCallback((event) => {
    switch (event.type) {
      case 'connection_ack':
        if (event.conversationIds) setConversationIds(event.conversationIds);
        if (event.conversationId) {
          setConversationIds((prev) => ({ ...prev, antigravity: event.conversationId }));
        }
        if (event.isProcessing !== undefined) setIsProcessing(event.isProcessing);
        if (event.summary) setSummary(event.summary);
        if (event.selectedProvider) setSelectedProvider(event.selectedProvider);
        if (event.selectedModel) setSelectedModel(event.selectedModel);
        if (event.selectedPersona) setSelectedPersona(event.selectedPersona);
        if (event.autoRespond !== undefined) setAutoRespond(event.autoRespond);
        if (event.availableModels) setAvailableModels(event.availableModels);
        if (event.availableSinks) setAvailableSinks(event.availableSinks?.sinks || []);
        if (event.providerAvailability) setProviderAvailability(event.providerAvailability);
        if (event.pcAudioStatus?.isCapturing !== undefined) setIsPcCapturing(event.pcAudioStatus.isCapturing);
        if (event.pcAudioStatus?.source) setPcCaptureSource(event.pcAudioStatus.source);
        setPcCaptureApp(event.pcAudioStatus?.app || null);
        setHistoryVersion((value) => value + 1);
        break;

      case 'history_changed':
        setHistoryVersion((value) => value + 1);
        break;

      case 'speech_status':
        if (event.status) setSpeechStatus(event.status);
        break;

      case 'speech_fallback':
        setSpeechFallback({ engine: event.engine, error: event.error, permanent: !!event.permanent });
        break;

      case 'provider_availability':
        if (event.availability) setProviderAvailability(event.availability);
        break;

      case 'agent_unavailable':
        setAgentNotice(event.error || null);
        break;

      case 'agent_session':
        setAgentNotice(event.status === 'unavailable' ? event.error || null : null);
        if (event.status === 'ready' && event.conversationId && event.provider) {
          setConversationIds((prev) => ({ ...prev, [event.provider]: event.conversationId }));
        }
        break;

      case 'session_reset':
        setPcLiveTranscripts([]);
        setUtteranceNotes({});
        speakingUtteranceRef.current = null;
        pendingUtterancesRef.current.clear();
        setIsPcSpeaking(false);
        setIsTranscribingPc(false);
        setPcAudioError(null);
        setMessages([]);
        setCurrentThought('');
        setCurrentToolCall(null);
        setIsProcessing(false);
        if (event.activeConversationIds) {
          setConversationIds(event.activeConversationIds);
        } else {
          setConversationIds({ antigravity: null, codex: null, claude: null });
        }
        break;

      case 'settings_synced':
        if (event.provider) setSelectedProvider(event.provider);
        if (event.model) setSelectedModel(event.model);
        break;

      case 'pc_audio_level':
        setPcAudioLevel(event.level || 0);
        break;

      case 'pc_capture_status':
        setIsPcCapturing(!!event.isCapturing);
        if (event.source) setPcCaptureSource(event.source);
        setPcCaptureApp(event.isCapturing ? event.app || null : null);
        if (!event.isCapturing) {
          setIsPcSpeaking(false);
          setIsTranscribingPc(false);
          setPcLiveTranscripts([]);
          speakingUtteranceRef.current = null;
          pendingUtterancesRef.current.clear();
        }
        break;

      case 'pc_speech_start':
        speakingUtteranceRef.current = event.utteranceId || 'legacy';
        setIsPcSpeaking(true);
        break;

      case 'pc_speech_end':
        if (speakingUtteranceRef.current === (event.utteranceId || 'legacy')) {
          speakingUtteranceRef.current = null;
          setIsPcSpeaking(false);
        }
        if (event.discarded) setPcLiveTranscripts((prev) => prev.filter((item) => item.utteranceId !== event.utteranceId));
        break;

      case 'pc_speech_partial':
        setPcAudioError(null);
        setPcLiveTranscripts((prev) => {
          const next = prev.filter((item) => item.utteranceId !== event.utteranceId);
          return [...next, { utteranceId: event.utteranceId, text: event.text }];
        });
        break;

      case 'notes_hits':
        setUtteranceNotes((prev) => {
          const id = event.utteranceId || 'legacy';
          const { [id]: _previous, ...rest } = prev;
          const kept = Object.keys(rest).slice(-(MAX_UTTERANCE_NOTES - 1));
          return { ...Object.fromEntries(kept.map((key) => [key, rest[key]])), [id]: event.hits || [] };
        });
        break;

      case 'pc_speech_processing':
        if (speakingUtteranceRef.current === (event.utteranceId || 'legacy')) {
          speakingUtteranceRef.current = null;
          setIsPcSpeaking(false);
        }
        pendingUtterancesRef.current.add(event.utteranceId || 'legacy');
        setIsTranscribingPc(true);
        break;

      case 'pc_speech_transcribed':
        setPcAudioError(null);
        if (speakingUtteranceRef.current === (event.utteranceId || 'legacy')) {
          speakingUtteranceRef.current = null;
          setIsPcSpeaking(false);
        }
        pendingUtterancesRef.current.delete(event.utteranceId || 'legacy');
        setIsTranscribingPc(pendingUtterancesRef.current.size > 0);
        setPcLiveTranscripts((prev) => prev.filter((item) => item.utteranceId !== event.utteranceId));
        setLastPcTranscript(event.text);
        if (event.language) setPcDetectedLanguage(event.language);
        setMessages((prev) => {
          const message = {
            id: `pc-${event.utteranceId || Date.now()}`,
            role: 'interlocutor',
            text: event.text,
            timestamp: event.timestamp || Date.now(),
            durationSec: event.durationSec,
          };
          const replyIndex = prev.findIndex((item) => item.id === `copilot-pc-${event.utteranceId}`);
          if (replyIndex < 0) return [...prev, message];
          return [...prev.slice(0, replyIndex), message, ...prev.slice(replyIndex)];
        });
        break;

      case 'pc_speech_error':
        if (speakingUtteranceRef.current === (event.utteranceId || 'legacy')) {
          speakingUtteranceRef.current = null;
          setIsPcSpeaking(false);
        }
        pendingUtterancesRef.current.delete(event.utteranceId || 'legacy');
        setIsTranscribingPc(pendingUtterancesRef.current.size > 0);
        setPcLiveTranscripts((prev) => prev.filter((item) => item.utteranceId !== event.utteranceId));
        setPcAudioError(event.error || 'Não foi possível transcrever o áudio do PC.');
        break;

      case 'copilot_started':
        setIsProcessing(true);
        setMessages((prev) => {
          const existing = event.replyId ? prev.findIndex((item) => item.id === event.replyId) : -1;
          const message = {
            id: event.replyId || `copilot-${Date.now()}`,
            role: 'copilot',
            text: existing >= 0 ? prev[existing].text : '',
            isUpdating: existing >= 0 && !!prev[existing].text,
            isPreview: !!event.isPreview,
            status: 'streaming',
            provider: event.provider,
            model: event.model,
            persona: event.persona,
            prompt: event.prompt,
            notes: event.notes ?? (existing >= 0 ? prev[existing].notes : undefined),
            timestamp: event.timestamp || Date.now(),
          };
          if (existing < 0) return [...prev, message];
          return prev.map((item, index) => index === existing ? message : item);
        });
        break;

      case 'copilot_token':
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          const next = [...prev];
          const lastIdx = event.replyId ? next.findIndex((item) => item.id === event.replyId) : next.length - 1;
          if (next[lastIdx]?.role === 'copilot') {
            next[lastIdx] = {
              ...next[lastIdx],
              text: event.fullText ?? ((next[lastIdx].text || '') + event.token),
              isUpdating: false,
              isPreview: event.isPreview ?? next[lastIdx].isPreview,
              provider: event.provider || next[lastIdx].provider,
              model: event.model || next[lastIdx].model,
            };
          }
          return next;
        });
        break;

      case 'copilot_completed':
        setIsProcessing(false);
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          const next = [...prev];
          const lastIdx = event.replyId ? next.findIndex((item) => item.id === event.replyId) : next.length - 1;
          if (next[lastIdx]?.role === 'copilot') {
            next[lastIdx] = {
              ...next[lastIdx],
              text: event.response || next[lastIdx].text,
              status: 'done',
              isUpdating: false,
              isPreview: event.isPreview ?? next[lastIdx].isPreview,
              provider: event.provider || next[lastIdx].provider,
              model: event.model || next[lastIdx].model,
              persona: event.persona || next[lastIdx].persona,
            };
          }
          return next;
        });
        break;

      case 'copilot_error':
        setIsProcessing(false);
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          const next = [...prev];
          const lastIdx = event.replyId ? next.findIndex((item) => item.id === event.replyId) : next.length - 1;
          if (next[lastIdx]?.role === 'copilot') {
            next[lastIdx] = {
              ...next[lastIdx],
              text: `Erro no Copiloto: ${event.error}`,
              status: 'error',
              isUpdating: false,
            };
          }
          return next;
        });
        break;

      case 'copilot_finalized':
        setMessages((prev) => prev.map((item) => item.id === event.replyId ? { ...item, isPreview: false } : item));
        break;

      case 'copilot_cancelled':
        setIsProcessing(false);
        // Active cancellation also removes the unfinished snapshot below.
      case 'copilot_discarded':
        setMessages((prev) => prev.filter((item) => item.id !== event.replyId || item.text).map((item) =>
          item.id === event.replyId ? { ...item, status: 'cancelled', isUpdating: false } : item));
        break;

      case 'provider_changed':
        if (event.provider) setSelectedProvider(event.provider);
        break;

      case 'model_changed':
        if (event.model) setSelectedModel(event.model);
        break;

      case 'persona_changed':
        if (event.persona) setSelectedPersona(event.persona);
        break;

      case 'auto_respond_changed':
        setAutoRespond(!!event.autoRespond);
        break;

      case 'summary_update':
        setSummary(event.summary || null);
        break;

      case 'summary_saved':
        setSummaryNotice({ file: event.file, archived: !!event.archived });
        break;

      case 'summary_save_error':
        setSummaryNotice({ error: event.error });
        break;

      case 'user_message_acknowledged':
        setMessages((prev) => [
          ...prev,
          {
            id: `user-${event.turnId || Date.now()}`,
            role: 'user',
            text: event.text,
            images: event.images?.length ? event.images : undefined,
            timestamp: event.timestamp || Date.now(),
            source: event.source || 'voice',
            notes: event.notes,
            provider: event.provider,
            model: event.model,
            reasoningEffort: event.reasoningEffort,
            fastMode: event.fastMode,
          },
          {
            id: `agent-${event.turnId || Date.now()}`,
            role: 'agent',
            text: '',
            status: 'streaming',
            timestamp: Date.now(),
            source: event.source || 'voice',
            notes: event.notes,
            provider: event.provider,
            model: event.model,
            reasoningEffort: event.reasoningEffort,
            fastMode: event.fastMode,
            tools: [],
          },
        ]);
        setIsProcessing(true);
        setCurrentThought('');
        setCurrentToolCall(null);
        break;

      case 'agent_status':
        setIsProcessing(true);
        break;

      case 'agent_stream': {
        const data = event.data;

        // Step updates from stream-json or JSONL
        if (data.event === 'step_update') {
          const step = data.step_update;

          if (step.conversation_id && event.provider) {
            setConversationIds((prev) => ({
              ...prev,
              [event.provider]: step.conversation_id,
            }));
          }

          if (step.text_delta) {
            setMessages((prev) => updateAgentMessage(prev, event.turnId, (message) => ({
              text: (message.text || '') + step.text_delta,
              provider: event.provider || message.provider,
              model: event.model || message.model,
              reasoningEffort: event.reasoningEffort || message.reasoningEffort,
              fastMode: event.fastMode !== undefined ? event.fastMode : message.fastMode,
            })));
          }

          // Tool activity or reasoning
          if (step.step_type && step.step_type !== 'agent_response' && step.step_type !== 'user_input') {
            setCurrentToolCall({
              type: step.step_type,
              state: step.state,
              details: step.tool_call || step.details || null,
            });
          }
        }

        // Final result event
        if (data.event === 'result') {
          const result = data.result;
          setIsProcessing(false);
          setCurrentToolCall(null);
          if (result.conversation_id && event.provider) {
            setConversationIds((prev) => ({
              ...prev,
              [event.provider]: result.conversation_id,
            }));
          }

          setMessages((prev) => updateAgentMessage(prev, event.turnId, (message) => ({
            text: result.response || message.text,
            status: 'done',
            duration: result.duration_seconds,
            usage: result.usage,
            provider: event.provider || message.provider,
            model: event.model || message.model,
            reasoningEffort: event.reasoningEffort || message.reasoningEffort,
            fastMode: event.fastMode !== undefined ? event.fastMode : message.fastMode,
          })));
        }
        break;
      }

      case 'agent_done':
        setIsProcessing(false);
        setCurrentToolCall(null);
        if (event.conversationId && event.provider) {
          setConversationIds((prev) => ({
            ...prev,
            [event.provider]: event.conversationId,
          }));
        }
        setMessages((prev) => updateAgentMessage(prev, event.turnId, (message) => ({
          status: 'done',
          provider: event.provider || message.provider,
          model: event.model || message.model,
        })));
        break;

      case 'agent_error':
        setIsProcessing(false);
        setCurrentToolCall(null);
        setMessages((prev) => updateAgentMessage(prev, event.turnId, (message) => ({
          status: 'error',
          error: event.error,
          text: message.text
            ? message.text + `\n\n*(Erro: ${event.error})*`
            : `Erro na execução: ${event.error}`,
        })));
        break;

      case 'agent_aborted':
        setIsProcessing(false);
        setCurrentToolCall(null);
        setMessages((prev) => updateAgentMessage(prev, event.turnId, (message) => ({
          status: 'aborted',
          text: (message.text || '') + '\n\n*(Interrompido pelo usuário)*',
        })));
        break;

      default:
        break;
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      const activeSocket = socketRef.current;
      socketRef.current = null;
      if (activeSocket) {
        activeSocket.onopen = null;
        activeSocket.onmessage = null;
        activeSocket.onerror = null;
        activeSocket.onclose = null;
        activeSocket.close();
      }
    };
  }, [connect]);

  const sendMessage = useCallback((text, source = 'voice', settings = {}) => {
    const trimmed = text?.trim() || '';
    const images = settings.images || [];
    if (!trimmed && !images.length) return;

    const currentProvider = settings.provider || activeSettingsRef.current.provider || 'antigravity';
    const currentModel = settings.model || activeSettingsRef.current.model;
    const currentReasoning = settings.reasoningEffort || activeSettingsRef.current.reasoningEffort || 'medium';
    const currentFastMode = settings.fastMode !== undefined ? settings.fastMode : activeSettingsRef.current.fastMode;

    const payload = {
      type: 'voice_message',
      text: trimmed,
      source,
      provider: currentProvider,
      model: currentModel,
      reasoningEffort: currentReasoning,
      fastMode: currentFastMode !== false,
      ...(images.length ? { images } : {}),
    };

    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(payload));
    } else {
      console.warn('[WS Hook] WebSocket not open, falling back to HTTP /api/message...');
      setMessages((prev) => [
        ...prev,
        {
          id: `user-${Date.now()}`,
          role: 'user',
          text: trimmed || 'Captura de tela',
          images: images.length ? images.map(({ mimeType, data }) => `data:${mimeType};base64,${data}`) : undefined,
          timestamp: Date.now(),
          source,
          provider: payload.provider,
          model: payload.model,
          reasoningEffort: payload.reasoningEffort,
          fastMode: payload.fastMode,
        },
        {
          id: `agent-${Date.now()}`,
          role: 'agent',
          text: '',
          status: 'streaming',
          timestamp: Date.now(),
          source,
          provider: payload.provider,
          model: payload.model,
          reasoningEffort: payload.reasoningEffort,
          fastMode: payload.fastMode,
          tools: [],
        },
      ]);
      setIsProcessing(true);

      apiFetch('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then((res) => res.json())
        .then((data) => {
          setIsProcessing(false);
          setMessages((prev) => updateAgentMessage(prev, null, () => ({
            text: data.response || 'Comando executado.',
            status: 'done',
            provider: data.provider || payload.provider,
            model: data.model || payload.model,
          })));
        })
        .catch((err) => {
          console.error('[HTTP Fallback Error]:', err);
          setIsProcessing(false);
          setMessages((prev) => updateAgentMessage(prev, null, () => ({
            text: `Erro ao comunicar com o servidor: ${err.message}`,
            status: 'error',
          })));
        });
    }
  }, []);

  const abortAgent = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'abort' }));
    }
  }, []);

  const refreshProviders = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'refresh_providers' }));
    }
  }, []);
  const clearAgentNotice = useCallback(() => setAgentNotice(null), []);

  const resetSession = useCallback((provider = null) => {
    setMessages([]);
    setCurrentThought('');
    setCurrentToolCall(null);
    setIsProcessing(false);
    setConversationIds({ antigravity: null, codex: null, claude: null });

    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'reset_session', provider }));
      return;
    }

    apiFetch('/api/reset-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    }).catch(console.error);
  }, []);

  const syncSettings = useCallback((settings) => {
    activeSettingsRef.current = {
      ...activeSettingsRef.current,
      ...settings,
    };
    if (settings.provider) setSelectedProvider(settings.provider);
    if (settings.model) setSelectedModel(settings.model);

    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type: 'sync_settings',
          provider: settings.provider,
          model: settings.model,
          reasoningEffort: settings.reasoningEffort,
          fastMode: settings.fastMode,
        })
      );
    }
    apiFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }).catch(() => {});
  }, []);

  // On Windows the backend cannot reach the audio device, so the window captures the
  // system loopback and streams PCM over the socket while the backend reports a capture.
  useEffect(() => {
    if (!isConnected || !isPcCapturing || pcCaptureSource !== 'renderer') return undefined;
    let capture = null;
    let cancelled = false;
    startSystemLoopback((buffer) => {
      const ws = socketRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(buffer);
    }).then((started) => {
      if (cancelled) started.stop();
      else capture = started;
    }).catch((error) => {
      if (cancelled) return;
      console.warn('[WS Hook] System loopback capture failed:', error);
      setPcAudioError(`não foi possível capturar o áudio do sistema (${error.message || error.name})`);
      socketRef.current?.send(JSON.stringify({ type: 'stop_pc_capture' }));
    });
    return () => {
      cancelled = true;
      capture?.stop();
    };
  }, [isConnected, isPcCapturing, pcCaptureSource]);

  const startPcCapture = useCallback((options = {}) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'start_pc_capture', options }));
    } else {
      apiFetch('/api/audio-capture/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      }).catch(console.error);
    }
  }, []);

  const stopPcCapture = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'stop_pc_capture' }));
    } else {
      apiFetch('/api/audio-capture/stop', { method: 'POST' }).catch(console.error);
    }
  }, []);

  const changeModel = useCallback((model) => {
    setSelectedModel(model);
    activeSettingsRef.current.model = model;
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'set_model', model }));
    }
  }, []);

  const changePersona = useCallback((persona) => {
    setSelectedPersona(persona);
    try {
      localStorage.setItem('sidenote_persona_v1', persona);
    } catch {}
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'set_persona', persona }));
    }
  }, []);

  const syncLanguage = useCallback((language) => {
    languageRef.current = language;
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'set_language', language }));
    }
  }, []);

  const toggleAutoRespond = useCallback((val) => {
    setAutoRespond(val);
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'set_auto_respond', autoRespond: val }));
    }
  }, []);

  const triggerCopilot = useCallback((text = null, settings = {}) => {
    const currentProvider = settings.provider || activeSettingsRef.current.provider || 'antigravity';
    const currentModel = settings.model || activeSettingsRef.current.model;
    const currentReasoning = settings.reasoningEffort || activeSettingsRef.current.reasoningEffort || 'medium';
    const currentFastMode = settings.fastMode !== undefined ? settings.fastMode : activeSettingsRef.current.fastMode;
    const currentPersona = settings.persona || selectedPersona || 'general';

    const payload = {
      type: 'trigger_copilot',
      text,
      provider: currentProvider,
      model: currentModel,
      persona: currentPersona,
      reasoningEffort: currentReasoning,
      fastMode: currentFastMode,
    };

    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(payload));
    } else {
      apiFetch('/api/copilot/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(console.error);
    }
  }, []);

  const requestSummary = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'summary_request' }));
    }
  }, []);

  const syncSummarySettings = useCallback((settings) => {
    summarySettingsRef.current = settings;
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'summary_settings', settings }));
    }
  }, []);

  // target: 'sessions' (the app's folder) or 'vault' (the connected Obsidian vault).
  const exportSummary = useCallback(async (target) => {
    try {
      const response = await apiFetch('/api/summary/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Não foi possível salvar o resumo.');
      setSummaryNotice({ file: result.file });
    } catch (error) {
      setSummaryNotice({ error: error.message });
    }
  }, []);

  return {
    isConnected,
    isProcessing,
    conversationIds,
    messages,
    summary,
    summaryNotice,
    clearSummaryNotice: () => setSummaryNotice(null),
    requestSummary,
    syncSummarySettings,
    exportSummary,
    currentThought,
    currentToolCall,
    sendMessage,
    abortAgent,
    resetSession,
    clearMessages: resetSession,
    syncSettings,
    syncLanguage,
    providerAvailability,
    refreshProviders,
    agentNotice,
    clearAgentNotice,

    // PC Loopback Audio & Copilot
    pcAudioLevel,
    isPcCapturing,
    pcCaptureApp,
    pcCaptureSource,
    historyVersion,
    speechStatus,
    speechFallback,
    clearSpeechFallback: () => setSpeechFallback(null),
    isPcSpeaking,
    isTranscribingPc,
    pcAudioError,
    pcLiveTranscripts,
    utteranceNotes,
    clearPcAudioError: () => setPcAudioError(null),
    selectedProvider,
    selectedModel,
    selectedPersona,
    autoRespond,
    availableModels,
    availableSinks,
    lastPcTranscript,
    pcDetectedLanguage,
    startPcCapture,
    stopPcCapture,
    changeModel,
    changePersona,
    toggleAutoRespond,
    triggerCopilot,
  };
}
