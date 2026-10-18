// Speech recognition engines the app can use. Parakeet runs in Node
// (server/parakeet-worker.js) and only needs its model; Google is online and needs
// Python; the others run on this computer (server/speech_engines.py) once their
// Python package (or whisper.cpp binary) and model are installed. Downloads come
// from the models' official releases; sizes are the download sizes.

export const DEFAULT_SPEECH_ENGINE = 'parakeet';

export const SPEECH_MODELS = {
  'parakeet-tdt-0.6b-v3-int8': {
    engine: 'parakeet',
    label: 'Parakeet TDT 0.6B v3 (int8)',
    bytes: 670478772,
    // The files of sherpa-onnx's release archive, published uncompressed: nothing to extract.
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'].map((name) => ({
      name, url: `https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/${name}`,
    })),
  },
  'whisper-large-v3-turbo-q5_0': {
    engine: 'whisper-turbo',
    label: 'Whisper large-v3-turbo (q5_0)',
    bytes: 574041195,
    files: [{ name: 'ggml-large-v3-turbo-q5_0.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin', bytes: 574041195 }],
  },
  'faster-whisper-small': {
    engine: 'faster-whisper',
    label: 'Whisper small',
    variant: 'small',
    bytes: 486000000,
    files: hfFiles('Systran/faster-whisper-small', 483546902),
  },
  'faster-whisper-base': {
    engine: 'faster-whisper',
    label: 'Whisper base',
    variant: 'base',
    bytes: 147500000,
    files: hfFiles('Systran/faster-whisper-base', 145217532),
  },
  'vosk-small-pt': {
    engine: 'vosk',
    label: 'Vosk português (pequeno)',
    language: 'pt-BR',
    bytes: 32453112,
    archive: 'https://alphacephei.com/vosk/models/vosk-model-small-pt-0.3.zip',
  },
  'vosk-small-en': {
    engine: 'vosk',
    label: 'Vosk inglês (pequeno)',
    language: 'en-US',
    bytes: 41205931,
    archive: 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip',
  },
};

// CTranslate2 conversions of Whisper published by Systran for faster-whisper.
function hfFiles(repo, modelBytes) {
  const url = (name) => `https://huggingface.co/${repo}/resolve/main/${name}`;
  return [
    { name: 'config.json', url: url('config.json') },
    { name: 'tokenizer.json', url: url('tokenizer.json') },
    { name: 'vocabulary.txt', url: url('vocabulary.txt') },
    { name: 'model.bin', url: url('model.bin'), bytes: modelBytes },
  ];
}

/**
 * `runtime: 'node'` engines run inside the app; the rest run in Python.
 * `packages` are Python modules ({ module, pip }); `binary` is a program the app
 * looks for; `models` are what to download. A whisper-small/base choice is the
 * engine's `variant`; Vosk uses every installed language model.
 */
