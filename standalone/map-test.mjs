// Self-check for map/places geometry: node standalone/map-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createTiles, encodePng, projector, renderTile, tileBounds } from './lib/map-tiles.mjs';
import { bboxOf, centroid, containingIds, pointInRing, simplifyRing } from './lib/places-data.mjs';

// Square 0..10 (lat, lon) with a hole 4..6
const square = [0, 0, 0, 10, 10, 10, 10, 0];
const hole = [4, 4, 4, 6, 6, 6, 6, 4];
assert.ok(pointInRing(5, 5, square));
assert.ok(!pointInRing(11, 5, square));
assert.ok(!pointInRing(5, -1, square));

// Holes cancel by poly id; separate polys of the same place still count
const cands = [
  { osm_id: 1, poly: '1_0', type: 1, r: square },
  { osm_id: 1, poly: '1_0', type: -1, r: hole },
  { osm_id: 2, poly: '2_0', type: 1, r: hole },
];
const ids = (lat, lon) => containingIds(lat, lon, cands, (c) => c.r).sort();
assert.deepEqual(ids(5, 5), [2]);
assert.deepEqual(ids(2, 2), [1]);
assert.deepEqual(ids(20, 20), []);

assert.deepEqual(bboxOf(square), { minlat: 0, maxlat: 10, minlon: 0, maxlon: 10 });
assert.deepEqual(centroid(square), [5, 5]);
const dense = [0, 0, 0, 0.001, 0, 0.002, 0, 5, 5, 5, 5, 0];
assert.deepEqual(simplifyRing(dense, 0.01), [0, 0, 0, 5, 5, 5, 5, 0]);

// Mercator: tile 0/0/0 covers the world, centre at (0,0)
const p = projector(0, 0, 0);
assert.deepEqual(p(0, 0).map(Math.round), [128, 128]);
assert.equal(Math.round(p(0, 180)[0]), 256);
const b = tileBounds(1, 1, 0);
assert.equal(b.minlon, 0);
assert.ok(Math.abs(b.maxlat - 85.0511) < 1e-3 && Math.abs(b.minlat) < 1e-9);

// PNG round trip: valid signature, decodes to land in the middle and water at the corner
const png = renderTile(0, 0, 0, { land: [[-40, -40, -40, 40, 40, 40, 40, -40]] });
assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
const idat = png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 8);
const raw = zlib.inflateSync(idat);
const pix = (x, y) => [...raw.subarray(y * 769 + 1 + x * 3, y * 769 + 4 + x * 3)];
assert.deepEqual(pix(128, 128), [242, 239, 233]);
assert.deepEqual(pix(2, 2), [170, 211, 223]);
assert.equal(encodePng(1, 1, new Uint8Array(3)).length > 40, true);

// Tile service: renders without data (not cached), detects offline once, then waits before rechecking
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-map-'));
let calls = 0;
globalThis.fetch = async () => (calls++, Promise.reject(new Error('offline')));
const tiles = createTiles({ dataDir }, { ready: () => false });
const t1 = tiles.get(1, 0, 0);
assert.equal(t1.maxAge, 60);
assert.deepEqual([...t1.buf.subarray(1, 4)], [80, 78, 71]);
assert.equal(tiles.isOnline(), true); // optimistic until the probe answers
await new Promise((r) => setTimeout(r, 10));
assert.equal(tiles.isOnline(), false);
assert.equal(calls, 1);
fs.rmSync(dataDir, { recursive: true });

console.log('map-test: ok');
