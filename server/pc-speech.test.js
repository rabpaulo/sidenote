import test from 'node:test';
import assert from 'node:assert/strict';
import { SystemAudioEngine } from './system-audio-engine.js';
import { wirePcTranscription } from './pc-transcription.js';

function pipeline(transcribeAudioBuffer, autoRespond = true) {
  const engine = new SystemAudioEngine();
  const events = [];
  const prompts = [];
  const transcription = wirePcTranscription(engine, {
    transcribe: transcribeAudioBuffer,
    getLanguage: () => 'pt-BR',
    broadcast: (event) => events.push(event),
    onFinal: (text) => { if (autoRespond) prompts.push(text); },
  });
  return { engine, events, prompts, transcription };
}

function pcm(amplitude) {
  const buffer = Buffer.alloc(1600);
  for (let offset = 0; offset < buffer.length; offset += 2) buffer.writeInt16LE(amplitude, offset);
  return buffer;
}

test('PC speech goes through transcription and automatically reaches the model', async () => {
  const app = pipeline(async (wav, language) => {
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(language, 'pt-BR');
    return { text: ' Como resolvo esse problema? ' };
  });
  app.engine.processPcmChunk(pcm(1100));
  for (let frame = 0; frame < 20; frame += 1) app.engine.processPcmChunk(pcm(500));
  app.engine.finishSpeechSegment();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(app.prompts, ['Como resolvo esse problema?']);
  assert.deepEqual(app.events.map((event) => event.type), ['pc_speech_start', 'pc_speech_end', 'pc_speech_processing', 'pc_speech_transcribed']);
});

