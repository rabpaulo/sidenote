import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TOKEN_HEADER = 'x-sidenote-token';
export const TOKEN_FILE = 'backend-token';

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Only the app's own window may use the backend: every API request and the
 * WebSocket must carry the token of this run, and browsers may only call it from
 * the app's origins. Electron generates the token and passes it in
 * SIDENOTE_TOKEN; a backend started by hand makes its own. Requests without an
 * Origin come from local processes (Electron's main process, tests, scripts),
 * which still need the token.
 */
export function createBackendAuth({ token = null, port, extraOrigins = [] }) {
  const secret = token || crypto.randomBytes(32).toString('hex');
  const expected = digest(secret);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`,
    ...extraOrigins.map(originOf).filter(Boolean)]);

  const originAllowed = (origin) => !origin || origins.has(origin);
  const valid = (candidate) => typeof candidate === 'string' && candidate.length > 0
    && crypto.timingSafeEqual(digest(candidate), expected);

  return {
    token: secret,
    origins,
    originAllowed,
    valid,
    corsOptions: { origin: (origin, callback) => callback(null, originAllowed(origin) ? origin || true : false) },

    // Rejects other sites before any handler runs, even for requests CORS would let through.
    rejectForeignOrigins(req, res, next) {
      if (originAllowed(req.get('origin'))) return next();
      res.status(403).json({ error: 'Origem não permitida.' });
    },

    requireToken(req, res, next) {
      if (valid(req.get(TOKEN_HEADER))) return next();
      res.status(401).json({ error: 'Não autorizado.' });
    },

    // Browsers cannot set headers on a WebSocket, so the token goes in the query string.
    verifySocket({ origin, req }) {
      let candidate = null;
      try {
        candidate = new URL(req.url, 'http://127.0.0.1').searchParams.get('token');
      } catch {}
      return originAllowed(origin) && valid(candidate);
    },

    // Lets an Electron window that reuses this backend find the token; readable by this user only.
    writeTokenFile(dir) {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, TOKEN_FILE);
      fs.writeFileSync(file, secret, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      return file;
    },
  };
}
