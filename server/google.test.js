import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authorizationUrl, createGoogle, GOOGLE_SCOPES, pkcePair } from './google.js';
import {
  createDocument, documentText, htmlToText, listEvents, multipartBody, normalizeEvent, parseDocId, stripFrontMatter,
} from './google-workspace.js';
import { meetingEventBlock } from './agent-prompt.js';

const CLIENT_ID = '123-abc.apps.googleusercontent.com';
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sidenote-google-')), 'google.json');

// Records token requests and answers them like Google would.
function fakeTokens(reply) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const params = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null;
    calls.push({ url: String(url), params, headers: init.headers });
    const { status = 200, body = {} } = reply(String(url), params, init) || {};
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

test('the sign-in URL asks for offline access with PKCE and the app scopes', () => {
  const { verifier, challenge } = pkcePair();
  assert.ok(verifier.length >= 43);
  assert.notEqual(verifier, challenge);
  const url = new URL(authorizationUrl({ clientId: CLIENT_ID, redirectUri: 'http://127.0.0.1:5555', state: 's1', challenge }));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:5555');
  assert.deepEqual(url.searchParams.get('scope').split(' '), GOOGLE_SCOPES);
});

test('the client id is validated and saved readable only by the user', () => {
  const file = tempFile();
  const google = createGoogle({ file, env: {}, log: {} });
  assert.throws(() => google.setClient({ clientId: 'not-a-client' }), /googleusercontent/);
  google.setClient({ clientId: CLIENT_ID, clientSecret: 'secret' });
  assert.equal(google.status().configured, true);
  assert.equal(google.status().connected, false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // The environment wins over the saved client.
  const fromEnv = createGoogle({ file, env: { SIDENOTE_GOOGLE_CLIENT_ID: 'env-1.apps.googleusercontent.com' }, log: {} });
  assert.equal(fromEnv.status().clientSource, 'env');
});

test('the browser redirect is exchanged for tokens, then refreshed and revoked', async () => {
  const file = tempFile();
  let issued = 0;
  const { calls, fetchImpl } = fakeTokens((url, params) => {
    if (url.includes('/revoke')) return { body: {} };
    if (params?.grant_type === 'authorization_code') return { body: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, scope: GOOGLE_SCOPES.join(' ') } };
    if (params?.grant_type === 'refresh_token') return { body: { access_token: `access-${++issued + 1}`, expires_in: 3600 } };
    return { status: 400, body: { error: 'unexpected' } };
  });
  const changes = [];
  const google = createGoogle({ file, env: {}, fetchImpl, onChange: (status) => changes.push(status), log: {} });
  google.setClient({ clientId: CLIENT_ID, clientSecret: 'secret' });
  const { authUrl } = await google.connect({ fetchEmail: async () => 'pessoa@example.com' });
  assert.equal(google.status().connecting, true);
  const auth = new URL(authUrl);
  const redirect = auth.searchParams.get('redirect_uri');

  // A redirect with the wrong state is refused and the attempt keeps waiting.
  const forged = await fetch(`${redirect}/?code=evil&state=wrong`);
  assert.equal(forged.status, 400);
  assert.equal(google.status().connecting, true);

  const page = await fetch(`${redirect}/?code=good-code&state=${auth.searchParams.get('state')}`);
  assert.equal(page.status, 200);
  const exchange = calls.find((call) => call.params?.grant_type === 'authorization_code');
  assert.equal(exchange.params.code, 'good-code');
  assert.equal(exchange.params.client_secret, 'secret');
  assert.ok(exchange.params.code_verifier);
  const status = google.status();
  assert.equal(status.connected, true);
  assert.equal(status.connecting, false);
  assert.equal(status.email, 'pessoa@example.com');
  assert.equal(changes.at(-1).connected, true);
  assert.ok(!JSON.stringify(status).includes('refresh-1'), 'tokens never reach the status');

  assert.equal(await google.accessToken(), 'access-1');
  assert.equal(await google.accessToken({ force: true }), 'access-2');
  // A new instance reads the saved tokens.
  assert.equal(createGoogle({ file, env: {}, fetchImpl, log: {} }).status().connected, true);

  await google.disconnect();
  assert.equal(google.status().connected, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.some((call) => call.url.includes('/revoke?token=refresh-1')));
});

test('a revoked grant asks for a new login instead of failing forever', async () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ clientId: CLIENT_ID, tokens: { access_token: 'old', refresh_token: 'gone', expires_at: 0 } }));
  const { fetchImpl } = fakeTokens(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }));
  const google = createGoogle({ file, env: {}, fetchImpl, log: {} });
  await assert.rejects(google.accessToken(), /revoked/);
  assert.equal(google.status().connected, false);
  assert.match(google.status().error, /Conecte de novo/);
});

test('API calls retry once with a fresh token and explain disabled APIs', async () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ clientId: CLIENT_ID, tokens: { access_token: 'stale', refresh_token: 'r', expires_at: Date.now() + 3600000 } }));
  const seen = [];
  const { fetchImpl } = fakeTokens((url, params, init) => {
    if (params?.grant_type === 'refresh_token') return { body: { access_token: 'fresh', expires_in: 3600 } };
    seen.push(init.headers.Authorization);
    if (url.includes('/calendar')) return init.headers.Authorization === 'Bearer stale' ? { status: 401, body: {} } : { body: { items: [] } };
    return { status: 403, body: { error: { message: 'Google Docs API has not been used in project 1 before or it is disabled.' } } };
  });
  const google = createGoogle({ file, env: {}, fetchImpl, log: {} });
  assert.deepEqual(await listEvents(google.request, { from: 0, to: 1 }), []);
  assert.deepEqual(seen, ['Bearer stale', 'Bearer fresh']);
  await assert.rejects(google.request('https://docs.googleapis.com/v1/documents/x'), /Ative a API/);
});

