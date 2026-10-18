// Everything said in the current session, kept for the summary. Unlike the
// conversation memory used by live answers, nothing old is dropped: a summary
// must cover the whole meeting.
export const TRANSCRIPT_ROLES = ['interlocutor', 'user', 'assistant'];
const MAX_ENTRY_CHARS = 4000;

export function createSessionTranscript({ maxEntries = 3000, now = () => Date.now() } = {}) {
  let entries = [];
  let version = 0;
  let startedAt = null;

  function clean(text) {
    return typeof text === 'string' ? text.trim().slice(0, MAX_ENTRY_CHARS) : '';
  }

  return {
    // `id` lets a later version of the same AI answer (a preview finished into the
    // full reply) replace the earlier one instead of appearing twice.
    add(role, text, { id = null } = {}) {
      const value = clean(text);
      if (!TRANSCRIPT_ROLES.includes(role) || !value) return false;
      if (id) {
        const index = entries.findIndex((entry) => entry.id === id);
        if (index >= 0) {
          if (entries[index].text === value) return false;
          entries[index] = { ...entries[index], text: value };
          version++;
          return true;
        }
      }
      // A manual trigger repeats the utterance that was just transcribed.
      const lastOfRole = entries.findLast((entry) => entry.role === role);
      if (role !== 'assistant' && lastOfRole?.text === value && entries.at(-1) === lastOfRole) return false;
      const at = now();
      startedAt ??= at;
      entries.push({ ...(id ? { id } : {}), role, text: value, at });
      if (entries.length > maxEntries) entries = entries.slice(-maxEntries);
      version++;
      return true;
    },
    entries: () => entries.map((entry) => ({ ...entry })),
    // Bumps on every change, so a summary knows whether it still covers everything.
    get version() { return version; },
    get startedAt() { return startedAt; },
    // Lines the people in the call said, excluding AI suggestions.
    get spokenCount() { return entries.filter((entry) => entry.role !== 'assistant').length; },
    clear() {
      entries = [];
      startedAt = null;
      version++;
    },
  };
}
