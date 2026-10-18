import React, { useMemo, useState } from 'react';
import { Check, Copy, Terminal } from 'lucide-react';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import kotlin from 'highlight.js/lib/languages/kotlin';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import 'highlight.js/styles/github-dark.css';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { languageLabel, parseAgentResponse } from './agent-response.js';

// Languages commonly used for LeetCode-style answers.
for (const [name, language] of Object.entries({
  bash, c, cpp, csharp, go, java, javascript, kotlin, python, rust, sql, swift, typescript,
})) {
  hljs.registerLanguage(name, language);
}

function highlight(code, language) {
  const lang = language.toLowerCase();
  if (hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  return hljs.highlightAuto(code).value;
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button type="button" onClick={handleCopy} className="code-frame__copy" title={copied ? 'Copiado' : 'Copiar código'}>
      {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
      <span>{copied ? 'Copiado' : 'Copiar'}</span>
    </button>
  );
}

function CodeBody({ code, language }) {
  const html = useMemo(() => highlight(code, language), [code, language]);
  return (
    <pre className="code-frame__body">
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

export function CodeBlock({ code, language = 'javascript' }) {
  return (
    <div className="code-frame">
      <div className="code-frame__header">
        <div className="code-frame__title">
          <Terminal size={12} className="text-cyan-400" />
          <span>{languageLabel(language)}</span>
        </div>
        <CopyButton text={code} />
      </div>
      <CodeBody code={code} language={language} />
    </div>
  );
}

/** Several code blocks of one answer (solution, other language, usage example) shown as tabs. */
export function CodeTabs({ tabs }) {
  const [selected, setSelected] = useState(0);
  const active = tabs[Math.min(selected, tabs.length - 1)];

  return (
    <div className="code-frame">
      <div className="code-frame__header">
        <div className="code-frame__tabs" role="tablist">
          {tabs.map((tab, index) => (
            <button
              key={index}
              type="button"
              role="tab"
              aria-selected={tab === active}
              onClick={() => setSelected(index)}
              className="code-frame__tab"
              title={tab.label}
            >
              <span>{tab.label}</span>
              {!tab.closed && <span className="code-frame__streaming" aria-label="Gerando" />}
            </button>
          ))}
        </div>
        <CopyButton text={active.code} />
      </div>
      {active.note && (
        <div className="code-frame__note agent-markdown">
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>{active.note}</ReactMarkdown>
        </div>
      )}
      <CodeBody code={active.code} language={active.language} />
    </div>
  );
}

const REMARK_PLUGINS = [remarkGfm];

const MARKDOWN_COMPONENTS = {
  // Fences are split out beforehand; this catches indented code blocks.
  pre: ({ children }) => {
    const child = React.Children.toArray(children)[0]?.props || {};
    const language = /language-(\S+)/.exec(child.className || '')?.[1] || 'code';
    return <CodeBlock code={String(child.children ?? '').replace(/\n$/, '')} language={language} />;
  },
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  table: ({ node, ...props }) => (
    <div className="agent-markdown__table">
      <table {...props} />
    </div>
  ),
};

/**
 * Renders an agent reply: markdown prose, highlighted code and tabbed code groups.
 */
export function FormattedAgentResponse({ text }) {
  const blocks = useMemo(() => parseAgentResponse(text || ''), [text]);
  if (!text) return null;

  return (
    <div className="agent-markdown">
      {blocks.map((block, index) => {
        if (block.type === 'tabs') return <CodeTabs key={index} tabs={block.tabs} />;
        if (block.type === 'code') return <CodeBlock key={index} code={block.code} language={block.language} />;
        return (
          <ReactMarkdown key={index} remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
            {block.text}
          </ReactMarkdown>
        );
      })}
    </div>
  );
}
