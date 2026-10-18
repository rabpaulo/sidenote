import { createWav } from './streaming-transcription.js';

// The free recognizer only takes whole files, and its latency grows with their
// length (about 0.5 s for 1 s of audio, 1.2 s for 4 s, 2.5 s for 13 s). So the
// utterance is split in segments of 3 to 7 s, cut at a gap between words. The open segment, the "tail", is sent again
// every second as it grows, which keeps the transcript about a second behind the
// speaker; a closed segment is sent once more as a whole ("commit") and its text
// is kept. No transcript merging is needed: segments never overlap.

const concat = (pieces) => {
  const out = new Uint8Array(pieces.reduce((size, piece) => size + piece.pcm.length, 0));
  let offset = 0;
  for (const piece of pieces) { out.set(piece.pcm, offset); offset += piece.pcm.length; }
  return out;
};

function energy(pcm) {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sum = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let i = 0; i < samples; i++) { const sample = view.getInt16(i * 2, true); sum += sample * sample; }
  return samples ? sum / samples : 0;
}

/**
 * Producer side, fed by the PC capture. Same interface as PcmChunker. Emits:
 * - { kind: 'tail', segment, sequence, wavBuffer, pause? } while speaking, about every
 *   `intervalMs`, and at a pause (`pause: true`, the likely end of the question);
 * - { kind: 'commit', segment, sequence, wavBuffer } when a segment closes;
 * - { kind: 'final', final: true, segment, sequence, wavBuffer | null, reuse } at the end.
 *   Without audio, the final text is the result of tail `reuse`, which already covered it.
 */
export class RollingAudio {
  constructor(onChunk, { intervalMs = 1000, firstMs = 1000, maxTailMs = 3000, hardMaxTailMs = 7000, minCommitMs = 1500,
    keepMs = 250, gapRatio = 0.001, padMs = 300, sampleRate = 16000 } = {}) {
    const bytes = (ms) => Math.round(sampleRate * ms / 1000) * 2;
    Object.assign(this, {
      onChunk, sampleRate,
      intervalBytes: bytes(intervalMs), firstBytes: bytes(firstMs), maxTailBytes: bytes(maxTailMs),
      hardMaxTailBytes: bytes(hardMaxTailMs), minCommitBytes: bytes(minCommitMs), keepBytes: bytes(keepMs), gapRatio,
      padBytes: bytes(padMs),
    });
    this.pieces = [];
    this.tailBytes = 0;
    this.totalBytes = 0;
    this.sinceEmitBytes = 0;
    this.emittedTailBytes = 0; // length of the current segment when its tail was last sent
    this.lastTailSequence = null;
    this.segment = 0;
    this.sequence = 0;
    this.flushed = false;
    this.finished = false;
  }

  push(pcm, emit = true) {
    if (this.finished || !pcm?.length) return;
    this.pieces.push({ pcm: Uint8Array.from(pcm), energy: energy(pcm) });
    this.tailBytes += pcm.length;
    this.totalBytes += pcm.length;
    this.sinceEmitBytes += pcm.length;
    if (!emit) return;
    this.flushed = false;
    if (this.tailBytes >= this.maxTailBytes) this.commit();
    const due = this.lastTailSequence === null && this.segment === 0
      ? this.totalBytes >= this.firstBytes
      : this.sinceEmitBytes >= this.intervalBytes;
    if (due && this.tailBytes) this.emitTail();
  }

  emitTail(extra) {
    this.sinceEmitBytes = 0;
    this.emittedTailBytes = this.tailBytes;
    this.lastTailSequence = this.sequence;
    this.emit('tail', this.pieces, extra);
  }

