import { spawn, execSync } from 'child_process';
import EventEmitter from 'events';
import { RollingAudio } from '../shared/rolling-transcription.js';
import { distinctiveMedia, listSinkInputs, pickStream, programStreams } from './audio-apps.js';

const CHUNK_BYTES = 1600; // 50 ms of PCM16 mono at 16 kHz

/**
 * Where the PC audio comes from: 'parec' (Linux, PulseAudio/PipeWire monitor) or
 * 'renderer' (Windows/macOS: Electron captures the system loopback and streams PCM16 over the WebSocket).
 */
export function defaultAudioSource(env = process.env, platform = process.platform) {
  if (env.SIDENOTE_AUDIO_SOURCE === 'parec' || env.SIDENOTE_AUDIO_SOURCE === 'renderer') return env.SIDENOTE_AUDIO_SOURCE;
  return platform === 'linux' ? 'parec' : 'renderer';
}

/**
 * SystemAudioEngine
 * Captures native system/PC audio loopback: parec on Linux, or PCM pushed by the
 * desktop renderer (pushPcm) on Windows.
 * Emits:
 * - 'level': { level: number (0-100), rms: number } (emitted ~30 times/sec)
 * - 'speech_start': { utteranceId, timestamp }
 * - 'speech_chunk': { utteranceId, kind: 'tail' | 'commit', segment, wavBuffer, sequence } (while speaking)
 * - 'speech_segment': { wavBuffer: Buffer, durationSec: number }
 * - 'status': { isCapturing: boolean, sink: string, source, app: { id, name, stream, waiting, ambiguous, streams } | null }
 * - 'error': (err)
 */
export class SystemAudioEngine extends EventEmitter {
  constructor({ source = defaultAudioSource(), spawnProcess = spawn, listInputs = listSinkInputs, appPollMs = 5000 } = {}) {
    super();
    this.source = source;
    this.spawnProcess = spawnProcess;
    this.listInputs = listInputs;
    this.appPollMs = appPollMs;
    // One application stream instead of the whole output: { id, name, stream, media, ambiguous, streams } (Linux only).
    this.appTarget = null;
    this.appWatcher = null;
    this.appPoll = null;
    this.appResolve = null;
    this.rendererLeftover = Buffer.alloc(0);
    this.captureProcess = null;
    this.isCapturing = false;
    this.currentSink = null;

    // VAD (Voice Activity Detection) Parameters
    this.vadThreshold = 14; // RMS threshold percentage (0-100)
    this.silenceMsThreshold = 900; // Silence time in ms to consider speech finished
    this.minSpeechMs = 700; // Minimum speech duration to discard random clicks
    this.preSpeechBufferMs = 200;
    // Continuous audio (a video, background music) may never pause long enough
    // to end an utterance; past this length it is split so it still reaches the agent.
    this.maxSpeechMs = 30000;

    // Internal state
    this.inSpeech = false;
    this.speechChunker = null;
    this.speechTotalBytes = 0;
    this.utteranceId = null;
    this.preSpeechChunks = [];
    this.speechStartTime = null;
    this.lastVoiceDetectedTime = null;
    this.speechVoicedMs = 0;
    this.trailingSilenceBytes = 0;
    this.silenceTimer = null;
    this.silenceFlushTimer = null;
    this.flushedSilenceBytes = 0;
    this.nextSpeechId = 0;
    this.abandonedUtteranceId = null;
    this.sampleRate = 16000;
    this.bytesPerSample = 2; // 16-bit PCM = 2 bytes
    this.channels = 1;
  }

