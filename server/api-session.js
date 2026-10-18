import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { API_PROVIDERS } from '../shared/api-providers.js';
import { imageDataUrl, normalizeImages } from './agent-images.js';
import { AGENT_SYSTEM_PROMPT } from './agent-prompt.js';
import { providerKeys } from './provider-keys.js';
import { readSse } from './sse.js';

// Providers called over HTTP with the user's API key. There is no process to warm
// up: each conversation keeps its history here and every turn streams one request.
// Images are sent only with the turn they belong to; the history keeps the text.
const MAX_HISTORY_MESSAGES = 40;
const MAX_OUTPUT_TOKENS = 16000;
// Server-side refusal fallback is opt-in and only these models accept it.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

const conversations = new Map();

export class ApiKeyError extends Error {}

/** Forgets every conversation, as a new session does with the CLIs. */
export function resetApiConversations() { conversations.clear(); }

function apiKey(provider) {
  const key = providerKeys.get(provider);
  if (!key) throw new ApiKeyError(`Adicione uma API key de ${API_PROVIDERS[provider]?.shortName || provider} para usar este provedor.`);
  return key;
}

function conversation(conversationId, isolated) {
  if (isolated) return { id: conversationId || randomUUID(), messages: [] };
  const id = conversationId || randomUUID();
  if (!conversations.has(id)) conversations.set(id, { id, messages: [] });
  return conversations.get(id);
}

export function prepareApiSession({ provider, conversationId } = {}) {
  try {
    apiKey(provider);
    return Promise.resolve({ conversationId: conversation(conversationId).id });
  } catch (error) {
    return Promise.reject(error);
  }
}

const usesEffort = (effort) => effort && effort !== 'default';

async function httpError(response, provider) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || body?.message || body?.error || '';
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {}
  const name = API_PROVIDERS[provider].shortName;
  if (response.status === 401 || response.status === 403) {
    return new ApiKeyError(`${name}: API key inválida ou sem permissão${detail ? ` (${detail})` : ''}.`);
  }
  return new Error(`${name}: erro ${response.status}${detail ? ` — ${detail}` : ''}`);
}

