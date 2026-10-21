import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { defaultProfilePath } from './profile-store.js';

// Google account connection (Calendar and Docs) with OAuth for installed apps: the
// user's browser signs in and Google redirects to a one-time server on 127.0.0.1,
// with PKCE so the code is useless to anyone else. The OAuth client ("Desktop app" in
// Google Cloud) ships with the app in google-client.json, kept out of git and written at
// build time; a user may bring their own instead. Its secret is not confidential for
// this client type.
// Tokens live next to the profile, readable only by the user, and never reach the window.

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
  // Only the files the app creates (meeting notes exported to Docs).
  'https://www.googleapis.com/auth/drive.file',
];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;
const CLIENT_ID = /^[\w.-]+\.apps\.googleusercontent\.com$/;

const BUNDLED_CLIENT_FILE = new URL('./google-client.json', import.meta.url);

/** The client that ships with the app, or null in a checkout without one. */
export function readBundledClient(file = BUNDLED_CLIENT_FILE) {
  try {
    const { clientId, clientSecret } = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    return CLIENT_ID.test(clientId || '') ? { clientId, clientSecret: clientSecret || '' } : null;
  } catch {
    return null;
  }
}

export function defaultGooglePath(env = process.env) {
  return env.SIDENOTE_GOOGLE_PATH || path.join(path.dirname(defaultProfilePath(env)), 'google.json');
}

