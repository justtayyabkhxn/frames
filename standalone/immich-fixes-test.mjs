// Regression checks for the deep-scan findings: node standalone/immich-fixes-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { setup } from './immich-harness.mjs';
import { sendFile } from './lib/http.mjs';
import { toUuid } from './lib/immich/ids.mjs';
import { Library } from './lib/library.mjs';

const { api, call, media, db, ctx, tmp } = setup();
const U = (id) => toUuid('asset', id);
const exifWrites = [];
ctx.setExif = async (id, raw) => exifWrites.push([id, raw]);

// 1. Southern/western locations keep their sign (exiftool -n needs N/S/E/W refs)
const a = media('2024/a.jpg', '2024-03-05T10:00:00', { exif: { Orientation: 6 }, w: 300, h: 400 });
await api('PUT', `/api/assets/${U(a)}`, { latitude: -33.86, longitude: 151.2 });
assert.deepEqual(exifWrites.at(-1)[1], {
  GPSLatitude: -33.86,
  GPSLongitude: 151.2,
  GPSLatitudeRef: 'S',
  GPSLongitudeRef: 'E',
});
await api('PUT', `/api/assets/${U(a)}`, { latitude: 40.7, longitude: -74 });
assert.deepEqual([exifWrites.at(-1)[1].GPSLatitudeRef, exifWrites.at(-1)[1].GPSLongitudeRef], ['N', 'W']);

// 11. Relative date shift moves the date taken (by minutes)
await api('PUT', '/api/assets', { ids: [U(a)], dateTimeRelative: 90 });
assert.equal(exifWrites.at(-1)[1].AllDates, '2024:03:05 11:30:00');

// Minor: dimensions are already display dimensions, so no orientation is sent to be applied twice
const info = await api('GET', `/api/assets/${U(a)}`);
assert.deepEqual(
  [info.exifInfo.exifImageWidth, info.exifInfo.exifImageHeight, info.exifInfo.orientation],
  [300, 400, null],
);

// 9. 360° panoramas (indexer stores pano = 1)
db.exec(`UPDATE media SET pano = 1 WHERE id = ${a}`);
assert.equal((await api('GET', `/api/assets/${U(a)}`)).exifInfo.projectionType, 'EQUIRECTANGULAR');

// 3. Place filters match translated names too
db.exec(`CREATE TABLE IF NOT EXISTS planet (osm_id INTEGER PRIMARY KEY, admin_level INTEGER NOT NULL, name TEXT NOT NULL, other_names TEXT);
  CREATE TABLE IF NOT EXISTS places (fileid INTEGER NOT NULL, osm_id INTEGER NOT NULL, mark INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (fileid, osm_id));
  INSERT INTO planet VALUES (3, 8, 'München', '{"en":"Munich","de":"München"}'); INSERT INTO places (fileid, osm_id) VALUES (${a}, 3)`);
const count = async (q) => (await api('GET', `/api/timeline/buckets?${q}`)).reduce((n, b) => n + b.count, 0);
assert.equal(await count('city=Munich'), 1);
assert.equal(await count('city=M%C3%BCnchen'), 1);

// Minor: description filter also looks at ImageDescription
const d = media('2024/d.jpg', '2024-03-06T10:00:00', { exif: { ImageDescription: 'Sunset at sea' } });
assert.equal(await count('description=sunset'), 1);

// 4. New people are new and unnamed, even for a taken or numeric name
db.exec(`INSERT INTO people (id, name) VALUES (500, 'Alice')`);
const p1 = await api('POST', '/api/people', {});
const p2 = await api('POST', '/api/people', { name: 'Alice' });
const p3 = await api('POST', '/api/people', { name: '8' });
assert.equal(p1.name, '');
assert.notEqual(p2.id, toUuid('person', 500));
assert.equal(p3.name, '8');
assert.notEqual(p3.id, toUuid('person', 8));

// Minor: merging a named person into an unnamed one keeps the name
db.exec(`INSERT INTO people (id, name, birthdate) VALUES (600, 'Bob', '1990-01-01');
  INSERT INTO faces (id, point, fileid, cluster, x, y, w, h, score) VALUES (1, 'p1', ${a}, 600, 0, 0, .1, .1, .9), (2, 'p2', ${d}, 700, 0, 0, .1, .1, .9)`);
await api('POST', `/api/people/${toUuid('person', 700)}/merge`, { ids: [toUuid('person', 600)] });
assert.deepEqual(
  { ...db.q('SELECT name, birthdate FROM people WHERE id = 700').get() },
  { name: 'Bob', birthdate: '1990-01-01' },
);

// 5. Memories follow the client's day (?for=)
media('2023/m.jpg', '2023-07-20T09:00:00');
assert.equal((await api('GET', '/api/memories?for=2026-07-20T00:00:00.000Z')).length, 1);
assert.equal((await api('GET', '/api/memories?for=2026-01-10T00:00:00.000Z')).length, 0);

// 7. Delete/archive only accept photos and videos, never folders
const folder = db.q("SELECT id FROM nodes WHERE path = '2024'").get().id;
assert.equal((await call('DELETE', '/api/assets', { ids: [U(folder)], force: true })).status, 404);
assert.equal((await call('PUT', '/api/assets', { ids: [U(folder)], visibility: 'archive' })).status, 404);