for (const [name, result] of [
  ['recognition failure', async () => ({ error: 'Não foi possível entender o áudio' })],
  ['empty recognition', async () => ({ text: ' ' })],
  ['unexpected exception', async () => { throw new Error('Serviço indisponível'); }],
]) {
  test(`${name} always finishes with an explicit PC error`, async () => {
    const app = pipeline(result);
    app.engine.emit('speech_segment', { wavBuffer: Buffer.alloc(44), durationSec: 1, timestamp: Date.now() });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(app.events.map((event) => event.type), ['pc_speech_processing', 'pc_speech_error']);
    assert.ok(app.events[1].error);
    assert.equal(app.prompts.length, 0);
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('PC speech exposes recognized partials to the live responder before any silence', async () => {
  const engine = new SystemAudioEngine();
  const prompts = [];
  const transcription = wirePcTranscription(engine, {
    transcribe: async () => ({ text: 'Como resolvo esse problema no servidor?' }),
    getLanguage: () => 'pt-BR', broadcast() {},
    onPartial: (text, utteranceId) => prompts.push({ text, utteranceId }),
    onFinal() {},
  });
  for (let frame = 0; frame < 60; frame++) engine.processPcmChunk(pcm(4000));
  await tick();
  assert.equal(engine.inSpeech, true);
  assert.equal(prompts.length, 1, 'the live responder must receive text while the PC is still speaking');
  assert.equal(prompts[0].utteranceId, engine.utteranceId);
  engine.stopCapture();
  transcription.cancel();
});

// Each request covers the open segment, so a longer one hears more of the question.
const bySeconds = (texts) => async (wav) => {
  const seconds = (wav.length - 44) / 32000;
  const reached = Object.keys(texts).map(Number).filter((limit) => seconds >= limit);
  return texts[Math.max(...reached)] ?? { error: 'Não foi possível entender o áudio', code: 'unrecognized' };
};

test('PC starts recognition while speaking and only responds after the pause', async () => {
  let calls = 0;
  const recognize = bySeconds({ 1: { text: 'Como' }, 2: { text: 'Como resolvo esse problema' }, 4: { text: 'Como resolvo esse problema no servidor?' } });
  const app = pipeline((wav) => { calls++; return recognize(wav); });
  for (let frame = 0; frame < 60; frame++) app.engine.processPcmChunk(pcm(4000));
  await tick();
  assert.equal(app.engine.inSpeech, true);
  assert.equal(calls, 3, 'one recognition per second of speech');
  assert.deepEqual(app.events.filter((event) => event.type === 'pc_speech_partial').map((event) => event.text),
    ['Como', 'Como resolvo esse problema']);
  assert.deepEqual(app.prompts, []);
  for (let frame = 0; frame < 20; frame++) app.engine.processPcmChunk(pcm(4000));
  app.engine.finishSpeechSegment();
  await tick();
  assert.equal(calls, 4, 'the final reuses the tail that already covered the whole utterance');
  assert.deepEqual(app.prompts, ['Como resolvo esse problema no servidor?']);
  assert.equal(app.events.filter((event) => event.type === 'pc_speech_transcribed').length, 1);
});

test('stopping PC capture suppresses in-flight recognition and automatic responses', async () => {
  let complete;
  let signal;
  const app = pipeline((_, __, options) => {
    signal = options.signal;
    return new Promise((resolve) => { complete = resolve; });
  });
  for (let frame = 0; frame < 60; frame++) app.engine.processPcmChunk(pcm(4000));
  await tick();
  app.engine.stopCapture();
  assert.equal(signal.aborted, true);
  complete({ text: 'Resultado antigo' });
  await tick();
  assert.equal(app.events.filter((event) => event.type === 'pc_speech_partial').length, 0);
  assert.deepEqual(app.prompts, []);
});

test('a recognizer that keeps failing ends the utterance with one explicit error', async () => {
  const app = pipeline(async () => ({ error: 'Sem conexão' }));
  for (let frame = 0; frame < 60; frame++) app.engine.processPcmChunk(pcm(4000));
  await tick();
  assert.deepEqual(app.events.filter((event) => event.type === 'pc_speech_error'), [], 'the next tail may still succeed');
  app.engine.finishSpeechSegment();
  await tick();
  const errors = app.events.filter((event) => event.type === 'pc_speech_error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error, 'Sem conexão');
  assert.deepEqual(app.prompts, []);
});

test('a failed tail does not interrupt the utterance: the next one covers the same audio', async () => {
  let calls = 0;
  const app = pipeline(async () => (++calls === 1 ? { error: 'Sem conexão' } : { text: 'Qual é a sua experiência?' }));
  for (let frame = 0; frame < 60; frame++) app.engine.processPcmChunk(pcm(4000));
  await tick();
  app.engine.finishSpeechSegment();
  await tick();
  assert.equal(app.events.filter((event) => event.type === 'pc_speech_start').length, 1);
  assert.deepEqual(app.events.filter((event) => event.type === 'pc_speech_error'), []);
  assert.deepEqual(app.prompts, ['Qual é a sua experiência?']);
});

test('continuous PC audio without pauses is split so it still reaches the agent', async () => {
  const app = pipeline(async () => ({ text: 'Trecho do vídeo' }));
  app.engine.maxSpeechMs = 3000;
  // 10 s of uninterrupted audio and no silence at the end.
  for (let frame = 0; frame < 200; frame++) {
    app.engine.processPcmChunk(pcm(frame % 20 === 0 ? 1000 : 4000));
    if (frame % 20 === 0) await tick();
  }
  await tick();
  assert.ok(app.prompts.length >= 2, `expected split utterances, got ${app.prompts.length}`);
  assert.ok(app.events.filter((event) => event.type === 'pc_speech_start').length >= 3);
});

test('manual mode still transcribes live without automatically invoking the agent', async () => {
  const app = pipeline(async () => ({ text: 'Pergunta da reunião' }), false);
  for (let frame = 0; frame < 60; frame++) app.engine.processPcmChunk(pcm(4000));
  await tick();
  app.engine.finishSpeechSegment();
  await tick();
  assert.equal(app.events.filter((event) => event.type === 'pc_speech_partial').length, 1);
  assert.equal(app.events.filter((event) => event.type === 'pc_speech_transcribed').length, 1);
  assert.deepEqual(app.prompts, []);
});

test('consecutive turns are recognized concurrently, announced in order, each in its own language', async () => {
  const engine = new SystemAudioEngine();
  const requests = [];
  const finals = [];
  let language = 'pt-BR';
  wirePcTranscription(engine, {
    getLanguage: () => language,
    transcribe: (_, lang) => new Promise((resolve) => requests.push({ resolve, lang })),
    broadcast() {}, onFinal: (text) => finals.push(text),
  });
  engine.emit('speech_segment', { utteranceId: 'a', sequence: 0, wavBuffer: Buffer.alloc(44), durationSec: 1 });
  language = 'en-US';
  engine.emit('speech_segment', { utteranceId: 'b', sequence: 0, wavBuffer: Buffer.alloc(44), durationSec: 1 });
  await tick();
  assert.deepEqual(requests.map((request) => request.lang), ['pt-BR', 'en-US']);
  requests[1].resolve({ text: 'Second turn' });
  await tick();
  assert.deepEqual(finals, [], 'the second turn waits for the first');
  requests[0].resolve({ text: 'Primeira fala' });
  await tick();
  assert.deepEqual(finals, ['Primeira fala', 'Second turn']);
});

test('unrecognized short tails do not reject the phrase once more audio is heard', async () => {
  const app = pipeline(bySeconds({ 3.9: { text: 'Como resolvo esse problema no servidor?' } }));
  for (let frame = 0; frame < 60; frame++) app.engine.processPcmChunk(pcm(4000));
  await tick();
  for (let frame = 0; frame < 20; frame++) app.engine.processPcmChunk(pcm(4000));
  app.engine.finishSpeechSegment();
  await tick();
  assert.deepEqual(app.events.filter((event) => event.type === 'pc_speech_error'), []);
  assert.deepEqual(app.prompts, ['Como resolvo esse problema no servidor?']);
});

test('an unrecognized newer tail keeps the words already recognized', async () => {
  const app = pipeline(bySeconds({ 1: { text: 'Como' }, 2: { text: 'Como resolvo esse problema' }, 3: { error: 'x', code: 'unrecognized' } }));
  for (let frame = 0; frame < 80; frame++) {
    app.engine.processPcmChunk(pcm(4000));
    await tick();
  }
  app.engine.finishSpeechSegment();
  await tick();
  assert.deepEqual(app.events.filter((event) => event.type === 'pc_speech_partial').map((event) => event.text),
    ['Como', 'Como resolvo esse problema']);
  assert.deepEqual(app.prompts, ['Como resolvo esse problema']);
  assert.equal(app.events.filter((event) => event.type === 'pc_speech_error').length, 0);
});

test('unrecognized audio stays bounded and cannot produce an incomplete agent prompt', async () => {
  let largest = 0;
  const app = pipeline(async (wav) => {
    largest = Math.max(largest, (wav.length - 44) / 32000);
    return { error: 'Não foi possível entender o áudio', code: 'unrecognized' };
  });
  for (let window = 0; window < 6; window++) {
    for (let frame = 0; frame < 60; frame++) app.engine.processPcmChunk(pcm(4000));
    await tick();
  }
  app.engine.finishSpeechSegment();
  await tick();
  assert.ok(largest <= 10);
  const errors = app.events.filter((event) => event.type === 'pc_speech_error');
  assert.ok(errors.length >= 1);
  assert.equal(new Set(errors.map((event) => event.utteranceId)).size, errors.length, 'one error per utterance');
  assert.deepEqual(app.prompts, []);
});

test('stopping capture discards unrecognized audio without an error or a prompt', async () => {
  let calls = 0;
  const app = pipeline(async () => {
    calls++;
    return { error: 'Não foi possível entender o áudio', code: 'unrecognized' };
  });
  for (let frame = 0; frame < 60; frame++) app.engine.processPcmChunk(pcm(4000));
  await tick();
  app.engine.stopCapture();
  await tick();
  assert.equal(calls, 3);
  assert.equal(app.events.filter((event) => event.type === 'pc_speech_error').length, 0);
  assert.deepEqual(app.prompts, []);
});

test('PC speech detects the language per utterance', async () => {
  const engine = new SystemAudioEngine();
  const events = [];
  const requests = [];
  const spoken = ['en-US', 'en-US', 'pt-BR'];
  wirePcTranscription(engine, {
    transcribe: async (wav, language) => {
      requests.push(language);
      const detected = spoken.shift();
      return { text: detected === 'en-US' ? 'tell me about yourself' : 'fale sobre você', language: detected };
    },
    getLanguage: () => 'auto',
    broadcast: (event) => events.push(event),
    onFinal: () => {},
  });
  const header = Buffer.alloc(44);
  // Two seconds of speech: enough words for the language to be decided.
  const window = (utteranceId, sequence, final) => ({ wavBuffer: Buffer.concat([header, pcm(500)]), utteranceId, sequence, durationMs: 2000, final });
  engine.emit('speech_chunk', window('a', 0, false));
  await tick();
  engine.emit('speech_segment', { ...window('a', 1), durationSec: 1 });
  await tick(); await tick(); await tick();
  engine.emit('speech_segment', { ...window('b', 0), durationSec: 1 });
  await tick(); await tick(); await tick();
  assert.deepEqual(requests, ['pt-BR,en-US', 'en-US', 'en-US,pt-BR']);
  assert.deepEqual(events.filter((event) => event.type === 'pc_speech_transcribed').map((event) => event.language), ['en-US', 'pt-BR']);
});

test('partials reach the screen as they come and the live responder at a steady pace', async () => {
  const engine = new SystemAudioEngine();
  const screen = [];
  const responder = [];
  let calls = 0;
  const texts = ['Como', 'Como você organiza o', 'Como você organiza o cache', 'Como você organiza o cache quando', 'Como você organiza o cache quando escala?'];
  const transcription = wirePcTranscription(engine, {
    transcribe: async () => ({ text: texts[calls++] }),
    getLanguage: () => 'pt-BR', copilotPartialMs: 60,
    broadcast: (event) => { if (event.type === 'pc_speech_partial') screen.push(event.text); },
    onPartial: (text) => responder.push(text), onFinal() {},
  });
  const send = (sequence, extra = {}) => engine.emit('speech_chunk', { utteranceId: 'a', kind: 'tail', segment: 0, sequence, wavBuffer: Buffer.alloc(46), ...extra });
  for (let sequence = 0; sequence < 4; sequence++) { send(sequence); await tick(); }
  assert.deepEqual(screen, texts.slice(0, 4));
  assert.deepEqual(responder, ['Como', 'Como você organiza o'], 'a short partial does not start the pacing window');
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.deepEqual(responder.slice(2), ['Como você organiza o cache quando'], 'only the latest text is sent when the window ends');
  send(4, { pause: true });
  await tick();
  assert.equal(responder.at(-1), 'Como você organiza o cache quando escala?', 'a pause is never held back');
  transcription.cancel();
});
