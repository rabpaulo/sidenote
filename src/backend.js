// The backend answers only requests that carry the token of this run, which the
// Electron preload hands to the page (see server/backend-auth.js).
const TOKEN_HEADER = 'X-Sidenote-Token';
let cachedToken = null;

export function backendToken() {
  if (!cachedToken) {
    try {
      cachedToken = globalThis.window?.sidenoteDesktop?.backendToken?.() || null;
    } catch {
      cachedToken = null;
    }
  }
  return cachedToken;
}

export function apiFetch(input, init = {}) {
  const headers = new Headers(init.headers || {});
  const token = backendToken();
  if (token) headers.set(TOKEN_HEADER, token);
  return fetch(input, { ...init, headers });
}

// The page is served by Vite (development) or by the backend itself on port 3001.
export function backendSocketUrl(location = window.location) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = location.port === '3001' ? location.host : '127.0.0.1:3001';
  const token = backendToken();
  return `${protocol}//${host}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}
