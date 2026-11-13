import { HttpError, badRequest, readJson } from '../http.mjs';
import { maybeId, toUuid } from './ids.mjs';
import { ASSET_SELECT, assetFilter } from './timeline.mjs';

const EXIF = (tag) => `json_extract(m.exif, '$.${tag}')`;
/** Suggestion type -> [value source, filters dropped so a facet never narrows itself]. */
const SUGGEST = {
  country: ['country', ['country', 'state', 'city']],
  state: ['state', ['state', 'city']],
  city: ['city', ['city']],
  'camera-make': [EXIF('Make'), ['make', 'model', 'lensModel']],
  'camera-model': [EXIF('Model'), ['model', 'lensModel']],
  'camera-lens-model': [EXIF('LensModel'), ['lensModel']],
};
const ADDR = ['city', 'state', 'country'];
const NO_ADDR = { city: null, state: null, country: null };
/** Same split as assetDto's exifInfo: most specific name is the city, the last the country. */
const split = (a) => ({
  city: a[0] ?? null,
  state: a.length > 2 ? a[1] : null,
  country: a.length > 1 ? a.at(-1) : null,
});

/** A search body -> query params, so bodies and GET filters share one code path. */
const params = (b) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(b ?? {}))
    for (const x of [v].flat()) if (x != null && typeof x !== 'object') p.append(k, String(x));
  return p;
};

