// Self-check for the Immich API that serves Gallery's web UI: node standalone/immich-test.mjs
import assert from 'node:assert/strict';
import { openDb } from './lib/db.mjs';
import { Router } from './lib/http.mjs';
import { fromUuid, toUuid } from './lib/immich/ids.mjs';
import { registerImmich } from './lib/immich/server.mjs';
import { registerApi } from './lib/api.mjs';

assert.equal(fromUuid(toUuid('asset', 1234), 'asset'), 1234);
assert.equal(fromUuid(toUuid('person', 2 ** 52 + 7), 'person'), 2 ** 52 + 7);
assert.match(toUuid('asset', 1), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
assert.throws(() => fromUuid('not-a-uuid', 'asset'));
assert.throws(() => fromUuid(toUuid('album', 5), 'asset'));

const db = openDb(':memory:');
const ctx = { db, root: process.cwd(), dayFilters: [], clustersOf: {}, indexer: { status: {} }, displayName: 'Me' };
const router = new Router();
Object.assign(ctx, { uid: 'me', lib: { node: (id) => db.q('SELECT * FROM nodes WHERE id = ?').get(id) } });
registerApi(router, ctx);
registerImmich(router, ctx);

export const call = async (method, p, body, headers = {}) => {
  const url = new URL(`http://x${p}`);
  const m = router.match(method, url.pathname);
  assert.ok(m, `no route for ${method} ${url.pathname}`);
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    headers,
    url: p,
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
  const res = {
    status: 200,
    headers: {},
    headersSent: false,
    writeHead(s, h) {
      this.status = s;
      Object.assign(this.headers, h);
      this.headersSent = true;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
    write(b) {
      (this.chunks ??= []).push(Buffer.from(b));
      return true;
    },
    end(b) {
      if (b) (this.chunks ??= []).push(Buffer.from(b));
      this.body = Buffer.concat(this.chunks ?? []);
      this.headersSent = true;
    },
    on() {},
    once() {},
    emit() {},
  };
  await m.fn(req, res, m.params, url);
  return res;
};
export const api = async (method, p, body) => {
  const res = await call(method, p, body);
  return res.body?.length ? JSON.parse(res.body) : undefined;
};

const cfg = await api('GET', '/api/server/config');
assert.equal(cfg.isInitialized, true);
assert.equal(cfg.isOnboarded, true);
const me = await api('GET', '/api/users/me');
assert.equal(me.isAdmin, true);
assert.ok(me.license);
assert.equal((await api('GET', '/api/server/features')).ocr, false);
assert.equal((await api('GET', '/api/admin/config')).machineLearning.facialRecognition.modelName, 'buffalo_l');
assert.ok((await api('GET', '/api/public/config')).ffmpeg);
const prefs = await api('PUT', '/api/users/me/preferences', { ratings: { enabled: true } });
assert.equal(prefs.ratings.enabled, true);
assert.equal(prefs.people.enabled, true);
assert.deepEqual(await api('GET', '/api/notifications'), []);

// Timeline: month buckets of the main timeline (archived files only with visibility=archive), columnar buckets
db.exec(
  `INSERT INTO nodes (id, path, parent, name, dir) VALUES (1, '', NULL, '', 1), (9, '.archive', 1, '.archive', 1)`,
);
const media = (id, path, taken, extra = '') =>
  db.exec(`INSERT INTO nodes (id, path, parent, name, dir, etag, mime, size) VALUES (${id}, '${path}', 1, '${path.split('/').pop()}', 0, 'e${id}', 'image/jpeg', 100);
    INSERT INTO media (id, datetaken, dayid, epoch, w, h, indexed_at ${extra ? ', ' + extra.split('=')[0] : ''})
    VALUES (${id}, ${taken}, ${Math.floor(taken / 86400)}, ${taken - 3600 * 5.5}, 400, 300, 0 ${extra ? ', ' + extra.split('=')[1] : ''})`);
const T = (s) => Date.parse(`${s}Z`) / 1000;
media(2, 'a.jpg', T('2024-03-05T10:00:00'));
media(3, 'b.jpg', T('2024-03-20T10:00:00'), 'isvideo=1');
media(4, '.archive/c.jpg', T('2024-01-02T10:00:00'));
db.exec('UPDATE media SET video_duration = 6 WHERE id = 3');
assert.deepEqual(await api('GET', '/api/timeline/buckets?visibility=timeline'), [
  { timeBucket: '2024-03-01', count: 2 },
]);
assert.deepEqual(await api('GET', '/api/timeline/buckets?visibility=archive'), [
  { timeBucket: '2024-01-01', count: 1 },
]);
const b = await api('GET', '/api/timeline/bucket?timeBucket=2024-03-01&visibility=timeline');
assert.deepEqual(b.id, [toUuid('asset', 3), toUuid('asset', 2)]);
assert.deepEqual(b.ratio, [4 / 3, 4 / 3]);
assert.deepEqual(b.isImage, [false, true]);
assert.deepEqual(b.duration, [6000, null]);
assert.deepEqual(b.localOffsetHours, [5.5, 5.5]);
assert.deepEqual(b.visibility, ['timeline', 'timeline']);
for (const k of [
  'createdAt',
  'fileCreatedAt',
  'isFavorite',
  'isTrashed',
  'livePhotoVideoId',
  'ownerId',
  'projectionType',
  'thumbhash',
  'stack',
])
  assert.equal(b[k].length, 2, k);
assert.deepEqual(await api('GET', '/api/timeline/buckets?isTrashed=true'), []);

console.log('ok');