  commit() {
    // Cut in the quietest 150 ms (three pieces), leaving at least `minCommitBytes`
    // before it and `keepBytes` after it. A cut inside a word garbles it on both
    // sides, and a short dip is often just a consonant (about 20 dB down); so before
    // `hardMaxTailBytes` only a real pause, 30 dB below the speech, is accepted.
    const ends = [];
    let position = 0;
    for (const piece of this.pieces) ends.push(position += piece.pcm.length);
    let best = -1;
    let bestEnergy = Infinity;
    for (let i = 1; i < this.pieces.length - 1; i++) {
      if (ends[i] < this.minCommitBytes) continue;
      if (this.tailBytes - ends[i] < this.keepBytes) break;
      const windowEnergy = Math.max(this.pieces[i - 1].energy, this.pieces[i].energy, this.pieces[i + 1].energy);
      // On a tie, the later cut leaves less audio in the open tail.
      if (windowEnergy <= bestEnergy) { best = i; bestEnergy = windowEnergy; }
    }
    if (best === -1) return;
    const sorted = this.pieces.map((piece) => piece.energy).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (this.tailBytes < this.hardMaxTailBytes && bestEnergy > median * this.gapRatio) return;
    const closed = this.pieces.slice(0, best + 1);
    this.emit('commit', closed);
    this.pieces = this.pieces.slice(best + 1);
    this.tailBytes = this.pieces.reduce((size, piece) => size + piece.pcm.length, 0);
    this.segment++;
    this.emittedTailBytes = 0;
    this.lastTailSequence = null;
  }

  emit(kind, pieces, extra = {}) {
    const pcm = pieces?.length ? concat(pieces) : null;
    this.onChunk({
      kind, segment: this.segment, sequence: this.sequence++, final: kind === 'final',
      wavBuffer: pcm?.length ? createWav(pcm, this.sampleRate) : null,
      durationMs: pcm ? pcm.length / (this.sampleRate * 2) * 1000 : 0,
      ...extra,
    });
  }

  // Drops trailing silence, except `padBytes` of it: the end of a quiet last
  // syllable ("from it") counts as silence for the voice detector.
  trim(trimEndBytes) {
    const end = Math.max(0, this.tailBytes - Math.max(0, trimEndBytes - this.padBytes));
    let size = 0;
    const kept = [];
    for (const piece of this.pieces) {
      if (size >= end) break;
      kept.push(piece);
      size += piece.pcm.length;
    }
    this.pieces = kept;
    this.tailBytes = size;
  }

  // Start recognizing during a pause: if speech resumes, it simply continues the tail.
  flushPending(trimEndBytes = 0) {
    if (this.finished) return false;
    const end = this.tailBytes - Math.max(0, trimEndBytes - this.padBytes);
    if (end <= 0 || (this.lastTailSequence !== null && end <= this.emittedTailBytes)) return false;
    this.trim(trimEndBytes);
    this.emitTail({ pause: true });
    this.flushed = true;
    return true;
  }

  finish(trimEndBytes = 0) {
    if (this.finished) return;
    this.finished = true;
    // After a flush, the pause it kept is already in the tail; drop the rest.
    if (this.flushed) this.trim(trimEndBytes + this.padBytes);
    else this.trim(trimEndBytes);
    // Nothing new since the last tail: its result is already the end of the utterance.
    if (this.lastTailSequence !== null && this.tailBytes <= this.emittedTailBytes) {
      this.emit('final', null, { reuse: this.lastTailSequence });
    } else this.emit('final', this.pieces);
    this.pieces = [];
  }
}

/**
 * Consumer side: one per utterance. Up to `maxInFlight` requests run at once; a tail
 * waiting for room is replaced by a newer one, so only the latest audio is sent
 * (the newest result wins anyway). Commits and the final always run. A local
 * engine, which recognizes one request at a time, uses `maxInFlight: 1`: a tail
 * queued behind others would only be outdated by the time its turn came. Errors on
 * a tail are ignored, since the next one covers the same audio; the utterance fails
 * only if it ends with no text.
 */
export class RollingTranscription {
  constructor({ transcribe, onPartial = () => {}, onFinal = () => {}, onError = () => {}, maxInFlight = 3 }) {
    Object.assign(this, { transcribe, onPartial, onFinal, onError, maxInFlight });
    this.controller = new AbortController();
    this.segments = [];
    this.inFlight = 0;
    this.pendingTail = null;
    this.finalChunk = null;
    this.finalResult = null;
    this.lastPartial = '';
    this.lastError = null;
    this.closed = false;
    this.cancelled = false;
    this.settled = false;
    this.done = new Promise((resolve) => { this.resolve = resolve; });
  }