export class GoogleError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const base64url = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkcePair() {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export function authorizationUrl({ clientId, redirectUri, state, challenge, scopes = GOOGLE_SCOPES }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // A refresh token, so the connection survives restarts.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${AUTH_URL}?${params}`;
}

const PAGE = (title, text) => `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;background:#0e0e14;color:#e4e4e7;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:420px"><h1 style="font-size:20px">${title}</h1><p style="color:#a1a1aa">${text}</p></div></body></html>`;

/**
 * `fetchImpl` and `tokenUrl` are replaceable for tests. `onChange` receives the
 * public status after a connection, a disconnection or a failed attempt.
 */
export function createGoogle({ file = defaultGooglePath(), env = process.env, bundled = readBundledClient(),
  fetchImpl = (...args) => fetch(...args), tokenUrl = TOKEN_URL, onChange = () => {}, log = console } = {}) {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (error) {
    if (error.code !== 'ENOENT') log.warn?.(`[Google] Could not read ${file}: ${error.message}`);
  }
  let pending = null;
  let lastError = null;
  let refreshing = null;

  function write() {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, ...saved }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  function client() {
    if (env.SIDENOTE_GOOGLE_CLIENT_ID) {
      return { clientId: env.SIDENOTE_GOOGLE_CLIENT_ID, clientSecret: env.SIDENOTE_GOOGLE_CLIENT_SECRET || '', source: 'env' };
    }
    if (saved.clientId) return { clientId: saved.clientId, clientSecret: saved.clientSecret || '', source: 'saved' };
    if (bundled) return { ...bundled, source: 'bundled' };
    return null;
  }

  function status() {
    const current = client();
    const tokens = saved.tokens;
    return {
      configured: Boolean(current),
      clientSource: current?.source || null,
      clientHint: current ? `${current.clientId.slice(0, 12)}…` : null,
      bundledClient: Boolean(bundled),
      connected: Boolean(tokens?.refresh_token),
      email: saved.email || null,
      connecting: Boolean(pending),
      error: lastError,
      scopes: tokens?.scope ? tokens.scope.split(' ') : [],
    };
  }

  const changed = () => onChange(status());

  function setClient({ clientId, clientSecret } = {}) {
    const id = typeof clientId === 'string' ? clientId.trim() : '';
    if (!CLIENT_ID.test(id)) throw new GoogleError('O Client ID termina em .apps.googleusercontent.com.');
    const secret = typeof clientSecret === 'string' ? clientSecret.trim() : '';
    if (/\s/.test(secret) || secret.length > 200) throw new GoogleError('O Client secret não parece válido.');
    // Tokens belong to the client that issued them.
    const previous = client()?.clientId;
    if (previous && previous !== id) {
      delete saved.tokens;
      delete saved.email;
    }
    saved = { ...saved, clientId: id, clientSecret: secret };
    lastError = null;
    write();
    changed();
  }

  async function tokenRequest(params) {
    const current = client();
    const response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: current.clientId, ...(current.clientSecret ? { client_secret: current.clientSecret } : {}), ...params }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new GoogleError(`Google recusou o login: ${body.error_description || body.error || `HTTP ${response.status}`}`, 401);
      error.code = body.error;
      throw error;
    }
    return body;
  }

  function storeTokens(body) {
    saved.tokens = {
      access_token: body.access_token,
      // Google sends a refresh token only on consent; a refresh keeps the old one.
      refresh_token: body.refresh_token || saved.tokens?.refresh_token,
      expires_at: Date.now() + (Number(body.expires_in) || 3600) * 1000,
      scope: body.scope || saved.tokens?.scope || '',
    };
  }

  function stopPending(error = null) {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.server.close();
    pending = null;
    lastError = error;
    changed();
  }

  /** Opens the loopback server and returns the URL to open in the browser. */
  async function connect({ fetchEmail } = {}) {
    const current = client();
    if (!current) throw new GoogleError('Informe o Client ID do Google antes de conectar.');
    stopPending();
    const { verifier, challenge } = pkcePair();
    const state = base64url(randomBytes(16));
    const server = http.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const redirectUri = `http://127.0.0.1:${server.address().port}`;
    const attempt = { server, timer: null };
    pending = attempt;
    attempt.timer = setTimeout(() => {
      if (pending === attempt) stopPending('O login no Google expirou. Tente de novo.');
    }, CONNECT_TIMEOUT_MS);
    attempt.timer.unref?.();

    server.on('request', async (req, res) => {
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== '/') { res.writeHead(404).end(); return; }
      const reply = (code, title, text) => res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE(title, text));
      if (pending !== attempt || url.searchParams.get('state') !== state) {
        reply(400, 'Link inválido', 'Este login não foi iniciado pelo Sidenote ou já terminou. Volte ao app e tente de novo.');
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        const denied = url.searchParams.get('error') === 'access_denied';
        reply(400, 'Login cancelado', 'Você pode fechar esta aba e tentar de novo no Sidenote.');
        stopPending(denied ? 'O acesso ao Google foi negado.' : `Erro do Google: ${url.searchParams.get('error') || 'sem código'}.`);
        return;
      }
      try {
        storeTokens(await tokenRequest({ code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' }));
        saved.email = (await fetchEmail?.().catch(() => null)) || null;
        write();
        reply(200, 'Google conectado', 'Pronto! Pode fechar esta aba e voltar ao Sidenote.');
        log.log?.(`[Google] Connected${saved.email ? ` as ${saved.email}` : ''}`);
        stopPending(null);
      } catch (error) {
        reply(500, 'Não foi possível conectar', error.message);
        stopPending(error.message);
      }
    });

    lastError = null;
    changed();
    return { authUrl: authorizationUrl({ clientId: current.clientId, redirectUri, state, challenge }) };
  }

  function cancelConnect() {
    stopPending(null);
  }

  /** A valid access token, refreshed when it is about to expire. */
  async function accessToken({ force = false } = {}) {
    const tokens = saved.tokens;
    if (!tokens?.refresh_token) throw new GoogleError('Conecte sua conta Google em Menu → Google.', 401);
    if (!force && tokens.access_token && tokens.expires_at - Date.now() > 60000) return tokens.access_token;
    if (!refreshing) {
      refreshing = tokenRequest({ refresh_token: tokens.refresh_token, grant_type: 'refresh_token' })
        .then((body) => { storeTokens(body); write(); return saved.tokens.access_token; })
        .catch((error) => {
          // A revoked or expired grant needs a new login.
          if (error.code === 'invalid_grant') {
            delete saved.tokens;
            write();
            lastError = 'O acesso ao Google expirou ou foi revogado. Conecte de novo.';
            changed();
          }
          throw error;
        })
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  /** fetch with the account's token; a 401 refreshes once and retries. */
  async function request(url, init = {}) {
    const send = async (token) => fetchImpl(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` },
      signal: init.signal || AbortSignal.timeout(20000) });
    let response = await send(await accessToken());
    if (response.status === 401) response = await send(await accessToken({ force: true }));
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const detail = body.error?.message || body.error_description || `HTTP ${response.status}`;
      if (response.status === 403 && /has not been used|is disabled/i.test(detail)) {
        throw new GoogleError(`Ative a API no Google Cloud do seu Client ID: ${detail}`, 403);
      }
      if (response.status === 403 && /insufficient/i.test(detail)) {
        throw new GoogleError('Falta permissão para isso. Desconecte e conecte o Google de novo.', 403);
      }
      throw new GoogleError(`Google: ${detail}`, response.status === 404 ? 404 : 502);
    }
    return response;
  }

  async function disconnect() {
    stopPending();
    const token = saved.tokens?.refresh_token || saved.tokens?.access_token;
    delete saved.tokens;
    delete saved.email;
    lastError = null;
    write();
    changed();
    // Best effort: the local tokens are already gone.
    if (token) {
      fetchImpl(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST', signal: AbortSignal.timeout(10000) })
        .catch(() => {});
    }
  }

  function removeClient() {
    if (saved.clientId) {
      disconnect();
      saved = {};
      write();
      changed();
    }
  }

  return { file, status, setClient, removeClient, connect, cancelConnect, disconnect, accessToken, request,
    get connected() { return Boolean(saved.tokens?.refresh_token); } };
}