export const SPEECH_ENGINES = [
  {
    id: 'google',
    name: 'Google',
    tag: 'online',
    local: false,
    packages: [{ module: 'speech_recognition', pip: 'SpeechRecognition' }],
    models: [],
    summary: 'Online, sem download. O áudio vai para o Google.',
    details: [
      ['Disco', 'nada'],
      ['Velocidade', '0,5 s para 1 s de fala, 1,8 s para 7 s (medido pela rede)'],
      ['Qualidade', 'erro de palavras de 14% em pt-BR e 8% em inglês (medido), sem pontuação'],
      ['Idioma', 'automático (pede os dois idiomas ao mesmo tempo)'],
      ['Requisitos', 'internet e o pacote Python SpeechRecognition'],
    ],
  },
  {
    id: 'parakeet',
    name: 'Parakeet TDT 0.6B v3',
    tag: 'offline · CPU · padrão',
    local: true,
    runtime: 'node',
    packages: [],
    models: ['parakeet-tdt-0.6b-v3-int8'],
    summary: 'O mais rápido e preciso na CPU, com pontuação. Só precisa baixar o modelo. Recomendado.',
    details: [
      ['Disco', '671 MB · ≈ 1,2 GB de RAM em uso'],
      ['Velocidade', '0,13 s para 1 s de fala, 0,4 s para 7 s, num i5-10400F (medido)'],
      ['Qualidade', 'erro de palavras de 6% em pt-BR e em inglês (medido), com pontuação'],
      ['Idioma', 'automático (o modelo não informa; o app decide pelas palavras)'],
      ['Requisitos', 'só o modelo; roda dentro do app, sem Python'],
    ],
  },
  {
    id: 'whisper-turbo',
    name: 'Whisper large-v3-turbo',
    tag: 'offline · GPU',
    local: true,
    packages: [],
    binary: 'whisper-server',
    models: ['whisper-large-v3-turbo-q5_0'],
    summary: 'Whisper grande na placa de vídeo (Vulkan). Alta qualidade, parcial mais lento.',
    details: [
      ['Disco', '574 MB · ≈ 250 MB de RAM, mais a memória da placa'],
      ['Velocidade', '≈ 1,2 s por pedido de até 7 s numa RX 6600 com Vulkan (medido); só na CPU não foi medido e é bem mais lento'],
      ['Qualidade', 'erro de palavras de 6% em pt-BR e 5% em inglês (medido), com pontuação'],
      ['Idioma', 'automático (detectado pelo Whisper)'],
      ['Requisitos', 'whisper-server do whisper.cpp, de preferência compilado com Vulkan'],
    ],
  },
  {
    id: 'faster-whisper',
    name: 'Whisper small / base',
    tag: 'offline · CPU',
    local: true,
    packages: [{ module: 'faster_whisper', pip: 'faster-whisper' }],
    models: ['faster-whisper-small', 'faster-whisper-base'],
    variants: ['small', 'base'],
    summary: 'Whispers menores na CPU. Base é rápido; small acerta mais.',
    details: [
      ['Disco', 'small 486 MB (≈ 1,2 GB de RAM) · base 148 MB (≈ 700 MB)'],
      ['Velocidade', 'small ≈ 2,1 s por pedido, base ≈ 0,65 s, num i5-10400F (medido)'],
      ['Qualidade', 'erro de palavras: small 10% pt-BR / 6% inglês, base 22% / 10% (medido)'],
      ['Idioma', 'automático (detectado pelo Whisper)'],
      ['Requisitos', 'pacote Python faster-whisper'],
    ],
  },
  {
    id: 'vosk',
    name: 'Vosk',
    tag: 'offline · leve',
    local: true,
    packages: [{ module: 'vosk', pip: 'vosk' }],
    models: ['vosk-small-pt', 'vosk-small-en'],
    summary: 'Muito leve, roda em qualquer máquina, mas é o que mais erra.',
    details: [
      ['Disco', 'português 54 MB · inglês 71 MB (download de 32 e 41 MB) · ≈ 400 MB de RAM'],
      ['Velocidade', '0,6 s para 1 s de fala, 3,1 s para 7 s no idioma automático (medido; com o idioma fixo, um modelo só trabalha)'],
      ['Qualidade', 'erro de palavras de 40% em pt-BR e 20% em inglês (medido), sem pontuação'],
      ['Idioma', 'não detecta: no modo automático, cada modelo instalado transcreve e vence o de melhor confiança'],
      ['Requisitos', 'pacote Python vosk e pelo menos um modelo'],
    ],
  },
];

export const SPEECH_ENGINE_IDS = SPEECH_ENGINES.map((engine) => engine.id);

export function speechEngine(id) {
  return SPEECH_ENGINES.find((engine) => engine.id === id) || null;
}

/** The models an engine needs with the given variant; Vosk needs any one of its models. */
export function requiredModels(engineId, variant = null) {
  const engine = speechEngine(engineId);
  if (!engine) return [];
  if (engine.variants) {
    const chosen = engine.variants.includes(variant) ? variant : engine.variants[0];
    return engine.models.filter((id) => SPEECH_MODELS[id].variant === chosen);
  }
  return engine.models;
}