test('calendar events keep what the prompt needs, declined ones are dropped', async () => {
  const event = normalizeEvent({
    id: 'e1', summary: 'Planejamento Q4', start: { dateTime: '2026-10-21T14:00:00-03:00' }, end: { dateTime: '2026-10-21T15:00:00-03:00' },
    hangoutLink: 'https://meet.google.com/abc', organizer: { email: 'ana@example.com', displayName: 'Ana' },
    attendees: [{ email: 'ana@example.com', displayName: 'Ana' }, { email: 'sala@resource.calendar.google.com', resource: true }, { email: 'bia@example.com' }],
    description: '<p>Pauta:</p><ul><li>Metas &amp; prazos</li><li><a href="https://docs.google.com/document/d/x">doc</a></li></ul>',
    attachments: [{ title: 'Pauta', fileUrl: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit', mimeType: 'application/vnd.google-apps.document', fileId: '1AbCdEfGhIjKlMnOpQrStUv' }],
  });
  assert.equal(event.title, 'Planejamento Q4');
  assert.equal(event.meetLink, 'https://meet.google.com/abc');
  assert.deepEqual(event.attendees.map((attendee) => attendee.name), ['Ana', 'bia@example.com']);
  assert.equal(event.description, 'Pauta:\n- Metas & prazos\n- doc (https://docs.google.com/document/d/x)');
  assert.equal(event.attachments[0].fileId, '1AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(normalizeEvent({ id: 'e2', start: { date: '2026-10-22' } }).allDay, true);

  const request = async () => new Response(JSON.stringify({ items: [
    { id: 'a', summary: 'Vai', start: { dateTime: '2026-10-21T10:00:00Z' } },
    { id: 'b', summary: 'Recusei', start: { dateTime: '2026-10-21T11:00:00Z' }, attendees: [{ self: true, responseStatus: 'declined', email: 'eu@x' }] },
    { id: 'c', status: 'cancelled', start: { dateTime: '2026-10-21T12:00:00Z' } },
  ] }));
  assert.deepEqual((await listEvents(request, { from: 0, to: 1 })).map((item) => item.id), ['a']);

  const block = meetingEventBlock({ ...event, documents: [{ title: 'Pauta', text: 'Item 1' }] });
  assert.match(block, /REUNIÃO NA AGENDA/);
  assert.match(block, /Planejamento Q4/);
  assert.match(block, /"participantes":\["Ana","bia@example.com"\]/);
  assert.match(block, /Item 1/);
  assert.equal(meetingEventBlock(null), '');
});

test('html descriptions become plain text', () => {
  assert.equal(htmlToText('Linha 1<br>Linha&nbsp;2<b>!</b>'), 'Linha 1\nLinha 2!');
  assert.equal(htmlToText(''), '');
});

test('document links and ids are recognized', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789';
  assert.equal(parseDocId(`https://docs.google.com/document/d/${id}/edit?tab=t.0`), id);
  assert.equal(parseDocId(`https://docs.google.com/document/u/1/d/${id}/edit`), id);
  assert.equal(parseDocId(`https://drive.google.com/open?id=${id}`), id);
  assert.equal(parseDocId(id), id);
  assert.equal(parseDocId('https://example.com/x'), null);
  assert.equal(parseDocId(''), null);
});

test('Docs API content becomes Markdown-like text, tabs and tables included', () => {
  const paragraph = (text, extra = {}) => ({ paragraph: { elements: [{ textRun: { content: text } }], ...extra } });
  const body = { content: [
    paragraph('Plano\n', { paragraphStyle: { namedStyleType: 'TITLE' } }),
    paragraph('Objetivo\n', { paragraphStyle: { namedStyleType: 'HEADING_1' } }),
    paragraph('Crescer 20%\n', { bullet: {} }),
    { table: { tableRows: [{ tableCells: [{ content: [paragraph('A\n')] }, { content: [paragraph('B\n')] }] }] } },
  ] };
  assert.equal(documentText({ body }), '# Plano\n## Objetivo\n- Crescer 20%\nA | B');
  const tabbed = { tabs: [{ documentTab: { body: { content: [paragraph('Aba 1\n')] } }, childTabs: [{ documentTab: { body: { content: [paragraph('Aba 2\n')] } } }] }] };
  assert.equal(documentText(tabbed), 'Aba 1\n\n\nAba 2'.replace(/\n{3,}/g, '\n\n'));
});

test('a meeting is exported as a converted Google Doc, with a plain-text fallback', async () => {
  assert.equal(stripFrontMatter('---\ntitulo: "x"\n---\n\n# Título\n'), '# Título\n');
  const body = multipartBody({ name: 'n' }, 'conteúdo', 'text/markdown', 'b1');
  assert.match(body, /^--b1\r\nContent-Type: application\/json/);
  assert.match(body, /Content-Type: text\/markdown; charset=UTF-8\r\n\r\nconteúdo\r\n--b1--$/);

  const types = [];
  const request = async (url, init) => {
    types.push(init.body.match(/Content-Type: (text\/\w+)/)[1]);
    assert.match(url, /uploadType=multipart/);
    if (types.length === 1) throw Object.assign(new Error('conversion'), { status: 502 });
    return new Response(JSON.stringify({ id: 'doc1', webViewLink: 'https://docs.google.com/document/d/doc1/edit' }));
  };
  const doc = await createDocument(request, { title: 'Reunião', markdown: '---\na: 1\n---\n# Oi' });
  assert.deepEqual(doc, { id: 'doc1', url: 'https://docs.google.com/document/d/doc1/edit' });
  assert.deepEqual(types, ['text/markdown', 'text/plain']);
});