  /**
   * Discovers available audio output sinks and the current default sink.
   */
  static listAudioSinks(source = defaultAudioSource()) {
    if (source === 'renderer') {
      return {
        defaultSink: 'loopback',
        sinks: [{ id: '0', name: 'loopback', monitorSource: 'loopback', isDefault: true, description: 'Áudio do sistema (loopback)' }],
      };
    }
    try {
      let defaultSink = '';
      try {
        defaultSink = execSync('pactl get-default-sink', { encoding: 'utf-8' }).trim();
      } catch (e) {
        console.warn('[SystemAudio] Could not get default sink via pactl:', e.message);
      }

      let sinksOutput = '';
      try {
        sinksOutput = execSync('pactl list short sinks', { encoding: 'utf-8' });
      } catch (e) {
        console.warn('[SystemAudio] Could not list sinks via pactl:', e.message);
      }

      const sinks = [];
      const lines = sinksOutput.split('\n').filter(Boolean);

      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length >= 2) {
          const name = parts[1];
          const isDefault = name === defaultSink;
          sinks.push({
            id: parts[0],
            name,
            monitorSource: `${name}.monitor`,
            isDefault,
            description: SystemAudioEngine.formatSinkDescription(name),
          });
        }
      }

      return {
        defaultSink,
        sinks: sinks.length > 0 ? sinks : [
          {
            id: '0',
            name: defaultSink || '@DEFAULT_SINK@',
            monitorSource: defaultSink ? `${defaultSink}.monitor` : '@DEFAULT_SINK@.monitor',
            isDefault: true,
            description: 'Dispositivo de Áudio Padrão do Sistema',
          },
        ],
      };
    } catch (err) {
      console.error('[SystemAudio] Error listing audio sinks:', err);
      return { defaultSink: '@DEFAULT_SINK@', sinks: [] };
    }
  }

  static formatSinkDescription(sinkName) {
    if (sinkName.includes('bluez')) return 'Fone / Caixa Bluetooth';
    if (sinkName.includes('fifine')) return 'Microfone/Headset Fifine USB';
    if (sinkName.includes('hdmi')) return 'Saída HDMI / Monitor';
    if (sinkName.includes('iec958') || sinkName.includes('analog-stereo')) return 'Áudio Analógico / Placa Mãe';
    return sinkName;
  }

  /**
   * Starts loopback capturing from the specified sink or the system default sink,
   * or, with `app` ({ id, name, stream, media } from listAudioStreams), from that stream only.
   */
  startCapture(options = {}) {
    const {
      sink = null,
      app = null,
      vadThreshold = 14,
      silenceMsThreshold = 900,
      minSpeechMs = 700,
      maxSpeechMs = 30000,
    } = options;

    this.vadThreshold = vadThreshold;
    this.silenceMsThreshold = silenceMsThreshold;
    this.minSpeechMs = minSpeechMs;
    this.maxSpeechMs = maxSpeechMs;

    if (this.source === 'renderer') return this.startRendererCapture();
    if (app?.id) return this.startAppCapture(app);

    let targetMonitor = '';
    if (sink) {
      targetMonitor = sink.endsWith('.monitor') ? sink : `${sink}.monitor`;
    } else {
      const sinksInfo = SystemAudioEngine.listAudioSinks();
      const defaultSink = sinksInfo.defaultSink;
      if (defaultSink) {
        targetMonitor = `${defaultSink}.monitor`;
      } else {
        targetMonitor = '@DEFAULT_SINK@.monitor';
      }
    }

    if (this.isCapturing && this.captureProcess && this.currentSink === targetMonitor) {
      return true;
    }

    if (this.captureProcess || this.appTarget) {
      this.stopCapture({ quiet: true });
    }

    this.currentSink = targetMonitor;
    console.log(`[SystemAudio] Starting PC audio loopback capture on monitor: ${targetMonitor}`);
    if (!this.spawnParec(['-d', targetMonitor])) return false;
    this.isCapturing = true;
    this.inSpeech = false;
    this.clearSpeech();
    this.emitStatus();
    return true;
  }

  // parec: 16kHz, mono, 16-bit little-endian, from a monitor (-d) or one stream (--monitor-stream).
  spawnParec(targetArgs) {
    const args = [
      ...targetArgs,
      '--rate', String(this.sampleRate),
      '--channels', String(this.channels),
      '--format', 's16le',
    ];

    let captureProcess;
    try {
      captureProcess = this.spawnProcess('parec', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      console.error('[SystemAudio] Failed to spawn parec:', err);
      this.emit('error', err);
      return false;
    }

    this.captureProcess = captureProcess;

    let leftover = Buffer.alloc(0);
    const chunkSize = CHUNK_BYTES;

    captureProcess.stdout.on('data', (data) => {
      if (this.captureProcess !== captureProcess) return;
      const combined = Buffer.concat([leftover, data]);
      const fullChunksCount = Math.floor(combined.length / chunkSize);

      for (let i = 0; i < fullChunksCount; i++) {
        const chunk = combined.subarray(i * chunkSize, (i + 1) * chunkSize);
        this.processPcmChunk(chunk);
      }

      leftover = combined.subarray(fullChunksCount * chunkSize);
    });

    captureProcess.stderr.on('data', (data) => {
      const errStr = data.toString().trim();
      if (errStr && !errStr.includes('write() failed')) {
        console.warn(`[SystemAudio parec stderr]:`, errStr);
      }
    });

    captureProcess.on('close', (code) => {
      console.log(`[SystemAudio] parec process exited with code ${code}`);
      if (this.captureProcess !== captureProcess) return;
      this.captureProcess = null;
      this.discardSpeech();
      // The application closed its stream; keep waiting for the next one it opens.
      if (this.appTarget) {
        this.appTarget.recording = null;
        this.emitStatus();
        this.resolveAppStream();
        return;
      }
      this.isCapturing = false;
      this.emitStatus();
    });

    captureProcess.on('error', (err) => {
      if (this.captureProcess !== captureProcess) return;
      console.error('[SystemAudio] parec process error:', err);
      this.emit('error', err);
      this.stopCapture();
    });

    return true;
  }

  /**
   * Records only what one application plays. Its stream can come and go (a call
   * that has not started yet, a reconnect), so the audio server's events are
   * followed and parec is pointed at the application's current stream.
   */
  startAppCapture({ id, name, stream = null, media = null, fresh = false }) {
    const chosen = Number.isInteger(stream) ? stream : null;
    const same = this.isCapturing && this.appTarget?.id === id && (chosen === null || this.appTarget.stream === chosen);
    if (same && (!fresh || this.appTarget.trusted)) return true;
    if (this.isCapturing || this.captureProcess) this.stopCapture({ quiet: true });
    // `stream` is the one the user picked; `recording` is the one parec reads now. Only a
    // pick from the list just shown (`fresh`) is trusted as is: a saved index may by now
    // belong to another tab. `others` play beside the chosen stream (see pickStream).
    this.appTarget = { id, name: name || id, stream: chosen, media, trusted: !!fresh, others: [], lost: false,
      recording: null, ambiguous: false, streams: 0 };
    this.currentSink = `app:${id}`;
    this.isCapturing = true;
    this.inSpeech = false;
    this.clearSpeech();
    console.log(`[SystemAudio] Capturing only the audio of ${this.appTarget.name}`);
    this.emitStatus();
    this.watchAppStreams();
    this.resolveAppStream();
    return true;
  }

  watchAppStreams() {
    try {
      const watcher = this.spawnProcess('pactl', ['subscribe'], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } });
      this.appWatcher = watcher;
      watcher.stdout.on('data', (data) => {
        if (this.appWatcher === watcher && /sink-input/.test(data.toString())) this.resolveAppStream();
      });
      watcher.on('error', () => {});
    } catch (error) {
      console.warn(`[SystemAudio] pactl subscribe unavailable, polling instead: ${error.message}`);
    }
    // Also polls, in case the event stream dies or is not supported.
    this.appPoll = setInterval(() => this.resolveAppStream(), this.appPollMs);
    this.appPoll.unref?.();
  }

  // Coalesces bursts of audio server events into one lookup at a time.
  resolveAppStream() {
    if (!this.appTarget) return Promise.resolve();
    if (this.appResolve) {
      this.appResolve.again = true;
      return this.appResolve.promise;
    }
    const target = this.appTarget;
    const job = { again: false };
    job.promise = (async () => {
      do {
        job.again = false;
        let inputs;
        try {
          inputs = await this.listInputs();
        } catch (error) {
          console.warn(`[SystemAudio] Could not list application streams: ${error.message}`);
          return;
        }
        if (this.appTarget !== target) return;
        const { index, ambiguous, streams } = pickStream(inputs, target);
        if (index !== null) {
          target.others = programStreams(inputs, target.id).filter((other) => other !== index);
        } else if (target.stream !== null && target.trusted) {
          // The chosen stream ended. Its index may come back as another tab's stream.
          target.others = [...new Set([...target.others, target.stream])];
          target.stream = null;
          target.lost = true;
        }
        const changed = ambiguous !== target.ambiguous || streams !== target.streams;
        target.ambiguous = ambiguous;
        target.streams = streams;
        if (index === target.recording && (index === null || this.captureProcess)) {
          if (changed) this.emitStatus();
          continue;
        }
        this.killParec();
        this.discardSpeech();
        target.recording = null;
        if (index !== null) {
          // Follows a restarted stream from now on.
          target.stream = index;
          target.trusted = true;
          target.lost = false;
          const input = inputs.find((entry) => entry.index === index);
          target.media = (input && distinctiveMedia(input)) || target.media;
          console.log(`[SystemAudio] Recording stream #${index} of ${target.name}`);
          if (this.spawnParec(['--monitor-stream', String(index)])) target.recording = index;
        } else if (ambiguous) {
          console.warn(`[SystemAudio] Cannot tell which of the ${streams} streams of ${target.name} is the call; waiting for a choice.`);
        }
        this.emitStatus();
      } while (job.again && this.appTarget === target);
    })().finally(() => {
      if (this.appResolve === job) this.appResolve = null;
    });
    this.appResolve = job;
    return job.promise;
  }

  killParec() {
    const captureProcess = this.captureProcess;
    this.captureProcess = null;
    try {
      captureProcess?.kill('SIGTERM');
    } catch (e) {
      console.error('[SystemAudio] Error stopping parec:', e);
    }
  }

  stopAppWatch() {
    clearInterval(this.appPoll);
    this.appPoll = null;
    try {
      this.appWatcher?.kill('SIGTERM');
    } catch {}
    this.appWatcher = null;
    this.appTarget = null;
    this.appResolve = null;
  }

  emitStatus() {
    this.emit('status', this.statusPayload());
  }

  statusPayload() {
    return {
      isCapturing: this.isCapturing,
      sink: this.currentSink,
      source: this.source,
      app: this.appTarget ? {
        id: this.appTarget.id,
        name: this.appTarget.name,
        stream: this.appTarget.stream,
        waiting: this.appTarget.recording === null,
        ambiguous: this.appTarget.ambiguous,
        streams: this.appTarget.streams,
      } : null,
    };
  }

  // The renderer owns the audio device; the engine only waits for pushPcm().
  startRendererCapture() {
    if (this.isCapturing) return true;
    this.currentSink = 'loopback';
    this.isCapturing = true;
    this.inSpeech = false;
    this.rendererLeftover = Buffer.alloc(0);
    this.clearSpeech();
    console.log('[SystemAudio] Waiting for system audio from the desktop renderer (loopback).');
    this.emitStatus();
    return true;
  }

  /** PCM16 mono 16 kHz from the renderer; ignored unless a renderer capture is active. */
  pushPcm(data) {
    if (this.source !== 'renderer' || !this.isCapturing || !data?.length) return;
    const combined = Buffer.concat([this.rendererLeftover, Buffer.from(data)]);
    const usable = combined.length - (combined.length % CHUNK_BYTES);
    for (let offset = 0; offset < usable; offset += CHUNK_BYTES) {
      this.processPcmChunk(combined.subarray(offset, offset + CHUNK_BYTES));
    }
    // Keep the tail, bounded so a stalled VAD can never grow the buffer.
    this.rendererLeftover = combined.subarray(usable, usable + CHUNK_BYTES);
  }

  /**
   * Analyzes a 16-bit mono PCM chunk for volume level & VAD speech segmentation.
   */
  processPcmChunk(chunk) {
    const numSamples = chunk.length / 2;
    if (numSamples === 0) return;
    if (this.abandonedUtteranceId) {
      if (this.inSpeech && this.utteranceId === this.abandonedUtteranceId) this.discardSpeech();
      this.abandonedUtteranceId = null;
    }

    let sumSquares = 0;
    for (let i = 0; i < chunk.length; i += 2) {
      const sample = chunk.readInt16LE(i);
      sumSquares += sample * sample;
    }

    const rms = Math.sqrt(sumSquares / numSamples);
    // Normalize to 0-100 percentage (assuming 16-bit max amplitude 32768)
    // Non-linear perceptual scaling
    const normalizedLevel = Math.min(100, Math.round((rms / 32768) * 450));

    this.emit('level', { level: normalizedLevel, rms: Math.round(rms) });

    const now = Date.now();
    const chunkDurationMs = (numSamples / this.sampleRate) * 1000;
    // Use a lower continuation threshold so quiet syllables after the onset
    // count as speech instead of being discarded with the silence tail.
    const threshold = this.inSpeech ? this.vadThreshold / 4 : this.vadThreshold;
    const isAboveThreshold = normalizedLevel >= threshold;

    if (isAboveThreshold) {
      if (!this.inSpeech) {
        this.inSpeech = true;
        this.speechStartTime = now;
        this.speechVoicedMs = 0;
        // Keep a short lead-in so quiet consonants are not clipped by the
        // volume threshold that starts the speech segment.
        const leadIn = Buffer.concat(this.preSpeechChunks);
        this.preSpeechChunks = [];
        const utteranceId = `${now}-${++this.nextSpeechId}`;
        this.utteranceId = utteranceId;
        this.speechTotalBytes = leadIn.length;
        // About once a second, the open ~3 s tail of the utterance is recognized again.
        this.speechChunker = new RollingAudio((part) => {
          this.emit(part.final ? 'speech_segment' : 'speech_chunk', {
            ...part,
            wavBuffer: part.wavBuffer ? Buffer.from(part.wavBuffer) : null,
            utteranceId,
            durationSec: (this.speechTotalBytes - this.trailingSilenceBytes)
              / (this.sampleRate * this.bytesPerSample),
            timestamp: Date.now(),
          });
        });
        this.speechChunker.push(leadIn, false);
        this.emit('speech_start', { utteranceId, timestamp: now });
        console.log(`[SystemAudio] 🎙️ Speech detected from PC (level: ${normalizedLevel}%)`);
      }
      this.speechVoicedMs += chunkDurationMs;
      this.trailingSilenceBytes = 0;
      this.flushedSilenceBytes = 0;
      this.speechTotalBytes += chunk.length;
      this.speechChunker.push(chunk, this.speechVoicedMs >= this.minSpeechMs);
      this.lastVoiceDetectedTime = now + chunkDurationMs;

      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
      if (this.silenceFlushTimer) clearTimeout(this.silenceFlushTimer);
      this.silenceFlushTimer = null;
    } else {
      if (this.inSpeech) {
        this.speechTotalBytes += chunk.length;
        this.trailingSilenceBytes += chunk.length;
        this.speechChunker.push(chunk, false);

        if (!this.silenceTimer) {
          // Recognition can overlap the pause. Only the existing final timer
          // ends the utterance and allows an AI response to begin.
          this.silenceFlushTimer = setTimeout(() => {
            this.silenceFlushTimer = null;
            if (this.inSpeech && this.speechVoicedMs >= this.minSpeechMs
              && this.speechChunker?.flushPending(this.trailingSilenceBytes)) {
              this.flushedSilenceBytes = this.trailingSilenceBytes;
            }
          }, Math.min(300, this.silenceMsThreshold / 2));
          this.silenceTimer = setTimeout(() => {
            this.finishSpeechSegment();
          }, this.silenceMsThreshold);
        }
      } else {
        this.preSpeechChunks.push(chunk);
        const maxPreSpeechChunks = Math.ceil(this.preSpeechBufferMs / chunkDurationMs);
        if (this.preSpeechChunks.length > maxPreSpeechChunks) {
          this.preSpeechChunks.splice(0, this.preSpeechChunks.length - maxPreSpeechChunks);
        }
      }
    }

    if (this.inSpeech) {
      const speechMs = (this.speechTotalBytes / (this.sampleRate * this.bytesPerSample)) * 1000;
      // Prefer splitting on a quieter chunk; force it if the audio never dips.
      if (speechMs >= this.maxSpeechMs * 1.5
        || (speechMs >= this.maxSpeechMs && normalizedLevel < this.vadThreshold)) {
        this.finishSpeechSegment();
      }
    }
  }

  /**
   * Ends an utterance whose transcription failed, so the audio that follows starts
   * a fresh one instead of being dropped until the next pause (which continuous
   * audio may never have). Deferred to the next chunk: callers may be inside an emit.
   */
  abandonSpeech(utteranceId) {
    if (this.inSpeech && utteranceId === this.utteranceId) this.abandonedUtteranceId = utteranceId;
  }

  /**
   * Finalizes the current speech segment and creates a WAV buffer for transcription.
   */
  finishSpeechSegment() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    if (!this.inSpeech || !this.speechChunker) return;

    const durationMs = ((this.speechTotalBytes - this.trailingSilenceBytes)
      / (this.sampleRate * this.channels * this.bytesPerSample)) * 1000;
    const valid = durationMs >= this.minSpeechMs && this.speechVoicedMs >= this.minSpeechMs;
    this.inSpeech = false;
    this.emit('speech_end', { utteranceId: this.utteranceId, timestamp: Date.now(), discarded: !valid });
    if (valid) this.speechChunker.finish(this.trailingSilenceBytes - this.flushedSilenceBytes);
    this.clearSpeech();
  }

  clearSpeech() {
    if (this.silenceFlushTimer) clearTimeout(this.silenceFlushTimer);
    this.silenceFlushTimer = null;
    this.flushedSilenceBytes = 0;
    this.speechChunker = null;
    this.preSpeechChunks = [];
    this.speechTotalBytes = 0;
    this.utteranceId = null;
    this.speechStartTime = null;
    this.lastVoiceDetectedTime = null;
    this.speechVoicedMs = 0;
    this.trailingSilenceBytes = 0;
  }

  discardSpeech() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    if (this.inSpeech) {
      this.emit('speech_end', { utteranceId: this.utteranceId, timestamp: Date.now(), discarded: true });
    }
    this.inSpeech = false;
    this.clearSpeech();
  }

  /**
   * Helper to write a 44-byte standard RIFF WAV header for raw PCM data.
   */
  static createWavBuffer(pcmBuffer, sampleRate = 16000, numChannels = 1, bitsPerSample = 16) {
    const header = Buffer.alloc(44);
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = pcmBuffer.length;
    const fileSize = 36 + dataSize;

    // RIFF header
    header.write('RIFF', 0);
    header.writeUInt32LE(fileSize, 4);
    header.write('WAVE', 8);

    // fmt subchunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // Subchunk1Size for PCM
    header.writeUInt16LE(1, 20); // AudioFormat 1 = PCM
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);

    // data subchunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
  }

  // `quiet` skips the status event when a new capture starts right after.
  stopCapture({ quiet = false } = {}) {
    this.discardSpeech();
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.stopAppWatch();
    this.killParec();

    this.isCapturing = false;
    this.inSpeech = false;
    this.abandonedUtteranceId = null;
    this.rendererLeftover = Buffer.alloc(0);
    this.preSpeechChunks = [];
    this.speechStartTime = null;
    this.lastVoiceDetectedTime = null;
    this.speechVoicedMs = 0;
    if (!quiet) this.emitStatus();
    console.log('[SystemAudio] PC loopback capture stopped.');
  }

  getStatus() {
    return {
      ...this.statusPayload(),
      vadThreshold: this.vadThreshold,
      silenceMsThreshold: this.silenceMsThreshold,
    };
  }
}

export const systemAudioEngine = new SystemAudioEngine();
