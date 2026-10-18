import test from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import { PassThrough } from 'node:stream';
import { listAudioStreams, parseSinkInputs, pickStream, sampleStreamLevels } from './audio-apps.js';
import { SystemAudioEngine } from './system-audio-engine.js';

const PACTL = `Sink Input #0
	Driver: module-ladspa-sink.c
	Corked: no
	Properties:
		media.name = "LADSPA Stream"
		media.role = "filter"

Sink Input #125
	Driver: protocol-native.c
	Corked: no
	Mute: no
	Volume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB
	        balance 0.00
	Properties:
		media.name = "AudioStream"
		application.name = "Zen"
		application.process.id = "1141"
		application.process.binary = "zen-bin"
	Format: pcm

Sink Input #130
	Corked: yes
	Properties:
		media.name = "ZOOM VoiceEngine"
		application.name = "ZOOM VoiceEngine"
		application.process.binary = "zoom"
		application.process.id = "2200"

Sink Input #131
	Corked: no
	Properties:
		media.name = "Playback \\"call\\""
		application.name = "ZOOM VoiceEngine"
		application.process.binary = "zoom"
`;

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('pactl streams are parsed and listed one by one', async () => {
  const inputs = parseSinkInputs(PACTL);
  assert.deepEqual(inputs.map((input) => input.index), [0, 125, 130, 131]);
  assert.equal(inputs[1].props['application.process.binary'], 'zen-bin');
  assert.equal(inputs[2].corked, true);
  assert.equal(inputs[3].props['media.name'], 'Playback "call"');
  assert.equal(inputs[1].props.Format, undefined, 'lines after the properties are not properties');

  const streams = await listAudioStreams({
    list: async () => inputs,
    title: async (pid) => (pid === '1141' ? 'Meet - Daily — Zen Browser' : null),
    levels: async (indices) => Object.fromEntries(indices.map((index) => [index, index === 131 ? 40 : 0])),
  });
  assert.deepEqual(streams, [
    { id: 'zen-bin', stream: 125, name: 'Zen', media: null, window: 'Meet - Daily — Zen Browser', playing: true, level: 0, siblings: 1 },
    { id: 'zoom', stream: 131, name: 'ZOOM VoiceEngine', media: 'Playback "call"', window: null, playing: true, level: 40, siblings: 2 },
    { id: 'zoom', stream: 130, name: 'ZOOM VoiceEngine', media: null, window: null, playing: false, level: 0, siblings: 2 },
  ]);
});

test('another stream of the same program is never taken by guess', () => {
  const inputs = parseSinkInputs(PACTL);
  assert.deepEqual(pickStream(inputs, { id: 'zoom', stream: 130 }), { index: 130, ambiguous: false, streams: 2 });
  assert.deepEqual(pickStream(inputs, { id: 'zoom', stream: 99 }), { index: null, ambiguous: true, streams: 2 },
    'the chosen stream ended and two remain: ask, do not pick the newest');
  assert.deepEqual(pickStream(inputs, { id: 'zoom', stream: 99, media: 'Playback "call"' }), { index: 131, ambiguous: false, streams: 2 },
    'the same distinctive media name identifies the restarted stream');
  assert.deepEqual(pickStream(inputs, { id: 'zen-bin', stream: 7 }), { index: 125, ambiguous: false, streams: 1 },
    'a single new stream is the restarted one');
  assert.deepEqual(pickStream(inputs, { id: 'zen-bin', stream: null, others: [125], lost: true }),
    { index: null, ambiguous: true, streams: 1 },
    'a tab that was already playing beside the call is not the call coming back');
  assert.deepEqual(pickStream(inputs, { id: 'zoom', stream: null, media: 'Playback "call"', others: [130, 131], lost: true }),
    { index: null, ambiguous: true, streams: 2 }, 'not even with the same media name');
  assert.deepEqual(pickStream(inputs, { id: 'teams' }), { index: null, ambiguous: false, streams: 0 });
});

test('a stream index saved by an earlier run needs the same distinctive media name', () => {
  const inputs = parseSinkInputs(PACTL);
  assert.deepEqual(pickStream(inputs, { id: 'zoom', stream: 130, trusted: false }), { index: null, ambiguous: true, streams: 2 },
    'the index may belong to another stream now');
  assert.deepEqual(pickStream(inputs, { id: 'zoom', stream: 131, media: 'Playback "call"', trusted: false }),
    { index: 131, ambiguous: false, streams: 2 });
  assert.deepEqual(pickStream(inputs, { id: 'zoom', stream: 130, media: 'Playback "call"', trusted: false }),
    { index: 131, ambiguous: false, streams: 2 }, 'the media name finds the stream under its new index');
  assert.deepEqual(pickStream(inputs, { id: 'zen-bin', stream: 125, trusted: false }), { index: 125, ambiguous: false, streams: 1 },
    'the program\'s only stream');
});

test('stream levels come from a short parec sample of each stream', async () => {
  const spawned = [];
  const levels = await sampleStreamLevels([5, 6], {
    ms: 20,
    spawnProcess: (command, args) => {
      const child = fakeProcess();
      spawned.push(args);
      const loud = Buffer.alloc(1600);
      for (let i = 0; i < 1600; i += 2) loud.writeInt16LE(args[1] === '5' ? 8000 : 0, i);
      setTimeout(() => child.stdout.write(loud), 1);
      return child;
    },
  });
  assert.deepEqual(spawned.map((args) => args.slice(0, 2)), [['--monitor-stream', '5'], ['--monitor-stream', '6']]);
  assert.ok(levels[5] > 90);
  assert.equal(levels[6], 0);
});

function fakeProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  return child;
}

test('an application capture waits for its stream and follows it when it changes', async (t) => {
  let streams = [];
  const spawned = [];
  const engine = new SystemAudioEngine({
    source: 'parec',
    appPollMs: 10000,
    listInputs: async () => parseSinkInputs(streams.map((index) => `Sink Input #${index}\n\tCorked: no\n\tProperties:\n\t\tapplication.name = "Zoom"\n\t\tapplication.process.binary = "zoom"\n`).join('\n')),
    spawnProcess: (command, args) => {
      const child = fakeProcess();
      spawned.push({ command, args, child });
      return child;
    },
  });
  const statuses = [];
  engine.on('status', (status) => statuses.push(status));
  t.after(() => engine.stopCapture());
  const parecs = () => spawned.filter((entry) => entry.command === 'parec');
  const watcher = () => spawned.find((entry) => entry.command === 'pactl').child;

  engine.startCapture({ app: { id: 'zoom', name: 'Zoom' } });
  await tick(5);
  assert.equal(parecs().length, 0, 'nothing to record before the call starts');
  assert.deepEqual(statuses.at(-1).app, { id: 'zoom', name: 'Zoom', stream: null, waiting: true, ambiguous: false, streams: 0 });
  assert.equal(statuses.at(-1).isCapturing, true);

  streams = [40];
  watcher().stdout.write("Event 'new' on sink-input #40\n");
  await tick(5);
  assert.deepEqual(parecs()[0].args.slice(0, 2), ['--monitor-stream', '40']);
  assert.equal(statuses.at(-1).app.waiting, false);

  streams = [40, 41];
  watcher().stdout.write("Event 'new' on sink-input #41\n");
  await tick(5);
  assert.equal(parecs().length, 1, 'a second stream does not steal the capture');

  assert.equal(statuses.at(-1).app.streams, 2);

  streams = [41];
  parecs()[0].child.emit('close', 0);
  await tick(5);
  assert.equal(parecs().length, 1, 'the stream that played beside the call is another tab, not the call');
  assert.equal(statuses.at(-1).app.ambiguous, true);
  assert.equal(statuses.at(-1).app.waiting, true);
  assert.equal(engine.getStatus().isCapturing, true);

  streams = [41, 40];
  watcher().stdout.write("Event 'new' on sink-input #40\n");
  await tick(5);
  assert.equal(parecs().length, 1, 'the ended index, reused, is not taken for the call either');

  streams = [41, 40, 44];
  watcher().stdout.write("Event 'new' on sink-input #44\n");
  await tick(5);
  assert.deepEqual(parecs()[1].args.slice(0, 2), ['--monitor-stream', '44'], 'the one new stream is the restarted call');
  assert.equal(statuses.at(-1).app.ambiguous, false);

  streams = [42, 43];
  parecs()[1].child.emit('close', 0);
  await tick(5);
  assert.equal(parecs().length, 2, 'two candidates: nothing is recorded by guess');
  assert.equal(statuses.at(-1).app.ambiguous, true);
  assert.equal(statuses.at(-1).app.waiting, true);

  engine.startCapture({ app: { id: 'zoom', name: 'Zoom', stream: 43, fresh: true } });
  await tick(5);
  assert.deepEqual(parecs()[2].args.slice(0, 2), ['--monitor-stream', '43'], 'choosing a stream resolves it');
  assert.equal(statuses.at(-1).app.ambiguous, false);

  engine.stopCapture();
  assert.ok(watcher().killed);
  assert.ok(parecs()[2].child.killed);
  assert.equal(statuses.at(-1).isCapturing, false);
  assert.equal(statuses.at(-1).app, null);
});

test('a stream saved by an earlier run is not resumed when its index may belong to another tab', async (t) => {
  const spawned = [];
  const engine = new SystemAudioEngine({
    source: 'parec',
    appPollMs: 10000,
    listInputs: async () => parseSinkInputs([50, 51].map((index) => `Sink Input #${index}\n\tCorked: no\n\tProperties:\n\t\tmedia.name = "AudioStream"\n\t\tapplication.name = "Zen"\n\t\tapplication.process.binary = "zen-bin"\n`).join('\n')),
    spawnProcess: (command, args) => {
      const child = fakeProcess();
      spawned.push({ command, args, child });
      return child;
    },
  });
  t.after(() => engine.stopCapture());
  const parecs = () => spawned.filter((entry) => entry.command === 'parec');

  engine.startCapture({ app: { id: 'zen-bin', name: 'Zen', stream: 50, media: null } });
  await tick(5);
  assert.equal(parecs().length, 0, 'a generic media name cannot confirm the saved index');
  assert.equal(engine.getStatus().app.ambiguous, true);

  engine.startCapture({ app: { id: 'zen-bin', name: 'Zen', stream: 50, media: null, fresh: true } });
  await tick(5);
  assert.deepEqual(parecs()[0].args.slice(0, 2), ['--monitor-stream', '50'], 'a pick from the list just shown is trusted');
});
