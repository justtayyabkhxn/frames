import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fromBlob } from './places-data.mjs';

const S = 256;
const WATER = [170, 211, 223];
const LAND = [242, 239, 233];
const BORDER = [156, 135, 170];
const STATE = [200, 190, 205];

/* ---------------- rendering (pure) ---------------- */

export function encodePng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgb.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, 'latin1');
    data.copy(b, 8);
    b.writeUInt32BE(zlib.crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Web-mercator pixel coordinates of a lat/lon inside tile z/x/y. */
export function projector(z, x, y) {
  const n = 2 ** z * S;
  return (lat, lon) => {
    const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
    return [((lon + 180) / 360) * n - x * S, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n - y * S];
  };
}

/** Lat/lon bounds of tile z/x/y. */
export function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lat = (t) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / n))) * 180) / Math.PI;
  return { minlat: lat(y + 1), maxlat: lat(y), minlon: (x / n) * 360 - 180, maxlon: ((x + 1) / n) * 360 - 180 };
}

/** Even-odd scanline fill of one ring (pixel coords) into mask. */
function fillRing(mask, xs, ys) {
  const rows = new Map();
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    const [y0, y1] = [ys[j], ys[i]];
    if (y0 === y1) continue;
    const lo = Math.max(0, Math.ceil(Math.min(y0, y1) - 0.5));
    const hi = Math.min(S - 1, Math.floor(Math.max(y0, y1) - 0.5));
    for (let r = lo; r <= hi; r++) {
      const cy = r + 0.5;
      if (cy < y0 === cy < y1) continue;
      const cx = xs[j] + ((cy - y0) * (xs[i] - xs[j])) / (y1 - y0);
      (rows.get(r) ?? rows.set(r, []).get(r)).push(cx);
    }
  }
  for (const [r, cross] of rows) {
    cross.sort((a, b) => a - b);
    for (let k = 0; k + 1 < cross.length; k += 2) {
      const a = Math.max(0, Math.round(cross[k]));
      const b = Math.min(S, Math.round(cross[k + 1]));
      mask.fill(1, r * S + a, r * S + Math.max(a, b));
    }
  }
}

/** Stroke a ring's edges (pixel coords) with a colour, clipped to the tile. */
function strokeRing(rgb, xs, ys, color) {
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    const [x0, y0, x1, y1] = [xs[j], ys[j], xs[i], ys[i]];
    if ((x0 < 0 && x1 < 0) || (y0 < 0 && y1 < 0) || (x0 >= S && x1 >= S) || (y0 >= S && y1 >= S)) continue;
    const steps = Math.min(4 * S, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) + 1);
    for (let t = 0; t <= steps; t++) {
      const px = Math.floor(x0 + ((x1 - x0) * t) / steps);
      const py = Math.floor(y0 + ((y1 - y0) * t) / steps);
      if (px >= 0 && py >= 0 && px < S && py < S) rgb.set(color, (py * S + px) * 3);
    }
  }
}

/**
 * Render a tile from flat [lat, lon, ...] rings.
 * land: filled country rings, borders: stroked in BORDER, states: stroked in STATE.
 */
export function renderTile(z, x, y, { land = [], borders = land, states = [] }) {
  const proj = projector(z, x, y);
  const px = (ring) => {
    const xs = new Float64Array(ring.length / 2);
    const ys = new Float64Array(ring.length / 2);
    for (let i = 0; i < ring.length; i += 2) [xs[i / 2], ys[i / 2]] = proj(ring[i], ring[i + 1]);
    return [xs, ys];
  };
  const mask = new Uint8Array(S * S);
  for (const r of land) fillRing(mask, ...px(r));
  const rgb = new Uint8Array(S * S * 3);
  for (let i = 0; i < S * S; i++) rgb.set(mask[i] ? LAND : WATER, i * 3);
  for (const r of states) strokeRing(rgb, ...px(r), STATE);
  for (const r of borders) strokeRing(rgb, ...px(r), BORDER);
  return encodePng(S, S, rgb);
}

/* ---------------- tile service ---------------- */

/**
 * Offline basemap rendered from the planet boundaries (countries + states), cached on disk.
 * isOnline() tells whether the browser can use OSM tiles directly (rechecked at most every 5 min).
 */
export function createTiles(ctx, places) {
  const dir = path.join(ctx.dataDir, 'tiles');
  let basemap = null;
  let blank = null;
  let online = true;
  let checked = 0;

  const save = (file, buf) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
  };

  function renderLocal(z, x, y) {
    const b = tileBounds(z, x, y);
    const pad = (b.maxlon - b.minlon) / 64;
    const hit = (r) =>
      r.minlat <= b.maxlat + pad &&
      r.maxlat >= b.minlat - pad &&
      r.minlon <= b.maxlon + pad &&
      r.maxlon >= b.minlon - pad;
    if (!places.ready()) return renderTile(z, x, y, {});
    if (z < 6) {
      if (!basemap?.length)
        basemap = ctx.db
          .prepare('SELECT minlat, maxlat, minlon, maxlon, pts FROM basemap')
          .all()
          .map((r) => ({ ...r, pts: fromBlob(r.pts) }));
      return renderTile(z, x, y, { land: basemap.filter(hit).map((r) => r.pts) });
    }
    // Finer admin outlines (districts, cities) as you zoom in
    const levels = z >= 11 ? [2, 4, 6, 8] : z >= 8 ? [2, 4, 6] : [2, 4];
    const rows = places.rowsIn(b.minlat - pad, b.maxlat + pad, b.minlon - pad, b.maxlon + pad, levels);
    const land = rows.filter((r) => r.level === 2 && r.type > 0).map((r) => places.ring(r.id));
    const states = rows.filter((r) => r.level > 2).map((r) => places.ring(r.id));
    return renderTile(z, x, y, { land, states });
  }

  /** PNG buffer + cache seconds for tile z/x/y. */
  function get(z, x, y) {
    if (x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z)
      return { buf: (blank ??= renderTile(0, 0, 0, {})), maxAge: 86400 };
    const file = path.join(dir, String(z), String(x), `${y}.png`);
    if (fs.existsSync(file)) return { buf: fs.readFileSync(file), maxAge: 86400 };
    const buf = renderLocal(z, x, y);
    if (!places.ready()) return { buf, maxAge: 60 };
    save(file, buf);
    return { buf, maxAge: 86400 };
  }

  /** Last known reachability of the OSM tile server; refreshes in the background. */
  function isOnline() {
    if (Date.now() - checked > 5 * 60_000) {
      checked = Date.now();
      fetch('https://tile.openstreetmap.org/', { method: 'HEAD', signal: AbortSignal.timeout(4000) }).then(
        () => (online = true),
        () => (online = false),
      );
    }
    return online;
  }

  return { get, isOnline };
}
