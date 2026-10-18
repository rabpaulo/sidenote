// Splits an agent reply into markdown prose, single code blocks and tabbed code
// groups. Kept free of React so it can be unit tested with node --test.

const LANGUAGE_NAMES = {
  bash: 'Bash', sh: 'Shell', shell: 'Shell', c: 'C', cpp: 'C++', 'c++': 'C++', cs: 'C#', csharp: 'C#',
  go: 'Go', java: 'Java', js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX', kotlin: 'Kotlin',
  py: 'Python', python: 'Python', rust: 'Rust', sql: 'SQL', swift: 'Swift', ts: 'TypeScript',
  typescript: 'TypeScript', tsx: 'TSX', json: 'JSON', text: 'Texto', txt: 'Texto',
};

export function languageLabel(language) {
  const key = (language || '').toLowerCase();
  return LANGUAGE_NAMES[key] || (key && key !== 'code' ? key : 'Código');
}

/** Line-based fence parser; an unterminated trailing fence stays code so it highlights while streaming. */
export function splitFences(text) {
  const segments = [];
  const lines = text.split('\n');
  let prose = [];
  const flushProse = () => {
    if (prose.join('\n').trim()) segments.push({ type: 'prose', text: prose.join('\n') });
    prose = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/);
    if (!open) {
      prose.push(lines[i]);
      continue;
    }
    flushProse();
    const [, indent, fence, language] = open;
    const close = new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
    const code = [];
    let closed = false;
    for (i += 1; i < lines.length; i++) {
      if (close.test(lines[i])) { closed = true; break; }
      code.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i].trimStart());
    }
    segments.push({ type: 'code', language: language || 'code', code: code.join('\n'), closed });
  }
  flushProse();
  return segments;
}

// A heading, a bold-only line or a short "Em TypeScript:" style line.
function labelFromLine(line) {
  const trimmed = line.trim();
  const heading = trimmed.match(/^#{1,6}\s+(.+?)\s*#*$/);
  const bold = trimmed.match(/^(?:\*\*|__)(.+?)(?:\*\*|__):?$/);
  const colon = trimmed.length <= 60 && /:$/.test(trimmed) ? trimmed : null;
  const raw = heading?.[1] || bold?.[1] || colon;
  if (!raw) return null;
  return raw.replace(/[*_`]/g, '').replace(/:\s*$/, '').trim() || null;
}

// Short prose between two code blocks ("#### Exemplo de uso") becomes that tab's label.
function asBridge(text) {
  const lines = text.split('\n').filter((line) => line.trim());
  if (lines.length === 0) return { label: null, note: '' };
  if (lines.length > 3 || text.trim().length > 300) return null;
  const label = labelFromLine(lines[0]);
  return { label, note: (label ? lines.slice(1) : lines).join('\n').trim() };
}

function takeTrailingLabel(segment) {
  const lines = segment.text.replace(/\s+$/, '').split('\n');
  const label = labelFromLine(lines.at(-1) || '');
  if (label) segment.text = lines.slice(0, -1).join('\n');
  return label;
}

function uniqueLabels(tabs) {
  const seen = new Map();
  for (const tab of tabs) {
    const count = (seen.get(tab.label) || 0) + 1;
    seen.set(tab.label, count);
    if (count > 1) tab.label = `${tab.label} ${count}`;
  }
  return tabs;
}

/** Returns [{type:'markdown',text} | {type:'code',...} | {type:'tabs',tabs:[...]}]. */
export function parseAgentResponse(text) {
  const segments = splitFences(text || '');
  const blocks = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.type === 'prose') {
      blocks.push({ type: 'markdown', text: normalizeMath(segment.text) });
      continue;
    }

    // Collect a run of code blocks separated only by short label-like prose.
    const run = [{ ...segment, label: null, note: '' }];
    let j = i + 1;
    while (j < segments.length) {
      if (segments[j].type === 'code') {
        run.push({ ...segments[j], label: null, note: '' });
        j += 1;
        continue;
      }
      const bridge = segments[j + 1]?.type === 'code' ? asBridge(segments[j].text) : null;
      if (!bridge) break;
      run.push({ ...segments[j + 1], ...bridge, note: normalizeMath(bridge.note) });
      j += 2;
    }

    if (run.length === 1) {
      blocks.push({ type: 'code', language: segment.language, code: segment.code, closed: segment.closed });
      continue;
    }

    const previous = blocks.at(-1);
    if (previous?.type === 'markdown') {
      run[0].label = takeTrailingLabel(previous);
      if (!previous.text.trim()) blocks.pop();
    }
    blocks.push({
      type: 'tabs',
      tabs: uniqueLabels(run.map(({ label, note, language, code, closed }) => ({
        label: label || languageLabel(language), note, language, code, closed,
      }))),
    });
    i = j - 1;
  }
  return blocks;
}

const LATEX = [
  [/\\(?:text|mathrm|operatorname)\{([^}]*)\}/g, '$1'],
  [/\\log\b/g, 'log'], [/\\cdot\b/g, '·'], [/\\times\b/g, '×'], [/\\leq?\b/g, '≤'], [/\\geq?\b/g, '≥'],
  [/\\neq?\b/g, '≠'], [/\\infty\b/g, '∞'], [/\\to\b/g, '→'], [/\\,|\\;|\\!/g, ' '],
  [/\^(?:2|\{2\})(?!\d)/g, '²'], [/\^(?:3|\{3\})(?!\d)/g, '³'],[/\^\{([^}]*)\}/g, '^$1'], [/_\{([^}]*)\}/g, '_$1'],
];

// Inline TeX such as $O(n \log n)$ becomes inline code; currency like "R$ 5.000" is left alone.
export function normalizeMath(text) {
  return text.replace(/(^|[^\\$\w])\$(?=\S)([^$\n]{1,60}?)(?<=\S)\$(?![\d$])/g, (_match, before, math) => {
    const plain = LATEX.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), math);
    return `${before}\`${plain.replace(/\s+/g, ' ').trim()}\``;
  });
}