  segmentAt(index) {
    while (this.segments.length <= index) {
      this.segments.push({ text: '', sequence: -1, answered: new Set(), commit: null });
    }
    return this.segments[index];
  }

  push(chunk) {
    if (this.closed || this.cancelled) return;
    const kind = chunk.kind || (chunk.final ? 'final' : 'tail');
    const segment = chunk.segment ?? 0;
    if (kind === 'commit') {
      this.segmentAt(segment).commit = { done: false };
      this.run({ ...chunk, kind, segment });
    } else if (kind === 'tail') {
      this.pendingTail = { ...chunk, kind, segment };
      this.pump();
    } else {
      this.closed = true;
      this.finalChunk = { ...chunk, kind, segment };
      this.segmentAt(segment);
      const pending = this.pendingTail;
      this.pendingTail = null;
      if (chunk.wavBuffer) this.run(this.finalChunk);
      // The final reuses this tail's result, so it has to run now.
      else if (pending && pending.sequence === chunk.reuse) this.run(pending);
      this.check();
    }
  }

  pump() {
    if (!this.pendingTail || this.inFlight >= this.maxInFlight) return;
    const chunk = this.pendingTail;
    this.pendingTail = null;
    this.run(chunk);
  }

  run(chunk) {
    this.inFlight++;
    Promise.resolve()
      .then(() => this.transcribe(chunk.wavBuffer, this.controller.signal, chunk))
      .catch((error) => ({ error: error.message || 'Falha ao transcrever áudio' }))
      .then((result) => {
        this.inFlight--;
        if (this.cancelled) return;
        this.apply(chunk, result || {});
        this.pump();
        this.check();
      });
  }

  apply(chunk, result) {
    const segment = this.segmentAt(chunk.segment);
    const text = result.text?.trim() || '';
    const failed = !text && result.error && result.code !== 'unrecognized';
    if (failed) this.lastError = result.error;
    if (chunk.kind === 'commit') {
      segment.commit = { done: true, text, failed };
    } else {
      segment.answered.add(chunk.sequence);
      // A newer tail covers more audio; an unrecognized one keeps the older words.
      if (text && chunk.sequence > segment.sequence) {
        segment.sequence = chunk.sequence;
        segment.text = text;
      }
      if (chunk.kind === 'final') this.finalResult = result;
    }
    if (!this.closed) {
      const partial = this.text();
      if (partial && partial !== this.lastPartial) {
        this.lastPartial = partial;
        this.onPartial(partial, chunk);
      }
    }
  }

  text() {
    const parts = this.segments
      .map((segment) => (segment.commit?.done && (segment.commit.text || !segment.commit.failed) ? segment.commit.text : segment.text))
      .filter(Boolean);
    // Recognizers that punctuate (the local ones) end every segment with a period,
    // even when the sentence goes on in the next one ("Deity Yoga. através da").
    return parts
      .map((part, index) => (index < parts.length - 1 && /^\p{Ll}/u.test(parts[index + 1]) ? part.replace(/\.$/, '') : part))
      .join(' ');
  }

  check() {
    if (!this.closed || this.settled || this.cancelled) return;
    if (this.segments.some((segment) => segment.commit && !segment.commit.done)) return;
    const final = this.finalChunk;
    const last = this.segments[final.segment];
    if (final.wavBuffer ? !this.finalResult : (final.reuse !== undefined && !last.answered.has(final.reuse))) return;
    this.settled = true;
    const text = this.text();
    if (!text) {
      this.fail(this.lastError || 'Não foi possível entender o áudio');
      return;
    }
    this.onFinal(text);
    this.resolve({ text });
  }

  fail(error) {
    this.cancel();
    this.onError(error);
  }

  cancel() {
    this.cancelled = true;
    this.pendingTail = null;
    this.controller.abort();
    this.resolve({ cancelled: true });
  }
}
