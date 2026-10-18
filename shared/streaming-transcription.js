// Shared by the Linux loopback and the browser microphone. Every request is a
// standalone WAV; MediaRecorder's individual WebM blobs are not standalone files.
export function createWav(pcm, sampleRate = 16000) {
  const wav = new Uint8Array(44 + pcm.length);
  const view = new DataView(wav.buffer);
  const label = (offset, text) => {
    for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i);
  };
  label(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  label(8, 'WAVE');
  label(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, 'data');
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  return wav;
}

export class PcmChunker {
  constructor(onChunk, { chunkMs = 3000, firstChunkMs = chunkMs, overlapMs = 800, sampleRate = 16000 } = {}) {
    this.onChunk = onChunk;
    this.sampleRate = sampleRate;
    this.chunkBytes = Math.round(sampleRate * chunkMs / 1000) * 2;
    this.firstChunkBytes = Math.round(sampleRate * firstChunkMs / 1000) * 2;
    this.overlapBytes = Math.round(sampleRate * overlapMs / 1000) * 2;
    if (Math.min(this.chunkBytes, this.firstChunkBytes) <= this.overlapBytes || this.overlapBytes < 0) {
      throw new Error('O trecho deve ser maior que a sobreposição');
    }
    this.pending = new Uint8Array(0);
    this.retainedBytes = 0;
    this.sequence = 0;
    this.finished = false;
  }

  push(pcm, emit = true) {
    if (this.finished) return;
    const combined = new Uint8Array(this.pending.length + pcm.length);
    combined.set(this.pending);
    combined.set(pcm, this.pending.length);
    this.pending = combined;
    let windowBytes = this.sequence === 0 ? this.firstChunkBytes : this.chunkBytes;
    while (emit && this.pending.length >= windowBytes) {
      this.emit(this.pending.slice(0, windowBytes), false);
      this.pending = this.pending.slice(windowBytes - this.overlapBytes);
      this.retainedBytes = this.overlapBytes;
      windowBytes = this.chunkBytes;
    }
  }

  emit(pcm, final) {
    this.onChunk({
      wavBuffer: pcm?.length ? createWav(pcm, this.sampleRate) : null,
      overlapBytes: this.retainedBytes,
      sequence: this.sequence++, final,
    });
  }

  // Start recognition during a pause, retaining context in case speech resumes.
  flushPending(trimEndBytes = 0) {
    if (this.finished) return false;
    const end = Math.max(0, this.pending.length - trimEndBytes);
    if (end <= this.retainedBytes) return false;
    const speech = this.pending.slice(0, end);
    this.emit(speech, false);
    this.pending = speech.slice(Math.max(0, speech.length - this.overlapBytes));
    this.retainedBytes = this.pending.length;
    return true;
  }

  finish(trimEndBytes = 0) {
    if (this.finished) return;
    this.finished = true;
    const end = Math.max(0, this.pending.length - trimEndBytes);
    // No new audio: finish the turn without retranscribing the overlap.
    this.emit(end > this.retainedBytes ? this.pending.slice(0, end) : null, true);
    this.pending = new Uint8Array(0);
  }
}

export function mergeTranscript(previous, next, overlap = true) {
  const left = previous.trim().split(/\s+/).filter(Boolean);
  const right = next.trim().split(/\s+/).filter(Boolean);
  const normalize = (word) => word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  let matching = 0;
  if (overlap) {
    for (let size = Math.min(left.length, right.length, 24); size > 0; size--) {
      if (right.slice(0, size).every((word, i) => {
        const token = normalize(word);
        return token && token === normalize(left[left.length - size + i]);
      })) {
        matching = size;
        break;
      }
    }
  }
  return [...left, ...right.slice(matching)].join(' ');
}

// One request at a time per utterance preserves order. A bounded queue stops a
// slow/offline service from accumulating minutes of audio and late responses.
export class StreamingTranscription {
  constructor({ transcribe, onPartial = () => {}, onFinal = () => {}, onError = () => {}, maxPending = 8, maxRecoverySeconds = 10 }) {
    Object.assign(this, { transcribe, onPartial, onFinal, onError, maxPending });
    this.controller = new AbortController();
    this.queue = [];
    this.text = '';
    this.running = false;
    this.closed = false;
    this.cancelled = false;
    this.context = null;
    this.contextBase = '';
    this.contextOverlap = false;
    this.recovering = false;
    this.maxRecoveryBytes = maxRecoverySeconds * 32000;
    this.done = new Promise((resolve) => { this.resolve = resolve; });
  }

  push(chunk) {
    if (this.closed || this.cancelled) return;
    if (this.queue.length >= this.maxPending) {
      this.fail('O serviço de transcrição não está acompanhando o áudio. Tente novamente.');
      return;
    }
    this.queue.push(chunk);
    if (chunk.final) this.closed = true;
    this.drain();
  }

  async drain() {
    if (this.running || this.cancelled) return;
    this.running = true;
    try {
      while (this.queue.length && !this.cancelled) {
        const chunk = this.queue.shift();
        if (chunk.wavBuffer) {
          let wav = chunk.wavBuffer;
          let expanded = this.recovering;
          if (expanded) wav = this.withContext(chunk);
          let result = await this.transcribe(wav, this.controller.signal);
          if (this.cancelled) return;
          const unrecognized = (value) => value.code === 'unrecognized' || (!value.error && !value.text?.trim());
          // A cropped syllable or quiet tail is not a failed conversation.
          // Retry with the preceding audio, or hold the first failed window
          // until more audio arrives. Network and format errors still fail fast.
          if (unrecognized(result) && this.context && !expanded) {
            wav = this.withContext(chunk);
            expanded = true;
            result = await this.transcribe(wav, this.controller.signal);
            if (this.cancelled) return;
          }
          if (!result.text?.trim()) {
            if (!unrecognized(result)) throw new Error(result.error || 'Falha ao transcrever áudio');
            if (!expanded) {
              this.contextBase = this.text;
              this.contextOverlap = chunk.sequence > 0;
            }
            this.context = wav;
            this.recovering = true;
            if (chunk.final) throw new Error(result.error || 'Não foi possível entender o áudio');
            continue;
          }
          const base = expanded ? this.contextBase : this.text;
          const overlap = expanded ? this.contextOverlap : chunk.sequence > 0;
          this.text = mergeTranscript(base, result.text, overlap);
          this.context = wav;
          this.contextBase = base;
          this.contextOverlap = overlap;
          this.recovering = false;
          if (!chunk.final) this.onPartial(this.text);
        }
        if (chunk.final) {
          if (this.recovering) throw new Error('Não foi possível entender o áudio');
          if (!this.text) throw new Error('Não foi possível entender o áudio');
          this.onFinal(this.text);
          this.resolve({ text: this.text });
        }
      }
    } catch (error) {
      if (!this.cancelled) this.fail(error.message || 'Falha ao transcrever áudio');
    } finally {
      this.running = false;
    }
  }

  withContext(chunk) {
    const previous = this.context.subarray(44);
    const next = chunk.wavBuffer.subarray(44 + (chunk.overlapBytes ?? 25600));
    if (previous.length + next.length > this.maxRecoveryBytes) {
      throw new Error('Não foi possível entender o áudio após ampliar o contexto');
    }
    const pcm = new Uint8Array(previous.length + next.length);
    pcm.set(previous);
    pcm.set(next, previous.length);
    return createWav(pcm);
  }

  fail(error) {
    this.cancel();
    this.onError(error);
  }

  cancel() {
    this.cancelled = true;
    this.queue = [];
    this.context = null;
    this.controller.abort();
    this.resolve({ cancelled: true });
  }
}
