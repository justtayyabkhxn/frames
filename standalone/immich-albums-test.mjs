// Self-check for the Immich albums API: node standalone/immich-albums-test.mjs
import assert from 'node:assert/strict';
import { setup } from './immich-harness.mjs';
import { toUuid } from './lib/immich/ids.mjs';

const { api, call, media, db } = setup();

const a1 = media('2020/a.jpg', '2020-01-01T10:00:00');
const a2 = media('2020/b.jpg', '2020-06-01T10:00:00');
const a3 = media('2021/c.jpg', '2021-03-01T10:00:00');
db.q('UPDATE media SET lat = 48.8, lon = 2.3 WHERE id = ?').run(a2);
const U = (id) => toUuid('asset', id);

// Create
const created = await api('POST', '/api/albums', { albumName: 'Trip', description: 'Fun', assetIds: [U(a1), U(a2)] });
assert.equal(created.albumName, 'Trip');
assert.equal(created.description, 'Fun');
assert.equal(created.assetCount, 2);
assert.equal(created.shared, false);
assert.equal(created.hasSharedLink, false);
assert.equal(created.albumUsers[0].role, 'owner');
assert.equal(created.albumThumbnailAssetId, U(a2));
assert.equal(created.startDate, '2020-01-01T10:00:00.000Z');
assert.equal(created.endDate, '2020-06-01T10:00:00.000Z');
const id = created.id;
await api('POST', '/api/albums', { albumName: 'Other' });

// List
assert.deepEqual((await api('GET', '/api/albums')).map((a) => a.albumName).sort(), ['Other', 'Trip']);
assert.deepEqual(
  (await api('GET', `/api/albums?assetId=${U(a1)}`)).map((a) => a.id),
  [id],
);
assert.deepEqual(await api('GET', '/api/albums?shared=true'), []);

// Get
const got = await api('GET', `/api/albums/${id}?withoutAssets=false`);
assert.deepEqual(got.assets.map((a) => a.id).sort(), [U(a1), U(a2)].sort());
assert.equal((await api('GET', `/api/albums/${id}`)).assets, undefined);
assert.equal((await call('GET', `/api/albums/${toUuid('album', 999)}`)).status, 404);

// Update
const upd = await api('PATCH', `/api/albums/${id}`, {
  albumName: 'Holiday',
  description: 'Nice',
  albumThumbnailAssetId: U(a1),
  order: 'asc',
});
assert.equal(upd.albumName, 'Holiday');
assert.equal(upd.description, 'Nice');
assert.equal(upd.albumThumbnailAssetId, U(a1));
assert.equal(upd.order, 'asc');
assert.equal((await call('PATCH', `/api/albums/${id}`, { albumName: 'Other' })).status, 400);

// Add / remove
assert.deepEqual(await api('PUT', `/api/albums/${id}/assets`, { ids: [U(a3), U(a1)] }), [
  { id: U(a3), success: true },
  { id: U(a1), success: false, error: 'duplicate' },
]);
assert.equal((await api('GET', `/api/albums/${id}`)).assetCount, 3);
assert.deepEqual(await api('DELETE', `/api/albums/${id}/assets`, { ids: [U(a1), U(a1)] }), [
  { id: U(a1), success: true },
  { id: U(a1), success: false, error: 'not_found' },
]);
const after = await api('GET', `/api/albums/${id}`);
assert.equal(after.assetCount, 2);
assert.equal(after.albumThumbnailAssetId, U(a3), 'cover falls back to the newest asset once removed');

// Bulk add and add-targets
const other = (await api('GET', '/api/albums')).find((a) => a.albumName === 'Other').id;
assert.deepEqual(await api('PUT', '/api/albums/assets', { albumIds: [id, other], assetIds: [U(a1)] }), {
  success: true,
});
assert.deepEqual(await api('PUT', '/api/albums/assets', { albumIds: [id], assetIds: [U(a1)] }), {
  success: false,
  error: 'duplicate',
});
assert.deepEqual(await api('POST', '/api/albums/add-targets', { albumIds: [id, other], assetIds: [U(a1), U(a2)] }), {
  albums: [
    { albumId: id, acceptedAssetCount: 2 },
    { albumId: other, acceptedAssetCount: 2 },
  ],
  shareableAssetCount: 2,
});

// Statistics, names, map markers, stubs
assert.deepEqual(await api('GET', '/api/albums/statistics'), { owned: 2, shared: 0, notShared: 2 });
const names = await api('GET', '/api/albums/names');
assert.deepEqual(names.map((n) => [n.albumName, n.assetCount]).sort(), [
  ['Holiday', 3],
  ['Other', 1],
]);
assert.deepEqual(
  (await api('GET', `/api/albums/${id}/map-markers`)).map((m) => [m.id, m.lat, m.lon]),
  [[U(a2), 48.8, 2.3]],
);
assert.equal((await call('GET', `/api/albums/${id}/stacks/${toUuid('stack', 1)}`)).status, 404);

// Timeline scoped to the album
const buckets = await api('GET', `/api/timeline/buckets?albumId=${id}`);
assert.equal(
  buckets.reduce((s, b) => s + b.count, 0),
  3,
);
const bucket = await api('GET', `/api/timeline/bucket?albumId=${id}&timeBucket=2020-01-01`);
assert.deepEqual(bucket.id, [U(a1)]);

// Delete
await api('DELETE', `/api/albums/${id}`);
assert.equal((await call('GET', `/api/albums/${id}`)).status, 404);
assert.equal(db.q('SELECT count(*) AS n FROM album_files').get().n, 1);

console.log('ok');
