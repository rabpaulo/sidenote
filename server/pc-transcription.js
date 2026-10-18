import { RollingTranscription } from '../shared/rolling-transcription.js';
import { createUtteranceLanguage } from '../shared/language.js';
import { MIN_PREVIEW_WORDS } from './live-copilot.js';

// Auto language detection needs a few words: a one-second tail ("Como") is not
// allowed to lock the utterance to a language.
const MIN_DETECTION_MS = 1500;
const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;

// Partials reach the screen as they come (about every second), but the live
// responder gets one that could start a preview at most every `copilotPartialMs`,
// except at a pause: each one restarts the preview, and with Antigravity a
// cancelled preview costs a process that takes about 4 s to replace.
// `concurrency()` is how many requests of one utterance may run at once (see
// RollingTranscription): Google answers in parallel, a local engine one at a time.
export function wirePcTranscription(engine, { transcribe, getLanguage, broadcast, onFinal, onPartial = () => {}, onCancel = () => {},
  copilotPartialMs = 2000, concurrency = () => 3 }) {
  const sessions = new Map();
  let lastLanguage = null;
  // Requests run concurrently, so a short utterance can be recognized before the
  // long one ahead of it; results are still announced in the order they were spoken.
  let lastAnnounced = Promise.resolve();

  function sessionFor(chunk) {
    if (sessions.has(chunk.utteranceId)) return sessions.get(chunk.utteranceId);
    const language = createUtteranceLanguage(getLanguage(), lastLanguage);
    const previous = lastAnnounced;
    let announced;
    lastAnnounced = new Promise((resolve) => { announced = resolve; });
    const inOrder = (announce) => previous.then(() => {
      if (!session.cancelled || announce.always) announce();
      announced();
    });
    let lastForward = -Infinity;
    let forwardTimer = null;
    let held = null;
    const forward = (text, paced) => {
      clearTimeout(forwardTimer);
      forwardTimer = null;
      held = null;
      if (paced) lastForward = Date.now();
      onPartial(text, chunk.utteranceId);
    };
    const session = new RollingTranscription({
      maxInFlight: concurrency(),
      transcribe: async (wav, signal, part) => {
        const result = await transcribe(wav, language.request, { signal });
        return part.final || part.kind === 'commit' || part.durationMs >= MIN_DETECTION_MS ? language.observe(result) : result;
      },
      onPartial: (text, part) => {
        broadcast({ type: 'pc_speech_partial', text, utteranceId: chunk.utteranceId, timestamp: Date.now() });
        // Too short for a preview: only the notes lookup uses it.
        if (wordCount(text) < MIN_PREVIEW_WORDS) return forward(text, false);
        const wait = lastForward + copilotPartialMs - Date.now();
        if (part.pause || wait <= 0) return forward(text, true);
        held = text;
        forwardTimer ||= setTimeout(() => forward(held, true), wait);
      },
      onFinal: (text) => inOrder(() => {
        if (language.detected) lastLanguage = language.detected;
        broadcast({ type: 'pc_speech_transcribed', text, language: language.detected, utteranceId: chunk.utteranceId, durationSec: session.durationSec, timestamp: Date.now() });
        onFinal(text, chunk.utteranceId);
      }),
      onError: (error) => {
        // Without this, a long utterance keeps feeding the failed session and
        // nothing more is transcribed until the PC audio goes quiet.
        engine.abandonSpeech?.(chunk.utteranceId);
        inOrder(Object.assign(() => {
          broadcast({ type: 'pc_speech_error', error, utteranceId: chunk.utteranceId });
          onCancel(chunk.utteranceId);
        }, { always: true }));
      },
    });
    session.done.then((result) => {
      clearTimeout(forwardTimer);
      // A cancelled utterance has nothing to announce; the next one need not wait.
      if (result.cancelled) announced();
    });
    sessions.set(chunk.utteranceId, session);
    if (sessions.size > 4) {
      session.fail('O serviço de transcrição não está acompanhando as falas. Tente novamente.');
    }
    // Keep failed utterances until their final marker, so later chunks cannot
    // accidentally resurrect an incomplete transcript and send it to the agent.
    return session;
  }

  engine.on('speech_start', (event) => broadcast({ type: 'pc_speech_start', ...event }));
  engine.on('speech_end', (event) => {
    broadcast({ type: 'pc_speech_end', ...event });
    if (event.discarded) {
      sessions.get(event.utteranceId)?.cancel();
      onCancel(event.utteranceId);
      sessions.delete(event.utteranceId);
    }
  });
  engine.on('speech_chunk', (chunk) => sessionFor(chunk).push(chunk));
  engine.on('speech_segment', (chunk) => {
    const session = sessionFor(chunk);
    session.durationSec = chunk.durationSec;
    if (!session.cancelled) broadcast({ type: 'pc_speech_processing', durationSec: chunk.durationSec, utteranceId: chunk.utteranceId });
    session.push({ ...chunk, final: true });
    session.done.then(() => sessions.delete(chunk.utteranceId));
  });

  function cancel() {
    for (const [id, session] of sessions) { session.cancel(); onCancel(id); }
    sessions.clear();
  }
  engine.on('status', (status) => {
    if (!status.isCapturing) cancel();
  });
  return { cancel };
}
