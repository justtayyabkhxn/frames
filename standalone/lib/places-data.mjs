import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { TOOLS } from './tools.mjs';

// Same planet data Memories' `occ memories:places-setup` uses (OSM admin boundaries, ODbL).
const PLANET_URL = 'https://github.com/pulsejet/memories-assets/releases/download/geo-20260902/planet_postgres.zip';
const PLANET_SHA256 = '33b9516ea284a089189075f61195be54a20a6d494d1de73c62172a964a67c48f';
export const PLANET_ZIP = path.join(TOOLS, 'places', 'planet_postgres.zip');
const BASEMAP_TOLERANCE = 0.03; // degrees, ~1px at zoom 5
const RING_CACHE_FLOATS = 8_000_000; // ~32 MB of parsed rings

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS planet (osm_id INTEGER PRIMARY KEY, admin_level INTEGER NOT NULL, name TEXT NOT NULL, other_names TEXT);
  CREATE TABLE IF NOT EXISTS planet_geom (id INTEGER PRIMARY KEY, osm_id INTEGER NOT NULL, poly TEXT NOT NULL, type INTEGER NOT NULL, level INTEGER NOT NULL, pts BLOB NOT NULL);
  CREATE INDEX IF NOT EXISTS planet_geom_osm ON planet_geom (osm_id);
  CREATE VIRTUAL TABLE IF NOT EXISTS planet_rtree USING rtree (id, minlat, maxlat, minlon, maxlon);
  CREATE TABLE IF NOT EXISTS basemap (id INTEGER PRIMARY KEY, minlat REAL, maxlat REAL, minlon REAL, maxlon REAL, pts BLOB NOT NULL);
  CREATE TABLE IF NOT EXISTS places (
    fileid INTEGER NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    osm_id INTEGER NOT NULL,
    mark INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (fileid, osm_id)
  );
  CREATE INDEX IF NOT EXISTS places_osm ON places (osm_id, fileid);
  CREATE TABLE IF NOT EXISTS places_files (fileid INTEGER PRIMARY KEY REFERENCES nodes (id) ON DELETE CASCADE, lat REAL, lon REAL);
