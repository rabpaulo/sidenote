// Actual input stays separate from generated suggestions, including utterances
// never sent to a provider while automatic responses were disabled or busy.
export function createConversationMemory({ maxTurns = 16, maxCharacters = 12000 } = {}) {
  let turns = [];

  function remember(role, text) {
    if (!['interlocutor', 'user'].includes(role) || typeof text !== 'string' || !text.trim()) return;
    const clean = text.trim();
    const limit = Math.min(3000, maxCharacters);
    const entry = { role, text: clean.slice(0, limit), ...(clean.length > limit ? { truncated: true } : {}) };
    const last = turns.at(-1);
    if (last?.role === role && last.text === entry.text && last.truncated === entry.truncated) return;
    turns.push(entry);
    while (turns.length > maxTurns || turns.reduce((size, turn) => size + turn.text.length, 0) > maxCharacters) turns.shift();
  }

  return {
    remember,
    beforeQuestion(text) {
      const last = turns.at(-1);
      const recent = last?.role === 'interlocutor' && last.text === text.trim().slice(0, Math.min(3000, maxCharacters)) ? turns.slice(0, -1) : turns;
      return recent.map((turn) => ({ ...turn }));
    },
    clear() { turns = []; },
  };
}
