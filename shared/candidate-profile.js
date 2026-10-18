// Structured candidate profile. The server persists it to disk and sends the
// composed text (composeCandidateContext) to the model with every suggestion.

export const MAX_CONTEXT_CHARS = 10000;
export const MAX_EXPERIENCES = 8;
export const MAX_STACK_ITEMS = 30;

export const SENIORITY_OPTIONS = ['Estágio', 'Júnior', 'Pleno', 'Sênior', 'Staff', 'Liderança'];
export const LANGUAGE_SUGGESTIONS = ['TypeScript', 'JavaScript', 'Python', 'Java', 'Go', 'C#', 'Kotlin', 'Rust', 'C++'];

// Text limits per field; anything not listed here is dropped when normalizing.
const LIMITS = {
  name: 80,
  role: 120,
  seniority: 40,
  years: 4,
  preferredLanguage: 40,
  summary: 1500,
  jobCompany: 120,
  jobRole: 120,
  jobCompanyContext: 2000,
  jobRequirements: 1500,
  motivation: 800,
  notes: 6000,
};
const STACK_ITEM_LIMIT = 40;
const EXPERIENCE_LIMITS = { title: 120, story: 1500 };

export const EMPTY_PROFILE = Object.freeze({
  ...Object.fromEntries(Object.keys(LIMITS).map((key) => [key, ''])),
  stack: [],
  experiences: [],
});

const text = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');

export function normalizeProfile(input) {
  const source = input && typeof input === 'object' ? input : {};
  const profile = Object.fromEntries(Object.entries(LIMITS).map(([key, limit]) => [key, text(source[key], limit)]));
  profile.years = profile.years.replace(/\D/g, '');
  const seen = new Set();
  profile.stack = (Array.isArray(source.stack) ? source.stack : [])
    .map((item) => text(item, STACK_ITEM_LIMIT).trim())
    .filter((item) => item && !seen.has(item.toLowerCase()) && seen.add(item.toLowerCase()))
    .slice(0, MAX_STACK_ITEMS);
  profile.experiences = (Array.isArray(source.experiences) ? source.experiences : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({ title: text(item.title, EXPERIENCE_LIMITS.title), story: text(item.story, EXPERIENCE_LIMITS.story) }))
    .slice(0, MAX_EXPERIENCES);
  return profile;
}

export function isProfileEmpty(profile) {
  return composeCandidateContext(profile) === '';
}

function lines(entries) {
  return entries.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join('\n');
}

function block(title, body) {
  return body ? `## ${title}\n${body}` : '';
}

export function composeCandidateContext(input) {
  const p = normalizeProfile(input);
  const t = (key) => p[key].trim();
  const level = [t('seniority'), t('years') && `${t('years')} ${t('years') === '1' ? 'ano' : 'anos'} de experiência`]
    .filter(Boolean).join(', ');

  const profile = lines([
    ['Nome', t('name')],
    ['Cargo atual', t('role')],
    ['Nível', level],
    ['Linguagem preferida para código', t('preferredLanguage')],
    ['Tecnologias que domino', p.stack.join(', ')],
    ['Resumo', t('summary')],
  ]);
  const experiences = p.experiences
    .map(({ title, story }) => [title.trim(), story.trim()])
    .filter(([title, story]) => title || story)
    .map(([title, story]) => `### ${title || 'Experiência'}\n${story}`.trim())
    .join('\n\n');
  const job = lines([
    ['Empresa', t('jobCompany')],
    ['Sobre a empresa e seus produtos', t('jobCompanyContext')],
    ['Vaga', t('jobRole')],
    ['O que a vaga pede', t('jobRequirements')],
    ['Por que me interessa', t('motivation')],
  ]);

  return [
    block('Perfil', profile),
    block('Experiências reais', experiences),
    block('Entrevista atual', job),
    block('Outras informações', t('notes')),
  ].filter(Boolean).join('\n\n');
}

/**
 * Merges fields read from a résumé or job post into a draft: filled values replace
 * the draft's, technologies are added to the list and notes are appended.
 */
export function mergeImportedFields(current, fields = {}) {
  const base = normalizeProfile(current);
  const incoming = normalizeProfile(fields);
  const next = { ...base };
  for (const key of Object.keys(fields)) {
    if (!(key in base)) continue;
    if (key === 'stack') next.stack = normalizeProfile({ stack: [...base.stack, ...incoming.stack] }).stack;
    else if (key === 'notes') {
      const notes = incoming.notes.trim();
      if (notes && !base.notes.includes(notes)) next.notes = [base.notes.trim(), notes].filter(Boolean).join('\n\n');
    } else if (key === 'experiences' ? incoming.experiences.length : incoming[key].trim()) next[key] = incoming[key];
  }
  return normalizeProfile(next);
}