`;

/* ---------------- geometry (pure) ---------------- */

/** Ray casting; ring is a flat [lat, lon, lat, lon, ...] array. */
export function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const yi = ring[i],
      xi = ring[i + 1],
      yj = ring[j],
      xj = ring[j + 1];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Radial-distance simplification of a flat ring. */
export function simplifyRing(ring, tol) {
  const out = [ring[0], ring[1]];
  for (let i = 2; i < ring.length; i += 2) {
    const dy = ring[i] - out[out.length - 2],
      dx = ring[i + 1] - out[out.length - 1];
    if (dy * dy + dx * dx >= tol * tol || i === ring.length - 2) out.push(ring[i], ring[i + 1]);
  }
  return out;
}

export function bboxOf(ring) {
  let minlat = 90,
    maxlat = -90,
    minlon = 180,
    maxlon = -180;
  for (let i = 0; i < ring.length; i += 2) {
    minlat = Math.min(minlat, ring[i]);
    maxlat = Math.max(maxlat, ring[i]);
    minlon = Math.min(minlon, ring[i + 1]);
    maxlon = Math.max(maxlon, ring[i + 1]);
  }
  return { minlat, maxlat, minlon, maxlon };
}

/** Area-weighted centroid of a flat ring, or the first vertex if degenerate. */
export function centroid(ring) {
  let a = 0,
    cy = 0,
    cx = 0;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const f = ring[j + 1] * ring[i] - ring[i + 1] * ring[j];
    a += f;
    cx += (ring[j + 1] + ring[i + 1]) * f;
    cy += (ring[j] + ring[i]) * f;
  }
  return a ? [cy / (3 * a), cx / (3 * a)] : [ring[0], ring[1]];
}

/**
 * OSM ids containing the point. Rings sharing a poly id are summed by type
 * (+1 outer, -1 inner), so holes cancel out, like Memories' SQL.
 */
export function containingIds(lat, lon, candidates, ringOf) {
  const sums = new Map();
  for (const c of candidates) {
    if (!pointInRing(lat, lon, ringOf(c))) continue;
    sums.set(c.poly, (sums.get(c.poly) ?? 0) + c.type);
  }
  const ids = new Set();
  for (const c of candidates) if (sums.get(c.poly) > 0) ids.add(c.osm_id);
  return [...ids];
}

const toBlob = (arr) => Buffer.from(new Float32Array(arr).buffer);
export const fromBlob = (u8) => new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));

/* ---------------- download / import ---------------- */

async function download() {
  fs.mkdirSync(path.dirname(PLANET_ZIP), { recursive: true });
  const part = `${PLANET_ZIP}.part`;
  console.log('Places: downloading planet boundaries (~108 MB, one time)...');
  const res = await fetch(PLANET_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const hash = createHash('sha256');
  const tap = new Transform({ transform: (c, _, cb) => (hash.update(c), cb(null, c)) });
  await pipeline(Readable.fromWeb(res.body), tap, fs.createWriteStream(part));
  if (hash.digest('hex') !== PLANET_SHA256) {
    fs.rmSync(part, { force: true });
    throw new Error('planet download checksum mismatch');
  }
  fs.renameSync(part, PLANET_ZIP);
}

/** Lines of one entry of a (non-zip64) zip file, streamed. */
function zipLines(file, name) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, 65557));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('bad zip');
    const cd = Buffer.alloc(tail.readUInt32LE(eocd + 12));
    fs.readSync(fd, cd, 0, cd.length, tail.readUInt32LE(eocd + 16));
    for (let p = 0; p < cd.length;) {
      const method = cd.readUInt16LE(p + 10);
      const csize = cd.readUInt32LE(p + 20);
      const [nlen, xlen, clen] = [28, 30, 32].map((o) => cd.readUInt16LE(p + o));
      const off = cd.readUInt32LE(p + 42);
      const entry = cd.toString('utf8', p + 46, p + 46 + nlen);
      p += 46 + nlen + xlen + clen;
      if (entry !== name) continue;
      const lh = Buffer.alloc(30);
      fs.readSync(fd, lh, 0, 30, off);
      const start = off + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      let input = fs.createReadStream(file, { start, end: start + csize - 1 });
      if (method === 8) input = input.pipe(zlib.createInflateRaw());
      return readline.createInterface({ input, crlfDelay: Infinity });
    }
    throw new Error(`${name} not in zip`);
  } finally {
    fs.closeSync(fd);
  }
}

const unescape = (s) => s.replace(/\\(.)/g, (_, c) => ({ t: '\t', n: '\n', r: '\r' })[c] ?? c);

/** Import planet zip into SQLite, in small sync batches so the server stays responsive. */
async function importPlanet(db) {
  console.log('Places: importing planet boundaries (a few minutes, one time)...');
  db.exec('DELETE FROM planet; DELETE FROM planet_geom; DELETE FROM planet_rtree; DELETE FROM basemap;');
  db.exec('DELETE FROM places; DELETE FROM places_files;');
  db.setKv('places.ready', '');

  const levels = new Map();
  let batch = [];
  const flush = (fn) => {
    db.tx(() => batch.forEach(fn));
    batch = [];
  };

  const insPlanet = db.prepare('INSERT INTO planet (osm_id, admin_level, name, other_names) VALUES (?, ?, ?, ?)');
  for await (const line of zipLines(PLANET_ZIP, 'planet.tsv')) {
    const [id, level, name, other] = line.split('\t');
    levels.set(Number(id), Number(level));
    if (Number(level) <= 0) continue; // timezones
    batch.push([Number(id), Number(level), unescape(name), other === '{}' ? null : unescape(other)]);
    if (batch.length >= 5000) flush((r) => insPlanet.run(...r));
  }
  flush((r) => insPlanet.run(...r));

  const insGeom = db.prepare('INSERT INTO planet_geom (osm_id, poly, type, level, pts) VALUES (?, ?, ?, ?, ?)');
  const insTree = db.prepare('INSERT INTO planet_rtree (id, minlat, maxlat, minlon, maxlon) VALUES (?, ?, ?, ?, ?)');
  const insBase = db.prepare('INSERT INTO basemap (minlat, maxlat, minlon, maxlon, pts) VALUES (?, ?, ?, ?, ?)');
  const addGeom = ([osm, poly, type, level, ring]) => {
    const b = bboxOf(ring);
    const id = insGeom.run(osm, poly, type, level, toBlob(ring)).lastInsertRowid;
    insTree.run(id, b.minlat, b.maxlat, b.minlon, b.maxlon);
    if (
      level === 2 &&
      type > 0 &&
      (b.maxlat - b.minlat > BASEMAP_TOLERANCE || b.maxlon - b.minlon > BASEMAP_TOLERANCE)
    ) {
      const s = simplifyRing(ring, BASEMAP_TOLERANCE);
      if (s.length >= 6) insBase.run(b.minlat, b.maxlat, b.minlon, b.maxlon, toBlob(s));
    }
  };
  let n = 0;
  for await (const line of zipLines(PLANET_ZIP, 'planet_geometry.tsv')) {
    const [, poly, type, osm, geom] = line.split('\t');
    const level = levels.get(Number(osm));
    if (!(level > 0)) continue;
    const ring = geom.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g).map(Number);
    if (ring.length < 6) continue;
    batch.push([Number(osm), poly, Number(type), level, ring]);
    if (batch.length >= 2000) flush(addGeom);
    if (++n % 100000 === 0) console.log(`Places: ${n} boundaries imported`);
  }
  flush(addGeom);
  db.setKv('places.ready', PLANET_SHA256);
  console.log('Places: planet import done');
}

/* ---------------- runtime ---------------- */

export function createPlaces(ctx) {
  const { db } = ctx;
  db.exec(SCHEMA);
  const ready = () => db.getKv('places.ready', '') === PLANET_SHA256;

  // LRU of parsed rings by geometry id
  const cache = new Map();
  let cached = 0;
  const ring = (id) => {
    let r = cache.get(id);
    if (r) cache.delete(id);
    else {
      r = fromBlob(db.q('SELECT pts FROM planet_geom WHERE id = ?').get(id).pts);
      cached += r.length;
      for (const [k, v] of cache) {
        if (cached <= RING_CACHE_FLOATS) break;
        cache.delete(k);
        cached -= v.length;
      }
    }
    cache.set(id, r);
    return r;
  };

  /** Geometry rows whose bbox intersects; levels limits admin levels. */
  const rowsIn = (minlat, maxlat, minlon, maxlon, levels) =>
    db
      .q(
        `SELECT g.id, g.osm_id, g.poly, g.type, g.level FROM planet_rtree r JOIN planet_geom g ON g.id = r.id
         WHERE r.minlat <= ? AND r.maxlat >= ? AND r.minlon <= ? AND r.maxlon >= ?`,
      )
      .all(maxlat, minlat, maxlon, minlon)
      .filter((g) => !levels || levels.includes(g.level));

  /** OSM ids (with admin level) containing a point, country first. */
  const lookup = (lat, lon) => {
    const cands = rowsIn(lat, lat, lon, lon);
    const levelOf = new Map(cands.map((c) => [c.osm_id, c.level]));
    return containingIds(lat, lon, cands, (c) => ring(c.id))
      .map((osm_id) => ({ osm_id, admin_level: levelOf.get(osm_id) }))
      .sort((a, b) => a.admin_level - b.admin_level);
  };

  const translate = (name, other) => {
    if (!other) return name;
    try {
      return JSON.parse(other)[ctx.language] || name;
    } catch {
      return name;
    }
  };

  // Places of one file (same rules as Memories: mark = deepest level <= 8)
  const memo = new Map();
  const assign = (fileid, lat, lon) => {
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    let ids = memo.get(key);
    if (!ids) {
      if (memo.size > 10000) memo.clear();
      memo.set(key, (ids = lookup(lat, lon)));
    }
    const mark = ids.filter((r) => r.admin_level <= 8).pop()?.osm_id;
    db.q('DELETE FROM places WHERE fileid = ?').run(fileid);
    for (const r of ids)
      db.q('INSERT INTO places (fileid, osm_id, mark) VALUES (?, ?, ?)').run(
        fileid,
        r.osm_id,
        r.osm_id === mark ? 1 : 0,
      );
    db.q('INSERT OR REPLACE INTO places_files (fileid, lat, lon) VALUES (?, ?, ?)').run(fileid, lat, lon);
  };

  const STALE = `SELECT m.id, m.lat, m.lon FROM media m LEFT JOIN places_files p ON p.fileid = m.id
    WHERE m.lat IS NOT NULL AND m.lon IS NOT NULL AND (p.fileid IS NULL OR p.lat IS NOT m.lat OR p.lon IS NOT m.lon)`;

  let syncing = false;
  /** Bring the places table up to date with media coordinates. */
  async function sync() {
    if (!ready() || syncing) return;
    syncing = true;
    try {
      db.exec(`DELETE FROM places WHERE fileid IN (SELECT p.fileid FROM places_files p JOIN media m ON m.id = p.fileid WHERE m.lat IS NULL OR m.lon IS NULL);
        DELETE FROM places_files WHERE fileid IN (SELECT m.id FROM media m WHERE m.lat IS NULL OR m.lon IS NULL)`);
      for (;;) {
        const todo = db.q(`${STALE} LIMIT 500`).all();
        if (!todo.length) break;
        db.tx(() => todo.forEach((r) => assign(r.id, r.lat, r.lon)));
        await new Promise(setImmediate);
      }
    } finally {
      syncing = false;
    }
  }

  let setupRunning = false;
  let lastFail = 0;
  /** Download (once) and import planet data when some photo has GPS. */
  async function setup() {
    if (ready() || setupRunning || Date.now() - lastFail < 10 * 60_000) return;
    if (!db.q('SELECT 1 FROM media WHERE lat IS NOT NULL LIMIT 1').get()) return;
    setupRunning = true;
    try {
      if (!fs.existsSync(PLANET_ZIP)) await download();
      await importPlanet(db);
      cache.clear();
      cached = 0;
      await sync();
    } catch (e) {
      lastFail = Date.now();
      console.warn(`Places setup failed (will retry later): ${e.message}`);
    } finally {
      setupRunning = false;
    }
  }

  function addressOf(fileid) {
    if (!ready()) return [];
    const m = db.q('SELECT lat, lon FROM media WHERE id = ?').get(fileid);
    if (m?.lat == null || m.lon == null) return [];
    const p = db.q('SELECT lat, lon FROM places_files WHERE fileid = ?').get(fileid);
    if (p?.lat !== m.lat || p?.lon !== m.lon) db.tx(() => assign(fileid, m.lat, m.lon));
    return db
      .q(
        `SELECT e.name, e.other_names FROM places p JOIN planet e ON e.osm_id = p.osm_id
         WHERE p.fileid = ? ORDER BY e.admin_level DESC`,
      )
      .all(fileid)
      .map((r) => translate(r.name, r.other_names))
      .filter((n, i, a) => n !== a[i - 1]);
  }

  /** Nominatim-like search over admin area names. */
  function search(q, limit = 8) {
    if (!ready() || !q) return [];
    const rows = db
      .q(
        `SELECT osm_id, admin_level, name, other_names FROM planet
         WHERE name LIKE :p OR other_names LIKE :o
         ORDER BY lower(name) = lower(:q) DESC, admin_level LIMIT :limit`,
      )
      .all({ p: `${q}%`, o: `%"${q}%`, q, limit });
    return rows.flatMap((r) => {
      const g = db
        .q(
          `SELECT g.id FROM planet_geom g JOIN planet_rtree t ON t.id = g.id WHERE g.osm_id = ? AND g.type > 0
           ORDER BY (t.maxlat - t.minlat) * (t.maxlon - t.minlon) DESC LIMIT 1`,
        )
        .get(r.osm_id);
      if (!g) return [];
      const pts = ring(g.id);
      let [lat, lon] = centroid(pts);
      if (!pointInRing(lat, lon, pts)) [lat, lon] = [pts[0], pts[1]];
      const parents = lookup(lat, lon)
        .filter((p) => p.admin_level < r.admin_level)
        .reverse()
        .map((p) => db.q('SELECT name, other_names FROM planet WHERE osm_id = ?').get(p.osm_id))
        .filter(Boolean)
        .map((p) => translate(p.name, p.other_names));
      const names = [translate(r.name, r.other_names), ...parents].filter((n, i, a) => n !== a[i - 1]);
      return [
        {
          osm_id: r.osm_id,
          lat: lat.toFixed(6),
          lon: lon.toFixed(6),
          display_name: names.join(', '),
        },
      ];
    });
  }

  return { ready, setup, sync, lookup, addressOf, search, translate, rowsIn, ring };
}
