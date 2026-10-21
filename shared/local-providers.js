// Models that run on this computer, served by Ollama or LM Studio over localhost.
// No key and no account: the server finds out whether the runtime is installed and
// running and which models it has (server/local-models.js). The catalog below is what
// the app offers to download with Ollama, rated against the machine's hardware.

const THINK_LEVELS = [
  { id: 'off', label: 'Sem raciocínio', hint: 'Mais rápido, ideal ao vivo' },
  { id: 'low', label: 'Low', hint: 'Raciocínio curto' },
  { id: 'medium', label: 'Médio', hint: 'Equilíbrio' },
  { id: 'high', label: 'High', hint: 'Raciocínio aprofundado' },
];

export const LOCAL_PROVIDERS = {
  ollama: {
    id: 'ollama',
    name: 'Ollama (local)',
    shortName: 'Ollama',
    tagline: 'Modelos abertos rodando neste computador',
    protocol: 'ollama',
    // OLLAMA_HOST overrides it on the server (see server/local-models.js).
    baseUrl: 'http://127.0.0.1:11434',
    bin: 'ollama',
    installUrl: 'https://ollama.com/download',
    reasoningLevels: THINK_LEVELS,
    defaultReasoning: 'off',
  },
  lmstudio: {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    shortName: 'LM Studio',
    tagline: 'Servidor local do LM Studio',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    bin: 'lms',
    installUrl: 'https://lmstudio.ai/download',
    reasoningLevels: [{ id: 'default', label: 'Padrão', hint: 'Padrão do modelo' }],
    defaultReasoning: 'default',
    // LM Studio rejects stream_options on older versions; usage is optional anyway.
    streamUsage: false,
  },
};

export const LOCAL_PROVIDER_IDS = Object.keys(LOCAL_PROVIDERS);

export const isLocalProvider = (id) => Object.hasOwn(LOCAL_PROVIDERS, id);

/**
 * Ollama models worth running for live suggestions, smallest first. `sizeGb` is the
 * download of the default (4-bit) tag; `activeB` is set for mixture-of-experts models,
 * which read only that many billion parameters per token and so stay fast even when
 * part of them sits in system memory. `quality` is a rough rank for conversation in
 * Portuguese and English, used only to order the recommendations.
 */
export const LOCAL_MODEL_CATALOG = [
  { id: 'qwen3.5:0.8b', name: 'Qwen 3.5 0.8B', sizeGb: 1.3, paramsB: 0.8, quality: 1, note: 'Mínimo: roda em qualquer máquina, respostas simples.' },
  { id: 'qwen3.5:2b', name: 'Qwen 3.5 2B', sizeGb: 2.7, paramsB: 2, quality: 2, note: 'Leve, bom para máquinas sem placa de vídeo.' },
  { id: 'qwen3.5:4b', name: 'Qwen 3.5 4B', sizeGb: 3.4, paramsB: 4, quality: 3.5, note: 'Pequeno e capaz; ótimo custo-benefício em notebooks.' },
  { id: 'qwen3.5:9b', name: 'Qwen 3.5 9B', sizeGb: 6.6, paramsB: 9, quality: 5, note: 'Equilibrado para placas de 8 GB.' },
  { id: 'gemma4:12b', name: 'Gemma 4 12B', sizeGb: 7.7, paramsB: 12, quality: 5.5, note: 'Bom em português, cabe em 8 a 12 GB de vídeo.' },
  { id: 'gpt-oss:20b', name: 'GPT-OSS 20B', sizeGb: 14, paramsB: 21, activeB: 3.6, quality: 6, note: 'MoE da OpenAI: rápido mesmo dividindo com a RAM.' },
  { id: 'gemma4:26b', name: 'Gemma 4 26B', sizeGb: 17, paramsB: 26, quality: 6.8, note: 'Para placas de 24 GB.' },
  { id: 'qwen3.6:27b', name: 'Qwen 3.6 27B', sizeGb: 18, paramsB: 27, quality: 7.6, note: 'Um dos melhores que cabem numa placa de 24 GB.' },
  { id: 'gemma4:31b', name: 'Gemma 4 31B', sizeGb: 19, paramsB: 31, quality: 7.3, note: 'Gemma maior; placas de 24 GB.' },
  { id: 'qwen3.6:35b', name: 'Qwen 3.6 35B (MoE)', sizeGb: 23, paramsB: 35, activeB: 3, quality: 7.8, note: 'MoE: qualidade alta com velocidade de modelo pequeno.' },
  { id: 'gpt-oss:120b', name: 'GPT-OSS 120B', sizeGb: 65, paramsB: 117, activeB: 5.1, quality: 8.5, note: 'Estações com 80 GB de vídeo ou muita memória unificada.' },
  { id: 'qwen3.5:122b', name: 'Qwen 3.5 122B (MoE)', sizeGb: 81, paramsB: 122, activeB: 10, quality: 8.8, note: 'Para 96 GB ou mais de memória.' },
];

