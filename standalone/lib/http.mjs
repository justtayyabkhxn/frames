import fs from 'node:fs';
import { parseRange } from '../util.mjs';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const notFound = (what = 'Not found') => new HttpError(404, what);
export const badRequest = (what = 'Bad request') => new HttpError(400, what);

/** Minimal router: add(method, '/a/:b/*rest', fn); handlers get (req, res, params, url). */
function decodeParam(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    throw badRequest('Malformed URL');
  }
}

export class Router {
  routes = [];
  add(method, pattern, fn) {
    const keys = [];
    const re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\/(\*|:)(\w+)/g, (_, kind, key) => {
      keys.push(key);
      return kind === '*' ? '(?:/(.*))?' : '/([^/]+)';
    });
    this.routes.push({ method, re: new RegExp(`^${re}/?$`), keys, fn });
    return this;
  }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== '*' && r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1] == null ? '' : decodeParam(m[i + 1])]));
      return { fn: r.fn, params };
    }
    return null;
  }
}

export function json(res, data, status = 200, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

export async function readBody(req, limit = 50 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw badRequest('Invalid JSON');
  }
}

export function contentDisposition(name, attachment) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Stream a file with Range support. */
export function sendFile(req, res, file, { type, cache = 'private, max-age=86400', headers = {} } = {}) {
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st?.isFile()) throw notFound();
  const r = parseRange(req.headers.range, st.size);
  if (r === false) return res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
  const { start, end } = r ?? { start: 0, end: st.size - 1 };
  res.writeHead(r ? 206 : 200, {
    'Content-Type': type || 'application/octet-stream',
    'Content-Length': Math.max(0, end - start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache,
    'Last-Modified': st.mtime.toUTCString(),
    ...(r && { 'Content-Range': `bytes ${start}-${end}/${st.size}` }),
    // Library files are untrusted: never sniff them into HTML/SVG, and sandbox any direct navigation.
    // Scripts are exempt (a worker script's own CSP would block its preview fetches).
    ...(!/javascript/.test(type ?? '') && {
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
      'X-Frame-Options': 'DENY',
    }),
    ...headers,
  });
  if (req.method === 'HEAD' || st.size === 0) return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}
