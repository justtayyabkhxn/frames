// Shared setup for the Immich API self-checks (immich-*-test.mjs): an in-memory Frames with
// Frames' own api/ai modules, a stub lens, and helpers to call routes and add media.
import fs from 'node:fs';
import { validateHeaderValue } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { registerAi } from './lib/ai.mjs';
import { registerApi } from './lib/api.mjs';
import { openDb } from './lib/db.mjs';
import { Router } from './lib/http.mjs';
import { registerImmich } from './lib/immich/server.mjs';

/**
 * @param register optional (router, ctx, A) => void to register a module under test that
 *   registerImmich does not include yet; A is the same apiRouter registerImmich returns.
 */
export function setup({ lensPost, lensGet, register } = {}) {
  const db = openDb(':memory:');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-immich-'));
  const lensCalls = [];
  const ctx = {
    db,
    root: tmp,
    dayFilters: [],
    clustersOf: {},
    indexer: { status: {}, indexPath: async () => {} },
    displayName: 'Me',
    uid: 'me',
    lens: {
      state: 'ready',
      post: async (p, b) => (lensCalls.push(['POST', p, b]), lensPost ? lensPost(p, b) : { items: [] }),
      get: async (p) => (lensCalls.push(['GET', p]), lensGet ? lensGet(p) : {}),
    },
    lib: {
      node: (id) => db.q('SELECT * FROM nodes WHERE id = ?').get(Number(id)),
      mustNode: (id) => db.q('SELECT * FROM nodes WHERE id = ?').get(Number(id)),
      abs: (rel) => path.join(tmp, rel),
      trash: (id) => lensCalls.push(['trash', Number(id)]),
      setArchived: (id, on) => lensCalls.push(['archive', Number(id), on]),
    },
  };
  const router = new Router();
  registerApi(router, ctx);
  registerAi(router, ctx);
  const A = registerImmich(router, ctx);
  register?.(router, ctx, A);
  db.exec(`INSERT INTO nodes (id, path, parent, name, dir) VALUES (1, '', NULL, '', 1)`);

  /** Run one request through the router like server.mjs does; errors become status codes. */
  const call = async (method, p, body, headers = {}) => {
    const url = new URL(`http://x${p}`);
    const m = router.match(method, url.pathname);
    if (!m) return { status: 404, headers: {}, body: Buffer.from('{"message":"no route"}') };
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = {
      method,
      headers,
      url: p,
      async *[Symbol.asyncIterator]() {
        yield* chunks;
      },
    };
    const out = [];
    const res = new Writable({
      write(chunk, _, cb) {
        out.push(Buffer.from(chunk));
        cb();
      },
    });
    Object.assign(res, { status: 200, headers: {} });
    res.writeHead = (st, h = {}) => {
      for (const [k, v] of Object.entries(h)) validateHeaderValue(k, v);
      Object.assign(res, { status: st, headersSent: true });
      Object.assign(res.headers, h);
      return res;
    };
    res.setHeader = (k, v) => (res.headers[k] = v);
    const done = new Promise((r) => res.on('finish', r));
    try {
      await m.fn(req, res, m.params, url);
    } catch (e) {
      return { status: e.status ?? 500, headers: {}, body: Buffer.from(JSON.stringify({ message: e.message })) };
    }
    await done;
    res.body = Buffer.concat(out);
    return res;
  };
  /** JSON body of a request; throws with the server message on a non-2xx status. */
  const api = async (method, p, body) => {
    const res = await call(method, p, body);
    if (res.status >= 400) throw new Error(`${method} ${p} -> ${res.status} ${res.body}`);
    return res.body?.length ? JSON.parse(res.body) : undefined;
  };

  const T = (s) => Date.parse(`${s}Z`) / 1000;
  /** Add a file (and folders on the way) with media metadata; returns its id. */
  let next = 100;
  const media = (rel, taken, { video = false, size = 100, w = 400, h = 300, exif = {}, favorite = 0 } = {}) => {
    let parent = 1;
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      parent =
        db.q('SELECT id FROM nodes WHERE path = ?').get(dir)?.id ??
        db
          .q('INSERT INTO nodes (id, path, parent, name, dir) VALUES (?, ?, ?, ?, 1) RETURNING id')
          .get(next++, dir, parent, parts[i - 1]).id;
    }
    const id = next++;
    db.q(
      `INSERT INTO nodes (id, path, parent, name, dir, etag, mime, size, favorite) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    ).run(id, rel, parent, parts.at(-1), `e${id}`, video ? 'video/mp4' : 'image/jpeg', size, favorite);
    const t = T(taken);
    db.q(
      `INSERT INTO media (id, datetaken, dayid, epoch, w, h, isvideo, video_duration, exif, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(id, t, Math.floor(t / 86400), t, w, h, video ? 1 : 0, video ? 5 : 0, JSON.stringify(exif));
    return id;
  };

  return { db, ctx, router, call, api, media, T, tmp, lensCalls };
}