// Room for the context window (8k tokens) and the runtime on top of the weights.
export const modelMemoryGb = (model) => model.sizeGb * 1.1 + 0.6;

const SPEED_PENALTY = { fast: 0, medium: 0.8, slow: 2.5 };

/**
 * Memory the models can use. A dedicated GPU (NVIDIA or AMD) gives its VRAM; Apple
 * Silicon shares most of its RAM with the GPU; integrated graphics count as CPU.
 * Part of the RAM is left to the system, the meeting app and Sidenote itself.
 */
export function memoryBudget(hardware) {
  const ramGb = Math.max(0, Number(hardware?.ramGb) || 0);
  const gpus = Array.isArray(hardware?.gpus) ? hardware.gpus : [];
  const unified = gpus.find((gpu) => gpu.unified);
  if (unified) return { vramGb: Math.max(0, ramGb * 0.7 - 2), ramGb: 0, cpuGb: Math.max(0, ramGb * 0.6 - 1), gpu: unified };
  const dedicated = gpus.filter((gpu) => gpu.dedicated && Number(gpu.vramGb) > 0)
    .sort((a, b) => b.vramGb - a.vramGb)[0] || null;
  return { vramGb: dedicated ? dedicated.vramGb * 0.95 : 0, ramGb: ramGb * 0.5, cpuGb: Math.max(0, ramGb * 0.6 - 1), gpu: dedicated };
}

/**
 * How one model would run here: `fit` is "gpu" (all in video memory), "partial"
 * (split with RAM), "cpu" (no usable GPU) or "none" (does not fit); `speed` is the
 * expected pace of a live answer.
 */
export function rateLocalModel(model, hardware) {
  const budget = memoryBudget(hardware);
  const need = Math.round(modelMemoryGb(model) * 10) / 10;
  const activeShare = model.activeB ? model.activeB / model.paramsB : 1;
  if (budget.vramGb && need <= budget.vramGb) return { fit: 'gpu', speed: 'fast', needGb: need };
  if (budget.vramGb && need <= budget.vramGb + budget.ramGb) {
    // Dense layers left in RAM slow every token; experts mostly stay idle.
    const spilled = need - budget.vramGb;
    const speed = model.activeB ? 'medium' : spilled <= 2 ? 'medium' : 'slow';
    return { fit: 'partial', speed, needGb: need };
  }
  if (need <= budget.cpuGb) {
    const readGb = model.sizeGb * activeShare;
    // A CPU reads the active weights once per token, limited by memory bandwidth.
    const speed = readGb <= 2 ? 'fast' : readGb <= 4 ? 'medium' : readGb <= 7 ? 'slow' : null;
    if (speed) return { fit: budget.vramGb ? 'partial' : 'cpu', speed, needGb: need };
  }
  return { fit: 'none', speed: null, needGb: need };
}

/**
 * The catalog rated for this machine, with the single best choice for live answers
 * marked `recommended`: the highest quality that still answers at a usable pace.
 */
export function recommendLocalModels(hardware, catalog = LOCAL_MODEL_CATALOG) {
  const rated = catalog.map((model) => ({ ...model, ...rateLocalModel(model, hardware), recommended: false }));
  const score = (model) => model.quality - SPEED_PENALTY[model.speed];
  const best = rated.filter((model) => model.speed).sort((a, b) => score(b) - score(a))[0];
  if (best) best.recommended = true;
  return rated;
}
