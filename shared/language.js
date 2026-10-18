export const AUTO_LANGUAGE = 'auto';
export const LANGUAGES = ['pt-BR', 'en-US'];

// In auto mode the first recognized window of an utterance is transcribed in
// every language and the best match wins. The rest of that utterance stays in
// the detected language so it cannot flip mid-sentence; the next utterance
// detects again, preferring (on ties) the language heard last.
export function createUtteranceLanguage(setting, preferred) {
  let locked = setting && setting !== AUTO_LANGUAGE ? setting : null;
  const candidates = LANGUAGES.includes(preferred)
    ? [preferred, ...LANGUAGES.filter((language) => language !== preferred)]
    : LANGUAGES;
  return {
    get request() { return locked || candidates.join(','); },
    get detected() { return locked; },
    observe(result) {
      if (!locked && result?.text?.trim() && LANGUAGES.includes(result.language)) locked = result.language;
      return result;
    },
  };
}
