// Self-check for Immich search, suggestions, places and map: node standalone/immich-search-test.mjs
import assert from 'node:assert/strict';
import { setup } from './immich-harness.mjs';
import { toUuid } from './lib/immich/ids.mjs';
import { registerSearch } from './lib/immich/search.mjs';

let hits = [];
const { api, call, media, db, ctx, lensCalls } = setup({
  register: (router, ctx, A) => registerSearch(router, ctx, A),
  lensPost: (p) => (p === '/v1/search' ? { hits } : {}),
});

db.exec(`
  CREATE TABLE IF NOT EXISTS planet (osm_id INTEGER PRIMARY KEY, admin_level INTEGER NOT NULL, name TEXT NOT NULL, other_names TEXT);
  CREATE TABLE IF NOT EXISTS places (fileid INTEGER NOT NULL, osm_id INTEGER NOT NULL, mark INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (fileid, osm_id));
  INSERT INTO planet VALUES (1, 2, 'Germany', '{"de":"Deutschland"}'), (2, 4, 'Bavaria', NULL), (3, 8, 'Munich', NULL),
    (4, 2, 'France', NULL), (5, 4, 'Ile-de-France', NULL), (6, 8, 'Paris', NULL);
`);
ctx.addressOf = (id) =>
  db
    .q(
      'SELECT e.name FROM places p JOIN planet e ON e.osm_id = p.osm_id WHERE p.fileid = ? ORDER BY e.admin_level DESC',
    )
    .all(id)
    .map((r) => r.name);

const a = media('trip/IMG_0001.jpg', '2024-05-01T10:00:00', {
  exif: { Make: 'Canon', Model: 'EOS R5', LensModel: 'RF 24-70' },
  favorite: 1,
});
const b = media('trip/IMG_0002.jpg', '2024-06-01T10:00:00', {
  exif: { Make: 'Sony', Model: 'A7', Rating: 4, Description: 'Eiffel tower at night' },
});
const c = media('home/cat.mp4', '2024-07-01T10:00:00', { video: true, exif: { Make: 'Canon', Model: 'EOS 5D' } });
const geo = (id, lat, lon, places) => {
  db.q('UPDATE media SET lat = ?, lon = ? WHERE id = ?').run(lat, lon, id);
  for (const p of places) db.q('INSERT INTO places (fileid, osm_id) VALUES (?, ?)').run(id, p);
};
geo(a, 48.14, 11.58, [1, 2, 3]);
geo(b, 48.86, 2.35, [4, 5, 6]);
db.exec(`INSERT INTO people (id, name) VALUES (7, 'Alice')`);
db.q(`INSERT INTO faces (point, fileid, cluster) VALUES ('p1', ?, 7), ('p2', ?, 8)`).run(a, c);

const ids = (r) => r.assets.items.map((x) => x.id);
const U = (...n) => n.map((i) => toUuid('asset', i));
const search = (body) => api('POST', '/api/search/metadata', body);

/* metadata search */
assert.deepEqual(ids(await search({ originalFileName: 'img_0002' })), U(b));
assert.deepEqual(ids(await search({ make: 'Canon' })), U(c, a));
assert.deepEqual(ids(await search({ make: 'Canon', order: 'asc' })), U(a, c));
assert.deepEqual(ids(await search({ personIds: [toUuid('person', 7)] })), U(a));
assert.deepEqual(ids(await search({ personIds: [`person:${toUuid('person', 7)}`] })), U(a));
assert.deepEqual(ids(await search({ isFavorite: true })), U(a));
assert.deepEqual(ids(await search({ description: 'eiffel' })), U(b));
assert.deepEqual(ids(await search({ city: 'Munich' })), U(a));
assert.deepEqual(ids(await search({ country: 'France', type: 'IMAGE' })), U(b));
assert.deepEqual(ids(await search({ type: 'VIDEO' })), U(c));
assert.deepEqual(ids(await search({ isNotInAlbum: true, takenAfter: '2024-05-15T00:00:00Z' })), U(c, b));
const p1 = await search({ size: 2 });
assert.deepEqual([ids(p1), p1.assets.nextPage, p1.assets.count], [U(c, b), '2', 2]);
const p2 = await search({ size: 2, page: 2 });
assert.deepEqual([ids(p2), p2.assets.nextPage], [U(a), null]);
assert.deepEqual(p2.albums, { items: [], total: 0, count: 0, facets: [] });
assert.equal(p2.assets.items[0].exifInfo.city, 'Munich');

