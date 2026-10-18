// Providers reached directly over HTTP with the user's own API key. The server
// streams from them (server/api-session.js) and lists the account's models with the
// same key, so the model lists come from the provider instead of being hard-coded.
// `env` is read when no key was saved in the app; `opencodeEnv` hands the key to
// OpenCode, which then offers that provider's models too.

const EFFORT_LEVELS = [
  { id: 'default', label: 'Padrão', hint: 'Padrão do modelo' },
  { id: 'low', label: 'Low', hint: 'Rápido, respostas diretas' },
  { id: 'medium', label: 'Médio', hint: 'Equilíbrio recomendado' },
  { id: 'high', label: 'High', hint: 'Raciocínio aprofundado' },
];

export const API_PROVIDERS = {
  openai: {
    id: 'openai',
    name: 'OpenAI API',
    shortName: 'OpenAI',
    tagline: 'Modelos GPT com a sua API key',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    env: ['OPENAI_API_KEY'],
    opencodeEnv: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPrefix: 'sk-',
    reasoning: 'reasoning_effort',
    preferredModels: ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5-mini', 'gpt-4.1-mini'],
    // The account lists embeddings, audio and image models too; only chat models answer.
    modelFilter: /^(gpt|o\d|chatgpt)/,
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic API',
    shortName: 'Anthropic',
    tagline: 'Claude com a sua API key',
    protocol: 'anthropic',
    env: ['ANTHROPIC_API_KEY'],
    opencodeEnv: 'ANTHROPIC_API_KEY',
    keyUrl: 'https://platform.claude.com/settings/keys',
    keyPrefix: 'sk-ant-',
    reasoning: 'effort',
    preferredModels: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini API',
    shortName: 'Gemini',
    tagline: 'Google AI Studio com a sua API key',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    env: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    opencodeEnv: 'GOOGLE_GENERATIVE_AI_API_KEY',
    keyUrl: 'https://aistudio.google.com/apikey',
    reasoning: 'reasoning_effort',
    preferredModels: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.1-pro', 'gemini-2.5-flash'],
    modelFilter: /^gemini/,
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    shortName: 'OpenRouter',
    tagline: 'Centenas de modelos com uma única key',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    env: ['OPENROUTER_API_KEY'],
    opencodeEnv: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/settings/keys',
    keyPrefix: 'sk-or-',
    reasoning: 'openrouter',
    preferredModels: [],
    // The model list is public, so only an authenticated request proves the key works.
    keyCheckPath: '/key',
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    shortName: 'Groq',
    tagline: 'Inferência de baixíssima latência',
    protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    env: ['GROQ_API_KEY'],
    opencodeEnv: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys',
    keyPrefix: 'gsk_',
    preferredModels: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    shortName: 'DeepSeek',
    tagline: 'DeepSeek com a sua API key',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    env: ['DEEPSEEK_API_KEY'],
    opencodeEnv: 'DEEPSEEK_API_KEY',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyPrefix: 'sk-',
    preferredModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral',
    shortName: 'Mistral',
    tagline: 'Mistral AI com a sua API key',
    protocol: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    env: ['MISTRAL_API_KEY'],
    opencodeEnv: 'MISTRAL_API_KEY',
    keyUrl: 'https://console.mistral.ai/api-keys',
    // Mistral sends usage in the last chunk on its own and rejects stream_options.
    streamUsage: false,
    preferredModels: ['mistral-medium-latest', 'mistral-large-latest', 'mistral-small-latest'],
    modelFilter: /^(?!.*(embed|ocr|moderation))/,
  },
  xai: {
    id: 'xai',
    name: 'xAI Grok',
    shortName: 'Grok',
    tagline: 'Grok com a sua API key',
    protocol: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    env: ['XAI_API_KEY'],
    opencodeEnv: 'XAI_API_KEY',
    keyUrl: 'https://console.x.ai',
    keyPrefix: 'xai-',
    preferredModels: ['grok-4-fast', 'grok-4', 'grok-3-mini'],
    modelFilter: /^grok/,
  },
};

export const API_PROVIDER_IDS = Object.keys(API_PROVIDERS);

export const isApiProvider = (id) => Object.hasOwn(API_PROVIDERS, id);

// Never chat models, whatever the provider calls them.
const NON_CHAT = /embed|tts|whisper|audio|realtime|transcribe|dall-e|image|moderation|rerank|search|guard|computer-use|codex/i;

/** The provider's chat models, preferred ones first, then in the order the API listed them. */
export function chatModels(provider, models) {
  const config = API_PROVIDERS[provider];
  const usable = models.filter(({ id }) => !NON_CHAT.test(id) && (!config?.modelFilter || config.modelFilter.test(id)));
  const rank = (id) => {
    const index = config?.preferredModels?.indexOf(id) ?? -1;
    return index === -1 ? Infinity : index;
  };
  return usable
    .map((model, index) => ({ model, index }))
    .sort((a, b) => rank(a.model.id) - rank(b.model.id) || a.index - b.index)
    .map(({ model }) => model);
}

/** Reasoning levels the UI offers; a single "Padrão" means the provider takes no effort setting. */
export function apiReasoningLevels(provider) {
  return API_PROVIDERS[provider]?.reasoning ? EFFORT_LEVELS : EFFORT_LEVELS.slice(0, 1);
}
