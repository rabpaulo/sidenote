import React from 'react';
import { NotebookText } from 'lucide-react';
import { highlightSegments } from './notes-highlight.js';

// Raw note sections found by the local search, shown before the model answers.
export function NotesCard({ hits, live = false }) {
  if (!hits?.length) return null;
  return (
    <div className="notes-card" role="note" aria-label="Trechos das suas notas">
      <div className="notes-card__header">
        <NotebookText size={11} aria-hidden="true" />
        <span>SUAS NOTAS{live ? ' · AO VIVO' : ''}</span>
      </div>
      <ul className="notes-card__list">
        {hits.map((hit) => (
          <li key={hit.id} className="notes-card__item">
            <div className="notes-card__source" title={hit.file}>
              {[hit.title, hit.heading].filter(Boolean).join(' › ')}
            </div>
            <p className="notes-card__snippet">
              {highlightSegments(hit.snippet, hit.highlights).map((segment, index) => (
                segment.match ? <mark key={index}>{segment.text}</mark> : <React.Fragment key={index}>{segment.text}</React.Fragment>
              ))}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
