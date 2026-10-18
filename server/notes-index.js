// In-memory BM25 index over Markdown notes. Searching takes a few milliseconds,
// so it runs on every partial transcript without touching the model's latency.

const K1 = 1.2;
const B = 0.75;
const MAX_SECTION_CHARS = 1200;
const WINDOW_CHARS = 800;
// Terms in more than this share of the chunks say nothing about relevance.
const COMMON_TERM_RATIO = 0.5;
const PREFIX_WEIGHT = 0.6;
const RARE_TERM_RATIO = 0.02;

// Function words plus the verbs interviewers use to frame a question
// ("me conte sobre…", "qual foi…"), which would otherwise match every note.
const STOPWORDS = new Set(`
a o as os um uma uns umas de da do das dos em na no nas nos por pela pelo pelas pelos para pra com sem sob sobre
e ou mas se que quem qual quais quando onde como porque pois entao tambem ja nao sim mais menos muito muita muitos muitas
eu tu ele ela nos vos eles elas voce voces me te lhe nos meu minha meus minhas teu tua seu sua seus suas nosso nossa
isso isto aquilo esse essa esses essas este esta estes estas aquele aquela ai aqui la ate ao aos
foi fui era eram ser sido sao estar estava esta estao tem tinha ter teve ha havia fazer fez faz fazia
pode poderia posso podemos vai vamos vou seria sera deve devia
conte conta contar fale fala falar diga dizer explique explica explicar descreva descrever me lembra lembrar
oi ola tudo bem bom boa dia tarde noite obrigado obrigada entendi certo legal beleza otimo perfeito claro
algum alguma alguns algumas cada todo toda todos todas outro outra outros outras mesmo mesma
the of and or to in on at for with by from is are was were be been do does did have has had it its this that these those
what which who whom when where why how can could would should will tell about your you me my our we they them
`.split(/\s+/).filter(Boolean));