async function streamOpenAi({ provider, model, reasoningEffort, messages, images, prompt, signal, onText }) {
  const config = API_PROVIDERS[provider];
  const attached = normalizeImages(images);
  const content = attached.length
    ? [...attached.map((image) => ({ type: 'image_url', image_url: { url: imageDataUrl(image) } })), { type: 'text', text: prompt }]
    : prompt;
  const body = {
    model,
    stream: true,
    messages: [{ role: 'system', content: AGENT_SYSTEM_PROMPT }, ...messages, { role: 'user', content }],
  };
  if (config.streamUsage !== false) body.stream_options = { include_usage: true };
  if (usesEffort(reasoningEffort)) {
    if (config.reasoning === 'reasoning_effort') body.reasoning_effort = reasoningEffort;
    if (config.reasoning === 'openrouter') body.reasoning = { effort: reasoningEffort };
  }
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey(provider)}`,
      ...(provider === 'openrouter' ? { 'X-Title': 'InterviewAI' } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await httpError(response, provider);
  let text = '';
  let usage = null;
  for await (const event of readSse(response.body)) {
    if (event.error) throw new Error(`${config.shortName}: ${event.error.message || JSON.stringify(event.error)}`);
    const delta = event.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta) {
      text += delta;
      onText(delta);
    }
    if (event.usage) usage = event.usage;
  }
  return {
    text,
    usage: usage && {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      cached_input_tokens: usage.prompt_tokens_details?.cached_tokens,
      total_tokens: usage.total_tokens,
    },
  };
}

async function streamAnthropic({ model, reasoningEffort, messages, images, prompt, signal, onText }) {
  const client = new Anthropic({ apiKey: apiKey('anthropic') });
  const attached = normalizeImages(images);
  const content = attached.length
    ? [...attached.map(({ mimeType, data }) => ({ type: 'image', source: { type: 'base64', media_type: mimeType, data } })),
      { type: 'text', text: prompt }]
    : prompt;
  const params = {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: AGENT_SYSTEM_PROMPT,
    messages: [...messages, { role: 'user', content }],
  };
  if (usesEffort(reasoningEffort)) params.output_config = { effort: reasoningEffort };
  const stream = FALLBACK_MODELS.has(model)
    ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
    : client.messages.stream(params, { signal });
  let text = '';
  stream.on('text', (delta) => {
    text += delta;
    onText(delta);
  });
  let message;
  try {
    message = await stream.finalMessage();
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      throw new ApiKeyError(`Anthropic: API key inválida ou sem permissão (${error.message}).`);
    }
    throw error;
  }
  if (message.stop_reason === 'refusal') {
    throw new Error(`Anthropic: o modelo recusou a resposta${message.stop_details?.explanation ? ` (${message.stop_details.explanation})` : ''}.`);
  }
  const usage = message.usage;
  return {
    text,
    usage: usage && {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cached_input_tokens: usage.cache_read_input_tokens,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    },
  };
}

export function runApiAgent({ provider, model, reasoningEffort, prompt, images, conversationId, isolated = false, onMessage, onError, onClose }) {
  const controller = new AbortController();
  const chat = conversation(conversationId, isolated);
  const turn = { done: false, startedAt: Date.now() };
  const finish = (callback) => {
    if (turn.done) return;
    turn.done = true;
    callback();
  };
  queueMicrotask(async () => {
    try {
      if (!API_PROVIDERS[provider]) throw new Error(`Provedor desconhecido: ${provider}`);
      if (!model) throw new Error('Escolha um modelo para este provedor.');
      onMessage?.({ event: 'session_started', conversation_id: chat.id });
      const stream = API_PROVIDERS[provider].protocol === 'anthropic' ? streamAnthropic : streamOpenAi;
      const { text, usage } = await stream({
        provider, model, reasoningEffort, prompt, images, messages: chat.messages, signal: controller.signal,
        onText: (delta) => {
          if (!turn.done) onMessage?.({ event: 'step_update', step_update: { conversation_id: chat.id, text_delta: delta } });
        },
      });
      if (turn.done) return;
      if (!isolated) {
        chat.messages.push({ role: 'user', content: prompt }, { role: 'assistant', content: text });
        if (chat.messages.length > MAX_HISTORY_MESSAGES) chat.messages.splice(0, chat.messages.length - MAX_HISTORY_MESSAGES);
      }
      onMessage?.({ event: 'result', result: { conversation_id: chat.id, response: text,
        duration_seconds: (Date.now() - turn.startedAt) / 1000, usage } });
      finish(() => onClose?.(0));
    } catch (error) {
      if (controller.signal.aborted) return;
      finish(() => onError?.(error));
    }
  });
  return {
    kill() {
      if (turn.done) return;
      turn.done = true;
      controller.abort();
    },
  };
}

/**
 * Whether the key works and which chat models it offers, without spending tokens:
 * 401/403 is a definite "no", anything else unexpected leaves the provider usable.
 */
export async function listApiModels(provider, { timeoutMs = 15000 } = {}) {
  const config = API_PROVIDERS[provider];
  const key = providerKeys.get(provider);
  if (!key) return { status: 'unavailable', reason: `Adicione uma API key de ${config.shortName} para usar este provedor.`, needsKey: true };
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    let models;
    if (config.protocol === 'anthropic') {
      const client = new Anthropic({ apiKey: key, maxRetries: 1 });
      models = [];
      for await (const model of client.models.list({ limit: 100 }, { signal })) {
        models.push({ id: model.id, name: model.display_name || model.id });
      }
    } else {
      const headers = { Authorization: `Bearer ${key}` };
      if (config.keyCheckPath) {
        const check = await fetch(`${config.baseUrl}${config.keyCheckPath}`, { headers, signal });
        if (!check.ok) throw await httpError(check, provider);
      }
      const response = await fetch(`${config.baseUrl}/models`, { headers, signal });
      if (!response.ok) throw await httpError(response, provider);
      const body = await response.json();
      const listed = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
      models = listed
        .map((model) => ({ ...model, id: String(model.id || model.name || '').replace(/^models\//, '') }))
        .filter((model) => model.id)
        // OpenAI lists in no particular order; newest first is the useful one.
        .sort((a, b) => (b.created || 0) - (a.created || 0))
        .map((model) => ({ id: model.id, name: model.display_name || (model.name && model.name !== model.id ? model.name : model.id) }));
    }
    return { models };
  } catch (error) {
    if (error instanceof ApiKeyError || error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      return { status: 'unavailable', reason: error instanceof ApiKeyError ? error.message : `${config.shortName}: API key inválida.`, needsKey: true };
    }
    const reason = error.name === 'TimeoutError' ? 'não respondeu a tempo' : error.message;
    return { status: 'unknown', reason: `Não foi possível verificar a API key de ${config.shortName}: ${reason}.` };
  }
}
