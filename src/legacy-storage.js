// Settings saved under the app's earlier names move once to the "sidenote_" keys.
// Imported before App, so every hook already reads the new keys.
const LEGACY_PREFIX = /^(?:perssua|interviewai)_(.+)$/;

try {
  for (const key of Object.keys(localStorage)) {
    const match = key.match(LEGACY_PREFIX);
    if (!match) continue;
    const next = `sidenote_${match[1]}`;
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key));
    localStorage.removeItem(key);
  }
} catch {}
