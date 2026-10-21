// Calendar events, Docs text and Docs export over the Google REST APIs, through the
// authorized `request` of server/google.js.

const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const GOOGLE_DOC = 'application/vnd.google-apps.document';
const MAX_DESCRIPTION_CHARS = 4000;
export const MAX_DOC_CHARS = 40000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Calendar descriptions are HTML; the prompt only needs the text. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h\d)\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_, href, label) => (label && label !== href ? `${label} (${href})` : href))
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (match, name) => ENTITIES[name] ?? match)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeEvent(event) {
  const start = event.start?.dateTime || event.start?.date;
  const end = event.end?.dateTime || event.end?.date;
  const video = event.hangoutLink || event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === 'video')?.uri || null;
  return {
    id: event.id,
    title: (event.summary || '').trim() || '(sem título)',
    start: start ? Date.parse(start) : null,
    end: end ? Date.parse(end) : null,
    allDay: !event.start?.dateTime,
    location: event.location || null,
    meetLink: video,
    htmlLink: event.htmlLink || null,
    organizer: event.organizer?.displayName || event.organizer?.email || null,
    attendees: (event.attendees || []).filter((attendee) => !attendee.resource)
      .map((attendee) => ({ name: attendee.displayName || attendee.email || '', self: Boolean(attendee.self), response: attendee.responseStatus || null }))
      .filter((attendee) => attendee.name),
    description: htmlToText(event.description).slice(0, MAX_DESCRIPTION_CHARS),
    attachments: (event.attachments || []).map((file) => ({
      title: file.title || 'Anexo', url: file.fileUrl || null, mimeType: file.mimeType || null, fileId: file.fileId || null,
    })),
  };
}

/** Events of the primary calendar between `from` and `to` (ms), declined ones left out. */
export async function listEvents(request, { from, to, limit = 20 }) {
  const params = new URLSearchParams({
    timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: String(limit),
  });
  const response = await request(`${CALENDAR}/calendars/primary/events?${params}`);
  const body = await response.json();
  return (body.items || [])
    .filter((event) => event.status !== 'cancelled'
      && !(event.attendees || []).some((attendee) => attendee.self && attendee.responseStatus === 'declined'))
    .map(normalizeEvent);
}

export async function getEvent(request, id) {
  const response = await request(`${CALENDAR}/calendars/primary/events/${encodeURIComponent(id)}`);
  return normalizeEvent(await response.json());
}

/** The account's e-mail: the primary calendar is named after it. */
export async function accountEmail(request) {
  const response = await request(`${CALENDAR}/calendars/primary?fields=id`);
  return (await response.json()).id || null;
}

/** Document id from a docs.google.com link (or the bare id). */
export function parseDocId(input) {
  const value = String(input || '').trim();
  const fromUrl = value.match(/\/document\/(?:u\/\d+\/)?d\/([\w-]{20,})/)?.[1]
    || value.match(/[?&]id=([\w-]{20,})/)?.[1];
  if (fromUrl) return fromUrl;
  return /^[\w-]{20,}$/.test(value) ? value : null;
}

function paragraphText(paragraph) {
  const text = (paragraph.elements || []).map((element) => element.textRun?.content ?? '').join('');
  const style = paragraph.paragraphStyle?.namedStyleType || '';
  const level = style.match(/^HEADING_(\d)$/)?.[1];
  if (style === 'TITLE') return `# ${text}`;
  if (level) return `${'#'.repeat(Math.min(6, Number(level) + 1))} ${text}`;
  return paragraph.bullet ? `- ${text}` : text;
}

function contentText(content = []) {
  const parts = [];
  for (const block of content) {
    if (block.paragraph) parts.push(paragraphText(block.paragraph));
    else if (block.table) {
      for (const row of block.table.tableRows || []) {
        parts.push(`${(row.tableCells || []).map((cell) => contentText(cell.content).replace(/\n+/g, ' ').trim()).join(' | ')}\n`);
      }
    } else if (block.tableOfContents) parts.push(contentText(block.tableOfContents.content));
  }
  return parts.join('');
}

/** Text of a Docs API document, headings kept as Markdown. Tabs are read in order. */
export function documentText(doc) {
  const tabs = [];
  const walk = (list) => {
    for (const tab of list || []) {
      if (tab.documentTab?.body) tabs.push(contentText(tab.documentTab.body.content));
      walk(tab.childTabs);
    }
  };
  walk(doc.tabs);
  const text = tabs.length ? tabs.join('\n\n') : contentText(doc.body?.content);
  return text.replace(/\u000b/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_DOC_CHARS);
}

export async function readDocument(request, idOrUrl) {
  const id = parseDocId(idOrUrl);
  if (!id) throw Object.assign(new Error('Cole o link de um documento do Google Docs.'), { status: 400 });
  const response = await request(`${DOCS}/${id}?includeTabsContent=true`);
  const doc = await response.json();
  return { id, title: doc.title || 'Documento', text: documentText(doc) };
}

/** Body of a Drive multipart upload: JSON metadata, then the file. */
export function multipartBody(metadata, content, contentType, boundary) {
  return `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
    + `--${boundary}\r\nContent-Type: ${contentType}; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
}

// Drive does not understand front matter; the date and model stay in the text below it.
export const stripFrontMatter = (markdown) => String(markdown || '').replace(/^---\n[\s\S]*?\n---\n+/, '');

/**
 * Creates a Google Doc from Markdown (Drive converts headings, lists and bold).
 * Returns { id, url }.
 */
export async function createDocument(request, { title, markdown }) {
  const boundary = `sidenote-${Date.now().toString(36)}`;
  const metadata = { name: title, mimeType: GOOGLE_DOC };
  const upload = (contentType) => request(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id,webViewLink`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipartBody(metadata, stripFrontMatter(markdown), contentType, boundary),
  });
  let response;
  try {
    response = await upload('text/markdown');
  } catch (error) {
    // Older accounts may not convert Markdown yet; plain text still makes a Doc.
    if (error.status !== 502) throw error;
    response = await upload('text/plain');
  }
  const body = await response.json();
  return { id: body.id, url: body.webViewLink || `https://docs.google.com/document/d/${body.id}/edit` };
}
