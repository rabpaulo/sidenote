// Splits a snippet at the server's match ranges; overlapping or out-of-range
// ranges are skipped rather than trusted.
export function highlightSegments(text, highlights = []) {
  const segments = [];
  let cursor = 0;
  for (const [start, end] of [...highlights].sort((a, b) => a[0] - b[0])) {
    if (start < cursor || end <= start || end > text.length) continue;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}
