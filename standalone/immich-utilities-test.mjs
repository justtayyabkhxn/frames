// Self-check for the Immich utilities (duplicates, large files, cleanup): node standalone/immich-utilities-test.mjs
import assert from 'node:assert/strict';
import { setup } from './immich-harness.mjs';
import { toUuid } from './lib/immich/ids.mjs';
import { registerUtilities } from './lib/immich/utilities.mjs';

let groups = [];
const { api, media, db, lensCalls } = setup({
  register: (router, ctx, A) => registerUtilities(router, ctx, A),
  lensGet: (p) => (p.startsWith('/v1/duplicates') ? { groups } : {}),
});
const U = (id) => toUuid('asset', id);
const MB = 1024 * 1024;

const a = media('dup/a.jpg', '2020-01-01T10:00:00', { size: 500 });
const b = media('dup/b.jpg', '2020-01-01T11:00:00', { size: 100, favorite: 1 });
const c = media('dup/c.jpg', '2020-01-02T10:00:00', { size: 300 });
const d = media('dup/d.jpg', '2020-01-02T11:00:00', { size: 400 });
const big = media('big.mp4', '2021-05-04T10:00:00', { size: 200 * MB, video: true });
const shot = media('Screenshot 2022-01-01.jpg', '2022-01-01T10:00:00', { size: 50 });
const png = media('IMG_0001.PNG', '2022-01-02T10:00:00', { size: 60 });
const camPng = media('scan.png', '2022-01-03T10:00:00', { size: 60, exif: { Make: 'Canon' } });
const burst = [0, 1, 3].map((s) => media(`burst/${s}.jpg`, `2023-07-04T10:00:0${s}`, { size: 10 + s }));
media('pair/1.jpg', '2023-07-05T10:00:00');
media('pair/2.jpg', '2023-07-05T10:00:01');
groups = [
  [a, b],
  [c, d],
];

