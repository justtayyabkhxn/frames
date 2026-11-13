import { badRequest, json, notFound } from './http.mjs';
import { createTiles } from './map-tiles.mjs';
import { createPlaces } from './places-data.mjs';

const API = '/apps/memories/api';

export function registerMap(router, ctx) {
  const { db } = ctx;
  const places = createPlaces(ctx);
  const tiles = createTiles(ctx, places);

  /** Shared timeline WHERE (api.mjs filter when exposed as ctx.filter, else everything outside the archive). */
  const base = (p = new URLSearchParams()) => {
    const f = ctx.filter?.(p) ?? {
      args: {},
      joins: [],
      where: ['m.livevideo = 0', 'n.archived = 0'],
    };
    return {
      ...f,
      sql: `FROM media m JOIN nodes n ON n.id = m.id ${f.joins.join(' ')} WHERE ${f.where.join(' AND ')}`,
    };
  };

  /* ---------------- map ---------------- */
  router.add('GET', `${API}/map/init`, (req, res) => {
    const f = base();
    const pos = db
      .prepare(
        `SELECT m.lat, m.lon ${f.sql} AND m.lat IS NOT NULL AND m.lon IS NOT NULL ORDER BY m.datetaken DESC LIMIT 1`,
      )
      .get(f.args);
    json(res, { pos: pos ? { lat: pos.lat, lon: pos.lon } : null });
  });

  router.add('GET', `${API}/map/clusters`, (req, res, _, url) => {
    const p = url.searchParams;
    const bounds = p.get('bounds')?.split(',').map(Number);
    const zoom = Number(p.get('zoom'));
    if (bounds?.length !== 4 || !bounds.every(Number.isFinite) || !p.get('zoom') || !Number.isFinite(zoom))
      throw badRequest('Missing parameter bounds or zoom');
    const density = Number(db.getKv('user.mapClusterDensity', '1')) || 1;
    const f = base();
    Object.assign(f.args, {
      g: 180 / (2 ** zoom * density),
      b0: bounds[0],
      b1: bounds[1],
      b2: bounds[2],
      b3: bounds[3],
    });
    const clusters = db
      .prepare(
        `SELECT max(m.id) AS id, count(*) AS count, avg(m.lat) AS lat, avg(m.lon) AS lon ${f.sql}
         AND m.lat BETWEEN :b0 AND :b1 AND m.lon BETWEEN :b2 AND :b3
         GROUP BY floor(m.lat / :g), floor(m.lon / :g)`,
      )
      .all(f.args);
    const previews = new Map(
      clusters.length
        ? db
            .prepare(
              `SELECT m.id AS fileid, m.dayid, m.h, m.w, m.indexed_at, n.etag FROM media m JOIN nodes n ON n.id = m.id
               WHERE m.id IN (${clusters.map((c) => c.id).join(',')})`,
            )
            .all()
            .map((r) => [r.fileid, r])
        : [],
    );
    json(
      res,
      clusters.map((c) => ({
        id: c.id,
        center: [c.lat, c.lon],
        count: c.count,
        preview: previews.has(c.id) ? { ...previews.get(c.id), mapcluster: c.id } : null,
      })),
    );
  });

  // Cluster ids are the newest file id in the cluster
  router.add('GET', `${API}/map/clusters/preview/:id`, (req, res, { id }) => {
    if (!db.q('SELECT 1 FROM media WHERE id = ?').get(Number(id) | 0)) throw notFound();
    res.writeHead(302, { Location: `${API}/image/preview/${Number(id) | 0}?x=256&y=256` }).end();
  });

  router.add('GET', `${API}/map/tiles/:z/:x/:y.png`, (req, res, params) => {
    const [z, x, y] = [params.z, params.x, params.y].map(Number);
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 20) throw notFound();
    const { buf, maxAge } = tiles.get(z, x, y);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': buf.length,
      'Cache-Control': `private, max-age=${maxAge}`,
    });
    res.end(buf);
  });

  /* ---------------- places ---------------- */
  router.add('GET', `${API}/clusters/places`, (req, res, _, url) => {
    const p = url.searchParams;
    if (!places.ready()) return json(res, []);
    const inside = Number(p.get('inside') ?? 0) | 0;
    const marked = Number(p.get('mark') ?? 1) | 0;
    const covers = p.get('covers') !== '0';
    const f = base();
    const where = [];
    if (inside > 0) {
      f.args.inside = inside;
      where.push('EXISTS (SELECT 1 FROM places i WHERE i.osm_id = :inside AND i.fileid = mp.fileid)');
    } else if (inside !== -1 && marked > 0) where.push('mp.mark = 1');
    const levels =
      inside > 0
        ? 'e.admin_level > (SELECT admin_level FROM planet WHERE osm_id = :inside) AND e.admin_level <= (SELECT admin_level FROM planet WHERE osm_id = :inside) + 3'
        : inside === -1
          ? 'e.admin_level = 2'
          : 'e.admin_level > 0';
    const rows = db
      .prepare(
        `SELECT sub.osm_id, sub.count, e.name, e.other_names,
           (SELECT c.fileid FROM places c JOIN media cm ON cm.id = c.fileid WHERE c.osm_id = sub.osm_id AND cm.livevideo = 0
            ORDER BY cm.datetaken DESC LIMIT 1) AS cover
         FROM (
           SELECT mp.osm_id, count(DISTINCT m.id) AS count
           ${f.sql.replace('FROM media m', 'FROM places mp JOIN media m ON m.id = mp.fileid')}
           ${where.map((w) => `AND ${w}`).join(' ')}
           GROUP BY mp.osm_id ${marked ? 'HAVING count(DISTINCT m.id) >= 3' : ''}
         ) sub JOIN planet e ON e.osm_id = sub.osm_id
         WHERE ${levels}
         ORDER BY sub.count DESC, e.name, e.osm_id`,
      )
      .all(f.args);
    const etag = (id) => db.q('SELECT etag FROM nodes WHERE id = ?').get(id)?.etag;
    json(
      res,
      rows.map((r) => ({
        osm_id: r.osm_id,
        count: r.count,
        name: places.translate(r.name, r.other_names),
        ...(covers && { cover: r.cover, cover_etag: etag(r.cover) }),
        cluster_id: r.osm_id,
        cluster_type: 'places',
      })),
    );
  });

  router.add('GET', `${API}/places/search`, (req, res, _, url) =>
    json(res, places.search(url.searchParams.get('q')?.trim())),
  );

  ctx.dayFilters.push((p, f) => {
    if (!p.has('places')) return;
    f.cluster = true;
    if (p.get('places') === 'NULL') return f.where.push('(m.lat IS NULL OR m.lon IS NULL)');
    f.args.placeid = Number(p.get('places')) | 0;
    f.where.push('m.id IN (SELECT fileid FROM places WHERE osm_id = :placeid)');
  });
  ctx.placesGis = () => (places.ready() ? 1 : -1);
  ctx.placesSearchUrl = () => (places.ready() ? `${API}/places` : '');
  // Tile URL for "automatic" (empty user setting): OSM direct from the browser when online, else ours
  const LOCAL_TILES = `${API}/map/tiles/{z}/{x}/{y}.png`;
  const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const ATTRIBUTION = '&copy; <a target="_blank" href="http://osm.org/copyright">OpenStreetMap</a> contributors';
  ctx.mapTileUrl = () => (tiles.isOnline() ? '' : LOCAL_TILES);
  ctx.mapTileServers = [
    {
      name: 'Automatic (online map, offline basemap without internet)',
      url: '',
      attribution: ATTRIBUTION,
      maxZoom: 19,
      csp: [],
    },
    { name: 'OpenStreetMap', url: OSM_TILES, attribution: ATTRIBUTION, maxZoom: 19, csp: [] },
    { name: 'Offline basemap', url: LOCAL_TILES, attribution: ATTRIBUTION, maxZoom: 19, csp: [] },
  ];
  ctx.addressOf = (fileid) => places.addressOf(fileid);
  ctx.onIndexed = () => void places.setup().then(places.sync);

  const tick = () => places.setup().then(places.sync);
  tiles.isOnline();
  setTimeout(tick, 2000).unref();
  setInterval(tick, 60_000).unref();
}
