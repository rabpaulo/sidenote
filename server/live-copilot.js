// Answers a consolidated utterance and, when `speculate()` allows it, the speech
// so far: a preview starts with each longer partial and replaces the previous one,
// so a suggestion is on screen before the question ends. Only providers whose
// cancelled turns cost no cold start may speculate; the others answer finals only,
// since a partial would make the complete question wait behind obsolete work.
export const MIN_PREVIEW_WORDS = 4;

const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;

export function createLiveCopilot({ start, enabled = () => true, canStart = () => true, speculate = () => false,
  onFinalized = () => {}, onDiscarded = () => {} }) {
  const entries = new Map();
  const superseded = new Set();
  let running = null;
  let timer = null;

  function eligible(entry) {
    if (entry.text === entry.sentText) return false;
    return entry.final || (speculate() && wordCount(entry.text) >= MIN_PREVIEW_WORDS);
  }

  function latestPending() {
    return [...entries.values()].reverse().find(eligible);
  }

  function retire(entry) {
    entries.delete(entry.id);
    superseded.add(entry.id);
    if (superseded.size > 64) superseded.delete(superseded.values().next().value);
    onDiscarded(entry.id);
  }

  // A preview answers text that has since grown; a complete answer is never replaced.
  function outdatedPreview() {
    return running && running.preview && speculate() && latestPending();
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!enabled()) return;
    if (outdatedPreview()) {
      const job = running;
      running = null;
      job.handle?.kill();
    }
    if (running) return;
    const next = latestPending();
    if (!next) return;
    timer = setTimeout(drain, 0);
  }

  function drain() {
    timer = null;
    if (running || !enabled()) return;
    if (!canStart()) { timer = setTimeout(drain, 500); return; }
    const entry = latestPending();
    if (!entry) return;
    // Once the model falls behind, answer the current question rather than
    // serially generating obsolete snapshots. The transcript history stays intact.
    // A preview leaves earlier complete questions waiting until its own final.
    if (entry.final) {
      for (const older of [...entries.values()]) {
        if (older === entry) break;
        retire(older);
      }
    }
    entry.sentText = entry.text;
    const job = { entry, handle: null, preview: !entry.final };
    running = job;
    const settle = () => {
      if (running !== job) return;
      running = null;
      if (entry.final && entry.text === entry.sentText) {
        entries.delete(entry.id);
        onFinalized(entry.id);
      }
      schedule();
    };
    try {
      job.handle = start({ text: entry.sentText, utteranceId: entry.id,
        isPreview: () => !entry.final || entry.text !== entry.sentText, onSettled: settle });
    } catch { settle(); }
  }

  function cancel(utteranceId) {
    const selected = utteranceId ? entries.get(utteranceId) : null;
    const discarded = utteranceId ? (selected ? [selected] : []) : [...entries.values()];
    if (utteranceId) entries.delete(utteranceId);
    else entries.clear();
    if (running && (!utteranceId || running.entry === selected)) {
      const job = running;
      running = null;
      job.handle?.kill();
    }
    for (const entry of discarded) onDiscarded(entry.id);
    schedule();
  }

  function update(text, utteranceId, final = false) {
    if (!enabled() || !text?.trim()) return;
    const id = utteranceId || 'legacy';
    if (superseded.has(id)) return;
    let entry = entries.get(id);
    if (!entry) {
      entry = { id, text: '', sentText: null, final: false };
      entries.set(id, entry);
      // Bounded pending context when the provider cannot keep up with speakers.
      if (entries.size > 4) {
        const oldestPending = [...entries.values()].find((candidate) => candidate !== running?.entry && candidate !== entry);
        if (oldestPending) retire(oldestPending);
      }
    }
    entry.text = text.trim();
    entry.final = final;
    if (final && entry.text === entry.sentText) {
      // The preview already answered the complete question: it becomes the answer.
      if (running?.entry === entry) running.preview = false;
      else {
        onFinalized(id);
        entries.delete(id);
      }
    }
    schedule();
  }

  return { partial: (text, id) => update(text, id), final: (text, id) => update(text, id, true), cancel };
}