// Duplicates: shape, suggested keep, stable ids
const dups = await api('GET', '/api/duplicates');
assert.equal(dups.length, 2);
const [g1, g2] = dups;
assert.match(g1.duplicateId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
assert.deepEqual(g1.assets.map((x) => x.id).sort(), [U(a), U(b)].sort());
assert.deepEqual(g1.suggestedKeepAssetIds, [U(a)]);
assert.deepEqual(g2.suggestedKeepAssetIds, [U(d)]);
assert.equal(g1.assets[0].originalFileName.endsWith('.jpg'), true);
assert.deepEqual(
  (await api('GET', '/api/duplicates')).map((g) => g.duplicateId),
  dups.map((g) => g.duplicateId),
);
assert.deepEqual(await api('GET', '/api/cleanup/queues/duplicates/count'), { count: 2, bytes: 400 });

// Resolve: trash the others, merge favorite into the kept one
const res = await api('POST', '/api/duplicates/resolve', {
  groups: [{ duplicateId: g1.duplicateId, keepAssetIds: [U(a)], trashAssetIds: [U(b)] }],
});
assert.deepEqual(res, [{ id: g1.duplicateId, success: true }]);
assert.deepEqual(
  lensCalls.filter((x) => x[0] === 'trash'),
  [['trash', b]],
);
assert.equal(db.q('SELECT favorite FROM nodes WHERE id = ?').get(a).favorite, 1);
const bad = await api('POST', '/api/duplicates/resolve', {
  groups: [{ duplicateId: g2.duplicateId, keepAssetIds: [], trashAssetIds: [] }],
});
assert.equal(bad[0].success, false);

// Keep all: dismissed groups disappear
await api('DELETE', '/api/duplicates', { ids: [g1.duplicateId] });
assert.deepEqual(
  (await api('GET', '/api/duplicates')).map((g) => g.duplicateId),
  [g2.duplicateId],
);
await api('DELETE', `/api/duplicates/${g2.duplicateId}`);
assert.deepEqual(await api('GET', '/api/duplicates'), []);
assert.equal((await api('GET', '/api/cleanup/queues/duplicates/count')).count, 0);

// Large files: largest first, minFileSize and size
const large = await api('POST', '/api/search/large-assets?minFileSize=100&size=3');
assert.deepEqual(
  large.map((x) => x.id),
  [U(big), U(a), U(d)],
);
assert.deepEqual(
  (await api('POST', '/api/search/large-assets?size=2&page=2')).map((x) => x.id),
  [U(d), U(c)],
);
assert.deepEqual(
  (await api('POST', '/api/search/large-assets?type=IMAGE&size=1')).map((x) => x.id),
  [U(a)],
);

// Cleanup queues
const count = (q, qs = '') => api('GET', `/api/cleanup/queues/${q}/count${qs}`);
assert.deepEqual(await count('space_hogs'), { count: 1, bytes: 200 * MB });
assert.equal((await count('space_hogs', '?minSize=450&type=image')).count, 1);
const hogs = await api('GET', '/api/cleanup/queues/space_hogs?minSize=0&limit=2');
assert.deepEqual(
  hogs.items.map((x) => x.id),
  [U(big), U(a)],
);
assert.equal(hogs.items[0].type, 'VIDEO');
assert.equal(hogs.items[0].fileSize, 200 * MB);
assert.equal(hogs.items[0].duration, 5000);
const hogs2 = await api('GET', `/api/cleanup/queues/space_hogs?minSize=0&limit=2&cursor=${hogs.nextCursor}`);
assert.deepEqual(
  hogs2.items.map((x) => x.id),
  [U(d), U(c)],
);
assert.deepEqual(await count('screenshots'), { count: 2, bytes: 110 });
assert.deepEqual(
  (await api('GET', '/api/cleanup/queues/screenshots')).items.map((x) => x.id),
  [U(png), U(shot)],
);
assert.ok(camPng);
assert.deepEqual(await count('bursts'), { count: 1, bytes: 10 + 11 });
const bursts = await api('GET', '/api/cleanup/queues/bursts');
assert.equal(bursts.groups.length, 1);
assert.deepEqual(
  bursts.groups[0].assets.map((x) => x.id),
  burst.map(U),
);
assert.equal(bursts.groups[0].suggestedKeepId, U(burst[2]));
assert.deepEqual(await count('blurry'), { count: 0, bytes: 0 });
assert.deepEqual(await api('GET', '/api/cleanup/queues/blurry'), { items: [], groups: [], nextCursor: null });

// Commit: kept assets leave the queue, trash goes through Frames, unknown ids are skipped
const commit = await api('POST', '/api/cleanup/commit', {
  queue: 'screenshots',
  keepIds: [U(png)],
  trashIds: [U(shot), U(99999)],
  favoriteIds: [U(c)],
});
assert.deepEqual(commit, {
  trashed: [U(shot)],
  favorited: 1,
  kept: 2,
  skipped: [{ id: U(99999), reason: 'not_found' }],
});
assert.deepEqual(lensCalls.at(-1), ['trash', shot]);
assert.equal(db.q('SELECT favorite FROM nodes WHERE id = ?').get(c).favorite, 1);
assert.equal(
  (await api('GET', '/api/cleanup/queues/screenshots')).items.some((x) => x.id === U(png)),
  false,
);

// Rewind and calendar
const years = await api('GET', '/api/cleanup/rewind/102');
assert.deepEqual(years, {
  years: [
    { year: 2022, count: 1 },
    { year: 2020, count: 2 },
  ],
});
const day = await api('GET', '/api/cleanup/rewind/102/2020');
assert.deepEqual(
  day.assets.map((x) => x.id),
  [U(c), U(d)],
);
assert.equal(day.assets[0].localDateTime, '2020-01-02T10:00:00.000Z');
assert.equal(day.assets[0].kept, false);
await api('POST', '/api/cleanup/commit', { queue: 'rewind', keepIds: [U(c)], completeMonthDay: 102 });
assert.equal((await api('GET', '/api/cleanup/rewind/102/2020')).assets[0].kept, true);
const cal = await api('GET', '/api/cleanup/calendar?tz=UTC');
assert.equal(cal.days.length, 366);
assert.equal(cal.days.find((x) => x.monthDay === 102).assetCount, 3);
assert.ok(cal.days.find((x) => x.monthDay === 102).reviewedAt);
assert.equal(cal.daysReviewed, 1);
assert.equal(cal.streak, 1);

db.q("INSERT INTO trash (name, orig_path, file, deleted_at, size) VALUES ('x', 'x', 'x', 0, 42)").run();
assert.deepEqual(await api('GET', '/api/cleanup/trash'), { count: 1, bytes: 42 });
assert.deepEqual(await api('POST', '/api/cleanup/in-spaces', { assetIds: [U(a)] }), {
  assetIds: [],
  externalAssetIds: [],
});
await api('DELETE', '/api/cleanup/decisions', { queue: 'screenshots', assetIds: [U(png)] });
assert.equal((await count('screenshots')).count, 2);

console.log('ok');