/** Search, suggestions, places and map markers for Gallery's UI. */
export function registerSearch(router, ctx, A) {
  const { db } = ctx;
  const tr = (r) => {
    try {
      return JSON.parse(r.other_names)[ctx.language] || r.name;
    } catch {
      return r.name;
    }
  };

  /** fileid -> place names (most specific first, like ctx.addressOf) for the files `sub` selects, in one query. */
  function addresses(sub, args) {
    const out = new Map();
    let rows;
    try {
      rows = db
        .prepare(
          `SELECT p.fileid, e.name, e.other_names FROM places p JOIN planet e ON e.osm_id = p.osm_id
           WHERE p.fileid IN (${sub}) ORDER BY p.fileid, e.admin_level DESC`,
        )
        .all(args);
    } catch {
      return out; // no planet tables until places are set up
    }
    for (const r of rows) {
      const a = out.get(r.fileid) ?? out.set(r.fileid, []).get(r.fileid);
      const n = tr(r);
      if (a.at(-1) !== n) a.push(n);
    }
    return out;
  }

  /** Gallery's search filters -> { from, args } over media m / nodes n; `drop` skips some filters (facets). */
  function where(q, drop = [], scope = '', scopeArgs = {}) {
    const p = new URLSearchParams();
    for (const [k, v] of q) if (!drop.includes(k)) p.append(k, k === 'personIds' ? v.replace(/^person:/, '') : v);
    if (p.has('mediaType')) p.set('type', p.get('mediaType'));
    const { f, from } = assetFilter(ctx, p);
    const args = { ...f.args, ...scopeArgs };
    const w = [];
    const add = (sql, a = {}) => (w.push(sql), Object.assign(args, a));
    p.getAll('albumIds').forEach((id, i) =>
      add(`n.id IN (SELECT fileid FROM album_files WHERE album = :qal${i})`, { [`qal${i}`]: maybeId(id, 'album') }),
    );
    if (p.get('isInAlbum') === 'true') add('n.id IN (SELECT fileid FROM album_files)');
    if (p.get('isNotInAlbum') === 'true') add('n.id NOT IN (SELECT fileid FROM album_files)');
    if (p.get('originalFileName')) add('n.name LIKE :qfname', { qfname: `%${p.get('originalFileName')}%` });
    if (p.get('description'))
      add(`coalesce(${EXIF('Description')}, ${EXIF('ImageDescription')}, '') LIKE :qdesc`, {
        qdesc: `%${p.get('description')}%`,
      });
    let sql = from + w.map((s) => ` AND ${s}`).join('') + scope;
    const addr = ADDR.filter((k) => p.get(k));
    if (addr.length) {
      // ponytail: address filters resolve in JS over all candidates; an SQL join on planet if libraries get huge
      const ok = [...addresses(`SELECT n.id ${sql}`, args)]
        .filter(([, a]) => addr.every((k) => split(a)[k] === p.get(k)))
        .map(([id]) => id);
      sql += ' AND n.id IN (SELECT value FROM json_each(:qaddr))';
      args.qaddr = JSON.stringify(ok);
    }
    return { from: sql, args };
  }

  const all = (w, sql) => db.prepare(sql(w.from)).all(w.args);
  const suggest = (q, type, scope, scopeArgs) => {
    const [src, drop] = SUGGEST[type] ?? [];
    if (!src) throw badRequest(`Unknown suggestion type ${type}`);
    const w = where(q, drop, scope, scopeArgs);
    if (ADDR.includes(src))
      return [...new Set([...addresses(`SELECT n.id ${w.from}`, w.args).values()].map((a) => split(a)[src]))]
        .filter(Boolean)
        .sort();
    return all(w, (f) => `SELECT DISTINCT ${src} AS v ${f} AND v IS NOT NULL ORDER BY v`).map((r) => r.v);
  };

  /** Filter panel facets; each one is narrowed by every active filter except its own. */
  function facets(q, scope = '', scopeArgs = {}) {
    const w = (drop) => where(q, drop, scope, scopeArgs);
    const exists = (drop, cond) => all(w(drop), (f) => `SELECT 1 ${f} AND ${cond} LIMIT 1`).length > 0;
    const people = all(
      w(['personIds', 'personId']),
      (f) => `SELECT fc.cluster AS id, p.name FROM faces fc LEFT JOIN people p ON p.id = fc.cluster
        WHERE fc.cluster > 0 AND coalesce(p.hidden, 0) = 0 AND fc.fileid IN (SELECT n.id ${f})
        GROUP BY fc.cluster ORDER BY p.name IS NULL, count(DISTINCT fc.fileid) DESC, p.name`,
    );
    const album = 'n.id IN (SELECT fileid FROM album_files)';
    return {
      countries: suggest(q, 'country', scope, scopeArgs),
      cameraMakes: suggest(q, 'camera-make', scope, scopeArgs),
      people: people.filter((r) => r.name).map((r) => ({ id: toUuid('person', r.id), name: r.name })),
      hasUnnamedPeople: people.some((r) => !r.name),
      tags: all(
        w(['tagIds', 'tagId']),
        (f) => `SELECT t.id, t.name FROM tags t
          WHERE t.id IN (SELECT tag FROM tag_files WHERE fileid IN (SELECT n.id ${f})) ORDER BY t.name`,
      ).map((t) => ({ id: toUuid('tag', t.id), value: t.name })),
      ratings: all(w(['rating']), (f) => `SELECT DISTINCT ${EXIF('Rating')} AS v ${f} AND v > 0 ORDER BY v`).map((r) =>
        Number(r.v),
      ),
      mediaTypes: all(
        w(['type', 'mediaType']),
        (f) => `SELECT DISTINCT CASE m.isvideo WHEN 1 THEN 'VIDEO' ELSE 'IMAGE' END AS v ${f} ORDER BY v`,
      ).map((r) => r.v),
      hasFavorites: exists(['isFavorite'], 'n.favorite = 1'),
      hasAssetsInAlbum: exists(['isInAlbum', 'isNotInAlbum'], album),
      hasAssetsNotInAlbum: exists(['isInAlbum', 'isNotInAlbum'], `NOT ${album}`),
    };
  }

  const page = (b, def) => ({
    size: Math.min(1000, Math.max(1, Number(b.size) || def)),
    page: Math.max(1, Number(b.page) || 1),
  });
  const response = (rows, { size, page }) => {
    const items = rows.slice(0, size).map((r) => ctx.assetDtoFromRow(r));
    return {
      albums: { items: [], total: 0, count: 0, facets: [] },
      assets: {
        items,
        total: items.length,
        count: items.length,
        facets: [],
        nextPage: rows.length > size ? String(page + 1) : null,
      },
    };
  };

  A.post('/search/metadata', async (req) => {
    const b = await readJson(req);
    const pg = page(b, 250);
    const dir = b.order === 'asc' ? 'ASC' : 'DESC';
    const { from, args } = where(params(b));
    const rows = db
      .prepare(
        `SELECT DISTINCT ${ASSET_SELECT} ${from} ORDER BY m.datetaken ${dir}, n.id ${dir} LIMIT :lim OFFSET :off`,
      )
      .all({ ...args, lim: pg.size + 1, off: (pg.page - 1) * pg.size });
    return response(rows, pg);
  });

  // ponytail: one lens query of the top 500 hits, filtered and paged here; page it in lens if 500 is too few
  async function smartHits(b) {
    if (ctx.lens?.state !== 'ready') throw new HttpError(503, 'Smart search is not available');
    const text = String(b.query ?? '').trim();
    if (!text) throw badRequest('Search text must not be empty');
    const folders = db
      .q('SELECT id FROM nodes WHERE dir = 1')
      .all()
      .map((r) => r.id);
    const { hits = [] } = await ctx.lens.post('/v1/search', { text, folders, limit: 500 });
    return JSON.stringify(hits.map((h) => Number(h.fileid)));
  }
  const HITS = ' AND n.id IN (SELECT value FROM json_each(:qhits))';

  A.post('/search/smart', async (req) => {
    const b = await readJson(req);
    const hits = await smartHits(b);
    const { from, args } = where(params(b), [], HITS, { qhits: hits });
    const byId = new Map(
      db
        .prepare(`SELECT DISTINCT ${ASSET_SELECT} ${from}`)
        .all(args)
        .map((r) => [r.id, r]),
    );
    const pg = page(b, 100);
    const ranked = JSON.parse(hits)
      .map((id) => byId.get(id))
      .filter(Boolean);
    return response(ranked.slice((pg.page - 1) * pg.size, pg.page * pg.size + 1), pg);
  });

  A.post('/search/smart/facets', async (req) => {
    const b = await readJson(req);
    const q = params(b);
    const scope = [HITS, { qhits: await smartHits(b) }];
    const w = where(q, [], ...scope);
    const timeBuckets = all(
      w,
      (f) => `SELECT strftime('%Y-%m-01', m.datetaken, 'unixepoch') AS timeBucket, count(DISTINCT n.id) AS count ${f}
        GROUP BY timeBucket ORDER BY timeBucket DESC`,
    );
    return {
      ...facets(q, ...scope),
      cities: suggest(q, 'city', ...scope),
      cameraModels: suggest(q, 'camera-model', ...scope),
      timeBuckets,
      total: timeBuckets.reduce((s, t) => s + t.count, 0),
    };
  });

  A.get('/search/suggestions', (req, _, q) => {
    const p = new URLSearchParams(q);
    p.delete('type');
    return suggest(p, q.get('type'));
  });
  A.get('/search/suggestions/filters', (req, _, q) => facets(q));

  /** Newest photo of each city. */
  A.get('/search/cities', () => {
    const w = where(new URLSearchParams({ visibility: 'timeline', withCoordinates: 'true' }));
    const addr = addresses(`SELECT n.id ${w.from}`, w.args);
    const cities = new Map();
    for (const { id } of all(w, (f) => `SELECT DISTINCT n.id, m.datetaken ${f} ORDER BY m.datetaken DESC, n.id DESC`)) {
      const city = split(addr.get(id) ?? []).city;
      if (city && !cities.has(city)) cities.set(city, id);
    }
    return [...cities.values()].map((id) => ctx.assetDto(id));
  });

  /** Admin areas by name; located at the photos taken there, else the centre of the area's bounding box. */
  A.get('/search/places', (req, _, q) => {
    const name = q.get('name')?.trim();
    if (!name) return [];
    let rows;
    try {
      rows = db
        .q(
          `SELECT osm_id, name, other_names FROM planet WHERE name LIKE :p OR other_names LIKE :o
           ORDER BY lower(name) = lower(:q) DESC, admin_level DESC, name LIMIT 20`,
        )
        .all({ p: `${name}%`, o: `%"${name}%`, q: name });
    } catch {
      return [];
    }
    const at = db.q(
      `SELECT avg(m.lat) AS lat, avg(m.lon) AS lon, min(m.id) AS file FROM places p JOIN media m ON m.id = p.fileid
       WHERE p.osm_id = ? AND m.lat IS NOT NULL`,
    );
    const box = (id) => {
      try {
        return db
          .q(
            `SELECT (t.minlat + t.maxlat) / 2 AS lat, (t.minlon + t.maxlon) / 2 AS lon
             FROM planet_geom g JOIN planet_rtree t ON t.id = g.id WHERE g.osm_id = ?
             ORDER BY (t.maxlat - t.minlat) * (t.maxlon - t.minlon) DESC LIMIT 1`,
          )
          .get(id);
      } catch {
        return null;
      }
    };
    return rows.flatMap((r) => {
      const label = tr(r);
      const pt = at.get(r.osm_id);
      const loc = pt?.file ? pt : box(r.osm_id);
      if (loc?.lat == null) return [];
      const names = pt?.file ? (addresses(':f', { f: pt.file }).get(pt.file) ?? []) : [];
      const up = names.slice(names.indexOf(label) + 1);
      return [
        {
          name: label,
          latitude: loc.lat,
          longitude: loc.lon,
          ...(up.length > 1 && { admin1name: up[0] }),
          ...(up.length && { admin2name: up.at(-1) }),
        },
      ];
    });
  });

  const markers = (w) => {
    const addr = addresses(`SELECT n.id ${w.from}`, w.args);
    return all(w, (f) => `SELECT DISTINCT n.id, m.lat, m.lon ${f}`).map((r) => ({
      id: toUuid('asset', r.id),
      lat: r.lat,
      lon: r.lon,
      ...(addr.has(r.id) ? split(addr.get(r.id)) : NO_ADDR),
    }));
  };

  // Single user: partners and shared albums add nothing
  A.get('/map/markers', (req, _, q) => {
    const p = new URLSearchParams({ withCoordinates: 'true' });
    if (q.get('isArchived') !== 'true') p.set('visibility', 'timeline');
    if (q.get('isFavorite')) p.set('isFavorite', q.get('isFavorite'));
    const after = Date.parse(q.get('fileCreatedAfter')) / 1000 || -Infinity;
    const before = Date.parse(q.get('fileCreatedBefore')) / 1000 || Infinity;
    return markers(where(p, [], ' AND m.epoch >= :qfa AND m.epoch < :qfb', { qfa: after, qfb: before }));
  });

  A.get('/gallery/map/markers', (req, _, q) => {
    const p = new URLSearchParams(q);
    p.set('withCoordinates', 'true');
    if (!p.has('visibility')) p.set('visibility', 'timeline');
    return markers(where(p));
  });
}