function fold(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// A light plural strip keeps "projetos"/"projeto" and "metrics"/"metric" together.
function stem(term) {
  if (/^\d/.test(term)) return term;
  if (term.length > 5 && term.endsWith('oes')) return `${term.slice(0, -3)}ao`;
  if (term.length > 4 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1);
  return term;
}

// Yields each indexable term with its position in the original text, so the UI
// can highlight matches without re-implementing the folding rules.
export function tokenize(text) {
  const tokens = [];
  const folded = fold(text);
  // NFD folding keeps one code unit per base letter for Latin text, so offsets
  // usually match; fall back to no positions when the lengths differ.
  const aligned = folded.length === text.length;
  for (const match of folded.matchAll(/[a-z0-9]+(?:[.,][0-9]+)*/g)) {
    const raw = match[0];
    if (raw.length < 2 && !/\d/.test(raw)) continue;
    if (STOPWORDS.has(raw)) continue;
    tokens.push({ term: stem(raw), start: aligned ? match.index : -1, end: aligned ? match.index + raw.length : -1 });
  }
  return tokens;
}

// Obsidian syntax that would otherwise add noise to snippets and the prompt.
export function cleanMarkdown(text) {
  return text
    .replace(/^﻿/, '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .replace(/%%[\s\S]*?%%/g, '')
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]|#]*)(?:#([^\]|]*))?\]\]/g, (_, page, heading) => heading ? `${page} > ${heading}` : page)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\r\n/g, '\n');
}

function splitLong(body) {
  if (body.length <= MAX_SECTION_CHARS) return [body];
  const pieces = [];
  let current = '';
  for (const paragraph of body.split(/\n{2,}/)) {
    if (current && current.length + paragraph.length + 2 > WINDOW_CHARS) {
      pieces.push(current);
      current = '';
    }
    // A single huge paragraph still gets cut, at a sentence or word boundary when possible.
    let rest = paragraph;
    while (rest.length > MAX_SECTION_CHARS) {
      const cut = Math.max(rest.lastIndexOf('. ', WINDOW_CHARS), rest.lastIndexOf(' ', WINDOW_CHARS), WINDOW_CHARS / 2);
      pieces.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    current = current ? `${current}\n\n${rest}` : rest;
  }
  if (current.trim()) pieces.push(current);
  return pieces;
}

// One chunk per heading section; the heading path ("Projeto X > Métricas")
// travels with the chunk because it is often the only place a keyword appears.
export function chunkMarkdown(markdown, file) {
  const parts = file.replace(/\\/g, '/').split('/');
  const title = parts.pop().replace(/\.md$/i, '');
  const folder = parts.join(' ');
  const chunks = [];
  const trail = [];
  let body = [];
  let inFence = false;
  const flush = () => {
    const text = body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    body = [];
    if (!text) return;
    const heading = trail.filter(Boolean).join(' > ');
    for (const piece of splitLong(text)) chunks.push({ file, title, folder, heading, text: piece });
  };
  for (const line of cleanMarkdown(markdown).split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      flush();
      const level = match[1].length;
      trail.length = level - 1;
      trail[level - 1] = match[2];
      continue;
    }
    body.push(line);
  }
  flush();
  return chunks;
}

function snippetAround(text, positions, size) {
  if (text.length <= size) return { text, offset: 0 };
  const first = positions.length ? positions[0] : 0;
  let start = Math.max(0, first - Math.floor(size / 3));
  const space = text.lastIndexOf(' ', start);
  if (start > 0 && space > start - 30) start = space + 1;
  const end = Math.min(text.length, start + size);
  const raw = text.slice(start, end);
  const lead = raw.length - raw.trimStart().length;
  const prefix = start > 0 ? '…' : '';
  // offset maps a position in the note text to the same position in the snippet.
  return { text: `${prefix}${raw.trim()}${end < text.length ? '…' : ''}`, offset: start + lead - prefix.length };
}

export function createNotesIndex() {
  const docs = new Map(); // id -> { chunk, tf: Map, length }
  const byFile = new Map(); // file -> ids
  const postings = new Map(); // term -> Set(id)
  let nextId = 0;
  let totalLength = 0;

  function remove(file) {
    for (const id of byFile.get(file) || []) {
      const doc = docs.get(id);
      totalLength -= doc.length;
      for (const term of doc.tf.keys()) {
        const set = postings.get(term);
        set.delete(id);
        if (!set.size) postings.delete(term);
      }
      docs.delete(id);
    }
    byFile.delete(file);
  }

  function add(file, markdown) {
    remove(file);
    const ids = [];
    for (const chunk of chunkMarkdown(markdown, file)) {
      const tf = new Map();
      // The note title and heading count twice: they name what the section is about.
      const label = `${chunk.title} ${chunk.heading}`;
      const terms = [...tokenize(chunk.folder), ...tokenize(label), ...tokenize(label), ...tokenize(chunk.text)];
      for (const { term } of terms) tf.set(term, (tf.get(term) || 0) + 1);
      if (!tf.size) continue;
      const id = nextId++;
      docs.set(id, { chunk, tf, length: terms.length });
      totalLength += terms.length;
      for (const term of tf.keys()) {
        if (!postings.has(term)) postings.set(term, new Set());
        postings.get(term).add(id);
      }
      ids.push(id);
    }
    if (ids.length) byFile.set(file, ids);
    return ids.length;
  }

  // A hit needs two distinctive query terms (one when the query has only one),
  // and must score close to the best hit, so small talk returns nothing.
  // Portuguese verb forms differ only in the ending ("liderou"/"liderei"), so a
  // long query term also matches vocabulary sharing its stem, at a lower weight.
  function expand(term) {
    const variants = [];
    if (postings.has(term)) variants.push([term, 1]);
    if (term.length >= 6 && !/\d/.test(term)) {
      const prefix = term.slice(0, Math.max(5, Math.ceil(term.length * 0.7)));
      for (const candidate of postings.keys()) {
        if (candidate !== term && candidate.startsWith(prefix)) variants.push([candidate, PREFIX_WEIGHT]);
      }
    }
    return variants;
  }

  function search(query, { limit = 3, relative = 0.45, snippetChars = 280 } = {}) {
    const n = docs.size;
    if (!n || typeof query !== 'string') return [];
    const distinctive = (term) => n < 4 || postings.get(term).size / n <= COMMON_TERM_RATIO;
    const queryTerms = [...new Set(tokenize(query).map((token) => token.term))]
      .map((term) => [term, expand(term).filter(([variant]) => distinctive(variant))])
      .filter(([, variants]) => variants.length);
    if (!queryTerms.length) return [];
    const required = Math.min(2, queryTerms.length);
    const avgLength = totalLength / n;
    const scores = new Map();
    for (const [term, variants] of queryTerms) {
      // Each query term counts once per section: its best-scoring variant.
      const best = new Map();
      for (const [variant, weight] of variants) {
        const ids = postings.get(variant);
        const idf = Math.log(1 + (n - ids.size + 0.5) / (ids.size + 0.5));
        for (const id of ids) {
          const doc = docs.get(id);
          const freq = doc.tf.get(variant);
          const score = weight * idf * (freq * (K1 + 1)) / (freq + K1 * (1 - B + B * doc.length / avgLength));
          if (score > (best.get(id)?.score || 0)) best.set(id, { score, variant });
        }
      }
      for (const [id, { score, variant }] of best) {
        const entry = scores.get(id) || { score: 0, matched: new Set(), variants: new Set() };
        entry.score += score;
        entry.matched.add(term);
        entry.variants.add(variant);
        scores.set(id, entry);
      }
    }
    const rare = (variant) => postings.get(variant).size <= Math.max(2, n * RARE_TERM_RATIO);
    let ranked = [...scores.entries()].filter(([, entry]) => entry.matched.size >= required);
    // One rare term is still a strong signal ("liderou" -> the one section about leading a team).
    if (!ranked.length) ranked = [...scores.entries()].filter(([, entry]) => [...entry.variants].every(rare));
    ranked.sort((a, b) => b[1].score - a[1].score);
    if (!ranked.length) return [];
    const top = ranked[0][1].score;
    return ranked.filter(([, entry]) => entry.score >= top * relative).slice(0, limit).map(([id, entry]) => {
      const { chunk } = docs.get(id);
      const positions = tokenize(chunk.text).filter((token) => entry.variants.has(token.term) && token.start >= 0);
      const snippet = snippetAround(chunk.text, positions.map((token) => token.start), snippetChars);
      const highlights = positions
        .map((token) => [token.start - snippet.offset, token.end - snippet.offset])
        .filter(([start, end]) => start >= 0 && end <= snippet.text.length);
      return {
        id: `${chunk.file}#${id}`,
        file: chunk.file,
        title: chunk.title,
        heading: chunk.heading,
        text: chunk.text,
        snippet: snippet.text,
        highlights,
        score: Number(entry.score.toFixed(3)),
      };
    });
  }

  return {
    add,
    remove,
    search,
    files: () => [...byFile.keys()],
    get size() { return { files: byFile.size, chunks: docs.size }; },
  };
}