/* smart search */
hits = [
  { fileid: b, score: 0.9 },
  { fileid: a, score: 0.8 },
  { fileid: 999, score: 0.1 },
];
const smart = await api('POST', '/api/search/smart', { query: 'tower', size: 1 });
assert.deepEqual([ids(smart), smart.assets.nextPage], [U(b), '2']);
assert.deepEqual(ids(await api('POST', '/api/search/smart', { query: 'tower', page: 2, size: 1 })), U(a));
assert.deepEqual(ids(await api('POST', '/api/search/smart', { query: 'tower', make: 'Canon' })), U(a));
assert.equal(lensCalls.at(-1)[1], '/v1/search');
assert.equal(lensCalls.at(-1)[2].text, 'tower');
const sf = await api('POST', '/api/search/smart/facets', { query: 'tower', make: 'Sony' });
assert.equal(sf.total, 1);
assert.deepEqual(sf.cameraMakes, ['Canon', 'Sony']);
assert.deepEqual(sf.countries, ['France']);
assert.deepEqual(sf.timeBuckets, [{ timeBucket: '2024-06-01', count: 1 }]);
const lens = ctx.lens;
ctx.lens = undefined;
assert.equal((await call('POST', '/api/search/smart', { query: 'x' })).status, 503);
ctx.lens = lens;

/* suggestions */
const sug = (q) => api('GET', `/api/search/suggestions?${q}`);
assert.deepEqual(await sug('type=country'), ['France', 'Germany']);
assert.deepEqual(await sug('type=state&country=Germany'), ['Bavaria']);
assert.deepEqual(await sug('type=city'), ['Munich', 'Paris']);
assert.deepEqual(await sug('type=city&country=France'), ['Paris']);
assert.deepEqual(await sug('type=camera-make'), ['Canon', 'Sony']);
assert.deepEqual(await sug('type=camera-model&make=Canon'), ['EOS 5D', 'EOS R5']);
assert.deepEqual(await sug('type=camera-lens-model'), ['RF 24-70']);

/* filter suggestions narrow by the other filters, never their own */
const all = await api('GET', '/api/search/suggestions/filters');
assert.deepEqual(all.people, [{ id: toUuid('person', 7), name: 'Alice' }]);
assert.equal(all.hasUnnamedPeople, true);
assert.deepEqual(all.mediaTypes, ['IMAGE', 'VIDEO']);
assert.deepEqual(all.ratings, [4]);
const sony = await api('GET', '/api/search/suggestions/filters?make=Sony');
assert.deepEqual(sony.cameraMakes, ['Canon', 'Sony']);
assert.deepEqual(sony.countries, ['France']);
assert.deepEqual([sony.people, sony.hasFavorites, sony.mediaTypes], [[], false, ['IMAGE']]);
assert.deepEqual([sony.hasAssetsInAlbum, sony.hasAssetsNotInAlbum], [false, true]);

/* map markers */
const markers = await api('GET', '/api/map/markers');
assert.deepEqual(
  markers.sort((x, y) => x.lat - y.lat),
  [
    { id: toUuid('asset', a), lat: 48.14, lon: 11.58, city: 'Munich', state: 'Bavaria', country: 'Germany' },
    { id: toUuid('asset', b), lat: 48.86, lon: 2.35, city: 'Paris', state: 'Ile-de-France', country: 'France' },
  ],
);
assert.deepEqual(
  (await api('GET', '/api/map/markers?isFavorite=true')).map((m) => m.id),
  U(a),
);
assert.deepEqual(
  (await api('GET', '/api/map/markers?fileCreatedAfter=2024-05-15T00:00:00Z')).map((m) => m.id),
  U(b),
);
assert.deepEqual(
  (await api('GET', '/api/gallery/map/markers?make=Sony')).map((m) => [m.id, m.country]),
  [[toUuid('asset', b), 'France']],
);
assert.deepEqual(await api('GET', '/api/gallery/map/markers?type=VIDEO'), []);

/* cities and places */
assert.deepEqual(
  (await api('GET', '/api/search/cities')).map((x) => [x.id, x.exifInfo.city]),
  [
    [toUuid('asset', b), 'Paris'],
    [toUuid('asset', a), 'Munich'],
  ],
);
assert.deepEqual(await api('GET', '/api/search/places?name=mun'), [
  { name: 'Munich', latitude: 48.14, longitude: 11.58, admin1name: 'Bavaria', admin2name: 'Germany' },
]);
assert.equal((await api('GET', '/api/search/places?name=Deutsch'))[0].name, 'Germany');
assert.deepEqual(await api('GET', '/api/search/places?name=zzz'), []);

// Timeline filters used by the map and filter panel: bbox (west,south,east,north), places, album membership, name
const count = async (q) => (await api('GET', `/api/timeline/buckets?${q}`)).reduce((n, b) => n + b.count, 0);
assert.equal(await count('bbox=10,47,12,49'), 1);
assert.equal(await count('bbox=-10,40,20,55'), 2);
assert.equal(await count('city=Paris'), 1);
assert.equal(await count('country=Germany'), 1);
assert.equal(await count('originalFileName=IMG_0002'), 1);
assert.equal(await count('description=eiffel'), 1);
db.exec(
  `INSERT INTO albums (id, name, created, updated) VALUES (5, 'A', 0, 0); INSERT INTO album_files VALUES (5, ${a}, 0)`,
);
assert.equal(await count('isInAlbum=true'), 1);
assert.equal(await count('isNotInAlbum=true'), 2);

console.log('ok');