// Minor: Explore never uses archived photos as covers
ctx.addressOf = () => ['Pune', 'India'];
db.exec(`UPDATE media SET lat = 1, lon = 1 WHERE id = ${d}; UPDATE nodes SET archived = 1 WHERE id = ${d}`);
assert.ok(!(await api('GET', '/api/search/explore'))[0].items.some((i) => i.data.id === U(d)));

// Minor: only "start" rescans; pause/resume/empty do not
let scans = 0;
ctx.indexer.scan = () => scans++;
await api('PUT', '/api/jobs/library', { command: 'pause' });
await api('PUT', '/api/jobs/library', { command: 'start' });
assert.equal(scans, 1);

// 6. Resolving a duplicate group with nothing to trash keeps all and succeeds
const g1 = media('dup/x.jpg', '2024-05-01T10:00:00', { size: 10 });
const g2 = media('dup/y.jpg', '2024-05-01T10:00:00', { size: 10 });
ctx.lens.get = async () => ({ groups: [[g1, g2]] });
const [group] = await api('GET', '/api/duplicates');
const [r] = await api('POST', '/api/duplicates/resolve', {
  groups: [{ duplicateId: group.duplicateId, keepAssetIds: [U(g1), U(g2)], trashAssetIds: [] }],
});
assert.equal(r.success, true);
assert.deepEqual(await api('GET', '/api/duplicates'), []);

// 8. Restoring from the Bin brings back albums, tags and faces
ctx.dataDir = tmp;
ctx.previews = { remove() {}, get: async (k, f) => f };
ctx.lib = new Library(ctx);
ctx.indexer.indexPath = async (rel) =>
  db.q('SELECT id FROM nodes WHERE path = ?').get(rel)?.id ?? media(rel, '2024-08-01T10:00:00');
const r1 = media('keep/r.jpg', '2024-08-01T10:00:00');
fs.mkdirSync(path.join(tmp, 'keep'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'keep/r.jpg'), 'r');
db.exec(`INSERT INTO albums (id, name, created, updated) VALUES (9, 'Trip', 0, 0); INSERT INTO album_files VALUES (9, ${r1}, 0);
  INSERT INTO tags (id, name) VALUES (9, 'Fun'); INSERT INTO tag_files VALUES (9, ${r1});
  INSERT INTO faces (id, point, fileid, cluster, x, y, w, h, score) VALUES (9, 'p9', ${r1}, 500, .2, .2, .1, .1, .9)`);
await api('DELETE', '/api/assets', { ids: [U(r1)] });
const tid = (await api('GET', '/api/timeline/bucket?isTrashed=true&timeBucket=2024-08-01')).id[0];
await api('POST', '/api/trash/restore/assets', { ids: [tid] });
const back = db.q("SELECT id FROM nodes WHERE path = 'keep/r.jpg'").get().id;
assert.ok(db.q('SELECT 1 FROM album_files WHERE album = 9 AND fileid = ?').get(back));
assert.ok(db.q('SELECT 1 FROM tag_files WHERE tag = 9 AND fileid = ?').get(back));
assert.equal(db.q('SELECT person FROM face_imports WHERE fileid = ?').get(back)?.person, 500);

// 2. A file that vanishes between stat and open does not crash the server
const gone = path.join(tmp, 'gone.jpg');
fs.writeFileSync(gone, 'x');
const res = new Writable({ write: (c, e, cb) => cb() });
res.writeHead = () => res;
let destroyed = false;
res.on('close', () => (destroyed = true));
sendFile({ headers: {}, method: 'GET' }, res, gone, { type: 'image/jpeg' });
fs.rmSync(gone);
await new Promise((r) => setTimeout(r, 50));
assert.ok(destroyed);

// Indexing: one photo whose thumbnails fail (e.g. Windows "permission denied" on a file the browser has open)
// must not stop the rest; first-time indexing never deletes thumbnails made on demand meanwhile.
{
  const { Indexer } = await import('./lib/indexer.mjs');
  const h = setup();
  const ix = new Indexer(h.ctx);
  h.ctx.abs = (rel) => path.join(h.tmp, rel);
  ix.readMeta = async (paths) => new Map(paths.map((p) => [path.resolve(p), { MIMEType: 'image/jpeg' }]));
  const removed = [];
  h.ctx.previews = {
    remove: (id) => removed.push(id),
    generate: async (id) => {
      if (id === ids[1]) throw Object.assign(new Error('EPERM, Permission denied'), { code: 'EPERM' });
    },
  };
  const ids = ['x/a.jpg', 'x/b.jpg', 'x/c.jpg'].map((rel) => ix.ensureNode(rel, { dir: false, size: 1, mtime: 1 }));
  let done = 0;
  await ix.indexIds(ids, () => done++);
  assert.equal(h.db.q(`SELECT count(*) AS n FROM media WHERE id IN (${ids})`).get().n, 3);
  assert.equal(done, 3);
  assert.deepEqual(removed, []);
  // A changed photo does drop its old thumbnails
  await ix.indexIds([ids[0]]);
  assert.deepEqual(removed, [ids[0]]);
}

// The UI's activity pill reads the indexer's status, the AI stage and the photo count
{
  const h = setup();
  h.media('2024/p.jpg', '2024-01-01T10:00:00');
  Object.assign(h.ctx.indexer.status, {
    phase: 'indexing',
    done: 3,
    total: 9,
    ai: { state: 'indexing', stage: 'faces', queued: 5 },
  });
  const s = await h.api('GET', '/api/frames/status');
  assert.deepEqual([s.phase, s.done, s.total, s.ai.stage, s.count], ['indexing', 3, 9, 'faces', 1]);
}
console.log('ok');
