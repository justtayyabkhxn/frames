// Self-check for the Immich API that serves Gallery's web UI: node standalone/immich-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateHeaderValue } from 'node:http';
import { Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './lib/db.mjs';
import { Router } from './lib/http.mjs';
import { fromUuid, toUuid } from './lib/immich/ids.mjs';
import { registerImmich } from './lib/immich/server.mjs';
import { registerAi } from './lib/ai.mjs';
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
const lensCalls = [];
ctx.lens = { state: 'ready', post: async (p, b) => (lensCalls.push([p, b]), { items: [] }) };
registerApi(router, ctx);
registerAi(router, ctx);
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
  const chunks2 = [];
  const res = new Writable({
    write(chunk, _, cb) {
      chunks2.push(Buffer.from(chunk));
      cb();
    },
  });
  Object.assign(res, { status: 200, headers: {} });
  res.writeHead = (st, h = {}) => (
    Object.entries(h).forEach(([k, v]) => validateHeaderValue(k, v)),
    Object.assign(res, { status: st, headersSent: true }),
    Object.assign(res.headers, h),
    res
  );
  res.setHeader = (k, v) => (res.headers[k] = v);
  const done = new Promise((r) => res.on('finish', r));
  try {
    await m.fn(req, res, m.params, url);
  } catch (e) {
    return { status: e.status ?? 500, headers: {}, body: Buffer.from(JSON.stringify({ message: e.message })) };
  }
  await done;
  res.body = Buffer.concat(chunks2);
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

// Review fixes: scoped and locked queries must not 500; video duration in ms; non-ASCII downloads; fixed routes before :id
for (const q of [
  `albumId=${toUuid('album', 1)}`,
  `personId=${toUuid('person', 1)}`,
  `tagId=${toUuid('tag', 1)}`,
  'visibility=locked',
  'visibility=hidden',
  `visibility=archive&albumId=${toUuid('album', 1)}`,
])
  assert.equal((await call('GET', `/api/timeline/buckets?${q}`)).status, 200, q);
db.exec('UPDATE nodes SET name = \'写真 "x".jpg\' WHERE id = 4');

// Media: thumbnails from Frames previews, originals and video with Range, bad ids are 400s
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-immich-'));
fs.writeFileSync(path.join(tmp, 'a.jpg'), 'JPEGDATA');
fs.writeFileSync(path.join(tmp, 'preview.jpg'), 'PREVIEW');
ctx.lib.abs = (rel) => path.join(tmp, rel);
const asked = [];
ctx.previewFile = async (id, x, y, sq) => (asked.push([id, x, y, sq]), { file: path.join(tmp, 'preview.jpg') });
let r = await call('GET', `/api/assets/${toUuid('asset', 2)}/thumbnail?size=thumbnail`);
assert.equal(r.status, 200);
assert.equal(r.headers['Content-Type'], 'image/jpeg');
assert.deepEqual(asked.at(-1), [2, 250, 250, false]);
await call('GET', `/api/assets/${toUuid('asset', 2)}/thumbnail?size=preview`);
assert.deepEqual(asked.at(-1), [2, 1440, 1440, false]);
r = await call('GET', `/api/assets/${toUuid('asset', 2)}/original`, undefined, { range: 'bytes=0-1' });
assert.equal(r.status, 206);
r = await call('GET', '/api/assets/not-a-uuid/thumbnail');
assert.equal(r.status, 400);
fs.writeFileSync(path.join(tmp, '.archive'), '');
fs.mkdirSync(path.join(tmp, '.archive2'), { recursive: true });
ctx.lib.abs = (rel) => path.join(tmp, rel.replace('.archive/', ''));
fs.writeFileSync(path.join(tmp, 'c.jpg'), 'JPEG');
r = await call('GET', `/api/assets/${toUuid('asset', 4)}/original?download=true`);
assert.equal(r.status, 200);
assert.match(r.headers['Content-Disposition'], /attachment/);
assert.equal((await api('GET', `/api/assets/${toUuid('asset', 3)}`)).duration, 6000);
assert.equal((await api('GET', `/api/assets/${toUuid('asset', 2)}`)).duration, null);
assert.deepEqual(await api('GET', '/api/assets/statistics'), { images: 2, videos: 1, total: 3 });

// Asset info and actions: favorite, archive, rating/description via EXIF, delete to trash
db.exec(
  `UPDATE media SET exif = json_object('Make', 'Canon', 'Model', 'EOS R6', 'FNumber', 2.8, 'ExposureTime', 0.01, 'ISO', 400, 'Rating', 3) WHERE id = 2`,
);
const calls = [];
Object.assign(ctx.lib, {
  setArchived: (id, on) => calls.push(['archive', id, on]),
  trash: (id) => calls.push(['trash', id]),
  mustNode: ctx.lib.node,
});
ctx.setExif = async (id, raw) => calls.push(['exif', id, raw]);
ctx.addressOf = () => ['Pune', 'Maharashtra', 'India'];
const a2 = toUuid('asset', 2);
const info = await api('GET', `/api/assets/${a2}`);
assert.equal(info.id, a2);
assert.equal(info.type, 'IMAGE');
assert.equal(info.originalFileName, 'a.jpg');
assert.deepEqual(
  [
    info.exifInfo.make,
    info.exifInfo.model,
    info.exifInfo.fNumber,
    info.exifInfo.exposureTime,
    info.exifInfo.iso,
    info.exifInfo.rating,
  ],
  ['Canon', 'EOS R6', 2.8, '1/100', 400, 3],
);
assert.deepEqual([info.exifInfo.city, info.exifInfo.state, info.exifInfo.country], ['Pune', 'Maharashtra', 'India']);
assert.equal(info.isArchived, false);
await api('PUT', '/api/assets', { ids: [a2], isFavorite: true });
assert.equal(db.q('SELECT favorite FROM nodes WHERE id = 2').get().favorite, 1);
await api('PUT', '/api/assets', { ids: [a2], visibility: 'archive' });
await api('PUT', `/api/assets/${a2}`, { rating: 4, description: 'hi' });
await call('DELETE', '/api/assets', { ids: [a2] });
assert.deepEqual(calls, [
  ['archive', 2, true],
  ['exif', 2, { Rating: 4, Description: 'hi' }],
  ['trash', 2],
]);

// People: list, hide, rename, statistics, faces of an asset, merge, search
db.exec(`DELETE FROM trash; INSERT INTO people (id, name) VALUES (100, 'Alice');
  INSERT INTO faces (id, point, fileid, cluster, x, y, w, h, score) VALUES
    (1, 'p1', 2, 100, 0.1, 0.2, 0.25, 0.5, 0.9), (2, 'p2', 3, 100, 0, 0, 0.1, 0.1, 0.9), (3, 'p3', 4, 200, 0, 0, 0.1, 0.1, 0.9)`);
const alice = toUuid('person', 100);
const anon = toUuid('person', 200);
let people = await api('GET', '/api/people?withHidden=true');
assert.equal(people.total, 2);
assert.deepEqual(
  people.people.map((p) => [p.id, p.name, p.numberOfAssets, p.isHidden]),
  [
    [alice, 'Alice', 2, false],
    [anon, '', 1, false],
  ],
);
await api('PUT', `/api/people/${anon}`, { isHidden: true });
people = await api('GET', '/api/people');
assert.deepEqual([people.total, people.hidden, people.people.length], [2, 1, 1]);
assert.equal((await api('PUT', `/api/people/${anon}`, { name: 'Bob', isHidden: false })).name, 'Bob');
assert.deepEqual(await api('GET', `/api/people/${alice}/statistics`), { assets: 2, faces: 2 });
const faces = await api('GET', `/api/faces?id=${toUuid('asset', 2)}`);
assert.equal(faces.length, 1);
assert.equal(faces[0].person.name, 'Alice');
assert.deepEqual(
  [
    faces[0].imageWidth,
    faces[0].imageHeight,
    faces[0].boundingBoxX1,
    faces[0].boundingBoxY1,
    faces[0].boundingBoxX2,
    faces[0].boundingBoxY2,
  ],
  [400, 300, 40, 60, 140, 210],
);
assert.deepEqual(
  (await api('GET', '/api/search/person?name=ali')).map((p) => p.name),
  ['Alice'],
);
assert.deepEqual(await api('POST', `/api/people/${alice}/merge`, { ids: [anon] }), [{ id: anon, success: true }]);
assert.equal(db.q('SELECT cluster FROM faces WHERE id = 3').get().cluster, 100);
assert.deepEqual(lensCalls.at(-1), ['/v1/faces/assign', { ids: ['p3'], cluster_id: 100 }]);
assert.equal((await api('GET', `/api/people/${alice}`)).name, 'Alice');
assert.deepEqual(
  (await api('GET', `/api/assets/${toUuid('asset', 2)}`)).people.map((p) => p.name),
  ['Alice'],
);

console.log('ok');
