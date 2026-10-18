import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
const EXEC_TIMEOUT_MS = 1500;

/**
 * Parses `pactl list sink-inputs`: one entry per stream an application is playing.
 * The text format is used instead of `-f json`, which older pactl versions lack.
 */
export function parseSinkInputs(output) {
  const inputs = [];
  let current = null;
  let inProperties = false;
  for (const line of String(output || '').split('\n')) {
    const header = line.match(/^Sink Input #(\d+)/);
    if (header) {
      current = { index: Number(header[1]), corked: false, props: {} };
      inputs.push(current);
      inProperties = false;
      continue;
    }
    if (!current) continue;
    const corked = line.match(/^\s+Corked:\s*(\S+)/);
    if (corked) current.corked = corked[1] === 'yes';
    if (/^\s+Properties:/.test(line)) {
      inProperties = true;
      continue;
    }
    const property = inProperties && line.match(/^\s+([\w.-]+) = "(.*)"$/);
    if (property) current.props[property[1]] = property[2].replace(/\\"/g, '"');
    else if (inProperties && /^\s\S/.test(line)) inProperties = false;
  }
  return inputs;
}

// Streams of the same program share a key, so a call that restarts its stream is followed.
export function streamKey(input) {
  return input.props['application.process.binary'] || input.props['application.name'] || null;
}

// Streams that belong to an application (not filters or loopbacks of the audio server).
export function appStreams(inputs) {
  return inputs.filter((input) => streamKey(input) && input.props['media.role'] !== 'filter'
    && input.props['media.role'] !== 'abstract');
}

const GENERIC_MEDIA_NAMES = new Set(['AudioStream', 'Playback', 'playback', 'audio stream', 'Audio Stream']);

export function distinctiveMedia(input) {
  const media = input.props['media.name'];
  return media && !GENERIC_MEDIA_NAMES.has(media) && media !== input.props['application.name'] ? media : null;
}

// Indices of the streams one program is playing.
export function programStreams(inputs, id) {
  return appStreams(inputs).filter((input) => streamKey(input) === id).map((input) => input.index);
}

/**
 * The stream to record for the chosen one. A browser plays every tab under the same
 * program, so another stream is taken only if it is unambiguous, instead of
 * transcribing a video in another tab:
 * - `stream` counts when it still exists. An index that is not `trusted` (saved by
 *   an earlier run: PipeWire reuses indices) also needs the same distinctive media name.
 * - `others` were playing beside the chosen stream, so they are other tabs, never
 *   the call coming back. Of the rest, the only one with the chosen media name, or
 *   else the only one left, is taken.
 * - Otherwise `ambiguous` asks the user to choose, when the program plays anything
 *   and the chosen stream ended (now or earlier, `lost`) or several could be the call.
 */
export function pickStream(inputs, { id, stream = null, media = null, trusted = true, others = [], lost = false }) {
  const matching = appStreams(inputs).filter((input) => streamKey(input) === id);
  const result = (index, ambiguous = false) => ({ index, ambiguous, streams: matching.length });
  const chosen = stream === null ? null : matching.find((input) => input.index === stream);
  if (chosen && (trusted || (media && distinctiveMedia(chosen) === media))) return result(chosen.index);
  const known = new Set(others);
  const candidates = matching.filter((input) => !known.has(input.index));
  const sameMedia = media ? candidates.filter((input) => distinctiveMedia(input) === media) : [];
  if (sameMedia.length === 1) return result(sameMedia[0].index);
  if (candidates.length === 1) return result(candidates[0].index);
  const gone = trusted && stream !== null && !chosen;
  return result(null, matching.length > 0 && (lost || gone || candidates.length > 1));
}

export async function listSinkInputs() {
  const { stdout } = await run('pactl', ['list', 'sink-inputs'], { timeout: EXEC_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' } });
  return parseSinkInputs(stdout);
}

function parentPid(pid) {
  try {
    // Field 4 of /proc/<pid>/stat, after the parenthesized command name.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || null;
  } catch {
    return null;
  }
}

// Title of a visible X11 window of the process or of its parents (browsers play audio
// from a helper process). Best effort: Wayland windows and missing xdotool give null.
async function windowTitle(pid) {
  if (!pid || !process.env.DISPLAY) return null;
  for (let level = 0, current = Number(pid); current > 1 && level < 4; level++, current = parentPid(current)) {
    try {
      const { stdout } = await run('xdotool', ['search', '--onlyvisible', '--pid', String(current)], { timeout: EXEC_TIMEOUT_MS });
      // Helper windows have short names like "Zen"; the main window names its page.
      let best = '';
      for (const id of stdout.split('\n').filter(Boolean).slice(0, 8)) {
        const { stdout: name } = await run('xdotool', ['getwindowname', id], { timeout: EXEC_TIMEOUT_MS });
        if (name.trim().length > best.length) best = name.trim();
      }
      if (best) return best;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
    }
  }
  return null;
}

// Loudest 50 ms of each stream during a short sample, on the meters' 0-100 scale.
// Streams of one browser look identical; what is making sound now tells the call apart.
export function sampleStreamLevels(indices, { ms = 600, spawnProcess = spawn } = {}) {
  return Promise.all(indices.map((index) => new Promise((resolve) => {
    let peak = 0;
    let child = null;
    let done = false;
    let leftover = Buffer.alloc(0);
    const finish = () => {
      if (done) return;
      done = true;
      try { child?.kill('SIGTERM'); } catch {}
      resolve([index, peak]);
    };
    try {
      child = spawnProcess('parec', ['--monitor-stream', String(index), '--rate', '16000', '--channels', '1', '--format', 's16le'],
        { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      finish();
      return;
    }
    child.stdout.on('data', (data) => {
      const combined = Buffer.concat([leftover, data]);
      const usable = combined.length - (combined.length % 1600);
      for (let offset = 0; offset < usable; offset += 1600) {
        let sum = 0;
        for (let i = offset; i < offset + 1600; i += 2) sum += combined.readInt16LE(i) ** 2;
        peak = Math.max(peak, Math.min(100, Math.round((Math.sqrt(sum / 800) / 32768) * 450)));
      }
      leftover = combined.subarray(usable);
    });
    child.on('error', finish);
    child.on('close', finish);
    setTimeout(finish, ms).unref?.();
  }))).then((pairs) => Object.fromEntries(pairs));
}

/**
 * Streams being played now, one row each, for the capture source picker. Rows of the
 * same program share `id` and are told apart by `stream` (its index), media name,
 * whether they are paused and how loud they are right now.
 */
export async function listAudioStreams({ list = listSinkInputs, title = windowTitle, levels = sampleStreamLevels } = {}) {
  const streams = appStreams(await list());
  const titles = new Map();
  await Promise.all([...new Set(streams.map((input) => input.props['application.process.id']).filter(Boolean))].map(async (pid) => {
    titles.set(pid, await title(pid).catch(() => null));
  }));
  const loudness = await levels(streams.map((input) => input.index)).catch(() => ({}));
  const perApp = new Map();
  for (const input of streams) perApp.set(streamKey(input), (perApp.get(streamKey(input)) || 0) + 1);
  return streams.map((input) => ({
    id: streamKey(input),
    stream: input.index,
    name: input.props['application.name'] || streamKey(input),
    media: distinctiveMedia(input),
    window: titles.get(input.props['application.process.id']) || null,
    playing: !input.corked,
    level: loudness[input.index] ?? null,
    siblings: perApp.get(streamKey(input)),
  })).sort((a, b) => Number(b.playing) - Number(a.playing) || a.name.localeCompare(b.name) || a.stream - b.stream);
}
