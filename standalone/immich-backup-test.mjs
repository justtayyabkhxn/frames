// Self-check for Frames export/import: node standalone/immich-backup-test.mjs
import assert from 'node:assert/strict';
import { setup } from './immich-harness.mjs';
import { toUuid } from './lib/immich/ids.mjs';

/** A library with the same photos in both runs (ids differ between them, one file moved). */
const library = (h, moved = false) => {
  const a = h.media('2024/a.jpg', '2024-03-05T10:00:00', { size: 111 });
  const b = h.media(moved ? 'Other/b.jpg' : '2024/b.jpg', '2024-03-06T10:00:00', { size: 222 });
  const c = h.media('2023/c.jpg', '2023-12-25T10:00:00', { size: 333, exif: { Rating: 2 } });
  return { a, b, c };
};

// ---- source library: favorites, archive, albums, tags, people + faces, a face decision, settings
const src = setup();
const s = library(src);
src.ctx.dataDir = src.tmp;
src.ctx.setExif = async () => {};
const { db: sdb, api: sapi } = src;
sdb.exec(`UPDATE nodes SET favorite = 1 WHERE id = ${s.a}; UPDATE nodes SET archived = 1 WHERE id = ${s.c};
  UPDATE media SET lat = 18.5, lon = 73.8, exif = json_object('Description', 'Diwali') WHERE id = ${s.b}`);
await sapi('POST', '/api/albums', {
  albumName: 'Trip',
  description: 'Goa',
  assetIds: [toUuid('asset', s.a), toUuid('asset', s.b)],
});
await sapi('PUT', '/api/tags', { tags: ['Travel/2024'] });
const tag = (await sapi('GET', '/api/tags')).find((t) => t.value === 'Travel/2024');
await sapi('PUT', `/api/tags/${tag.id}/assets`, { ids: [toUuid('asset', s.b)] });
sdb.exec(`INSERT INTO people (id, name, favorite) VALUES (500, 'Alice', 1);
  INSERT INTO faces (id, point, fileid, cluster, x, y, w, h, score) VALUES
    (1, 'p1', ${s.a}, 500, 0.1, 0.1, 0.2, 0.2, 0.9), (2, 'p2', ${s.b}, 500, 0.5, 0.5, 0.2, 0.2, 0.9),
    (3, 'p3', ${s.c}, 700, 0.3, 0.3, 0.2, 0.2, 0.9), (4, 'p4', ${s.c}, NULL, 0.6, 0.1, 0.1, 0.1, 0.9);
  INSERT INTO face_verdicts (point, cluster, status) VALUES ('p4', 500, 'rejected');
  UPDATE people SET cover = 2 WHERE id = 500`);
await sapi('PUT', '/api/users/me/preferences', { ratings: { enabled: false } });

const { name, counts } = await sapi('POST', '/api/frames/export', {});
assert.match(name, /^frames-export-.*\.json$/);
assert.deepEqual([counts.files, counts.albums, counts.tags, counts.people, counts.faces], [3, 1, 2, 1, 3]);
assert.equal((await sapi('GET', '/api/frames/exports'))[0].name, name);
const exported = JSON.parse((await src.call('GET', `/api/frames/exports/${name}`)).body);
assert.ok(exported.files.find((f) => f.path === '2024/b.jpg').lat);
assert.equal((await src.call('GET', '/api/frames/exports/..%2F..%2Fsecret.json')).status, 400);

// ---- fresh library (new ids, b moved): import restores everything, faces once detected here
const dst = setup();
const d = library(dst, true);
dst.ctx.dataDir = dst.tmp;
const written = [];
dst.ctx.setExif = async (id, raw) => written.push([id, raw]);
const { db: ddb, api: dapi } = dst;
// The AI engine already found faces here, boxes a little different from the source
ddb.exec(`INSERT INTO faces (id, point, fileid, cluster, x, y, w, h, score) VALUES
  (11, 'q1', ${d.a}, 9001, 0.11, 0.1, 0.2, 0.2, 0.9), (12, 'q2', ${d.b}, NULL, 0.5, 0.52, 0.2, 0.2, 0.9),
  (13, 'q3', ${d.c}, 9002, 0.3, 0.3, 0.21, 0.2, 0.9), (14, 'q4', ${d.c}, NULL, 0.6, 0.1, 0.1, 0.1, 0.9)`);
const res = await dapi('POST', '/api/frames/import', exported);
assert.deepEqual([res.files, res.missing, res.albums, res.tags, res.people, res.faces], [3, 0, 1, 2, 1, 3]);

assert.equal(ddb.q('SELECT favorite FROM nodes WHERE id = ?').get(d.a).favorite, 1);
assert.equal(ddb.q('SELECT archived FROM nodes WHERE id = ?').get(d.c).archived, 1);
const album = (await dapi('GET', '/api/albums')).find((x) => x.albumName === 'Trip');
assert.equal(album.description, 'Goa');
assert.equal(album.assetCount, 2);
assert.deepEqual(
  (
    await dapi(
      'GET',
      `/api/timeline/buckets?tagId=${(await dapi('GET', '/api/tags')).find((t) => t.value === 'Travel/2024').id}`,
    )
  )[0].count,
  1,
);
assert.deepEqual(
  ddb
    .q('SELECT id, cluster FROM faces ORDER BY id')
    .all()
    .map((f) => [f.id, f.cluster]),
  [
    [11, 500],
    [12, 500],
    [13, 700],
    [14, null],
  ],
);
assert.equal(ddb.q('SELECT name, favorite, cover FROM people WHERE id = 500').get().name, 'Alice');
assert.equal(ddb.q('SELECT cover FROM people WHERE id = 500').get().cover, 12);
assert.equal(ddb.q("SELECT status FROM face_verdicts WHERE point = 'q4'").get().status, 'rejected');
assert.equal(JSON.parse(ddb.getKv('immich.prefs')).ratings.enabled, false);
// Location and description were missing from the moved file here, so they are written to it
assert.deepEqual(
  written.map(([id, raw]) => [id, raw.Description, raw.GPSLatitude]),
  [[d.b, 'Diwali', 18.5]],
);

// Faces not scanned yet wait and apply after the AI engine finds them
const late = setup();
const l = library(late);
late.ctx.dataDir = late.tmp;
late.ctx.setExif = async () => {};
await late.api('POST', '/api/frames/import', exported);
assert.equal(late.db.q('SELECT count(*) AS n FROM face_imports').get().n > 0, true);
late.db.exec(
  `INSERT INTO faces (id, point, fileid, cluster, x, y, w, h, score) VALUES (21, 'r1', ${l.a}, NULL, 0.1, 0.1, 0.2, 0.2, 0.9)`,
);
await late.ctx.applyFaceImports();
assert.equal(late.db.q('SELECT cluster FROM faces WHERE id = 21').get().cluster, 500);

assert.equal((await dst.call('POST', '/api/frames/import', { hello: 1 })).status, 400);
console.log('ok');
