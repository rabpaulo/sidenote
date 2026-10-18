import workletUrl from './pcm-capture.worklet.js?url';
import { PcmChunker, StreamingTranscription, createWav } from '../../shared/streaming-transcription.js';
import { createUtteranceLanguage } from '../../shared/language.js';
import { apiFetch } from '../backend.js';

const loadedContexts = new WeakSet();

export async function startMicrophoneTranscription(context, stream, { language: setting, preferredLanguage, onPartial }) {
  if (!context.audioWorklet) throw new Error('AudioWorklet indisponível');
  if (!loadedContexts.has(context)) {
    await context.audioWorklet.addModule(workletUrl);
    loadedContexts.add(context);
  }
  const language = createUtteranceLanguage(setting, preferredLanguage);
  const session = new StreamingTranscription({
    transcribe: async (wav, signal) => {
      const response = await apiFetch(`/api/transcribe?lang=${encodeURIComponent(language.request)}`, {
        method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav, signal,
      });
      if (!response.ok) throw new Error('Falha ao acessar o serviço de transcrição');
      return language.observe(await response.json());
    },
    onPartial,
  });
  const chunker = new PcmChunker((chunk) => session.push(chunk));
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'pcm-capture');
  const muted = context.createGain();
  muted.gain.value = 0;
  let flush;
  let disconnected = false;
  function disconnect() {
    if (disconnected) return;
    disconnected = true;
    source.disconnect();
    node.disconnect();
    muted.disconnect();
    node.port.close();
  }
  node.port.onmessage = ({ data }) => {
    if (data.type === 'pcm') chunker.push(new Uint8Array(data.buffer));
    if (data.type === 'flushed') flush?.();
  };
  node.onprocessorerror = () => { session.cancel(); flush?.(); disconnect(); };
  source.connect(node);
  node.connect(muted);
  muted.connect(context.destination);

  return {
    async finish() {
      if (!disconnected) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => { session.cancel(); resolve(); }, 1000);
          flush = () => { clearTimeout(timer); resolve(); };
          node.port.postMessage('flush');
        });
        chunker.finish();
        disconnect();
      }
      const result = await session.done;
      return result.text ? { ...result, language: language.detected } : result;
    },
    cancel() { session.cancel(); flush?.(); disconnect(); },
  };
}

/**
 * A MediaRecorder recording (webm, ogg) as a 16 kHz mono PCM16 WAV, decoded by the
 * browser, so no recognizer needs ffmpeg. decodeAudioData resamples to the context's rate.
 */
export async function recordingToWav(blob) {
  const decoded = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(await blob.arrayBuffer());
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
  const pcm = new Uint8Array(decoded.length * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < decoded.length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i];
    view.setInt16(i * 2, Math.max(-1, Math.min(1, sum / channels.length)) * 0x7fff, true);
  }
  return createWav(pcm, 16000);
}
