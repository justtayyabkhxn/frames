import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { badRequest, contentDisposition, json, notFound, readJson, sendFile } from './http.mjs';
import { cleanRel } from './library.mjs';
import { exiftool } from './tools.mjs';
import { zipStream } from './zip.mjs';

const API = '/apps/memories/api';
const DIRECT_MIMES = ['image/png', 'image/webp', 'image/avif', 'image/jpeg', 'image/gif'];
const EDITABLE = /^(image\/(jpeg|png|webp|avif|heic|heif|tiff|x-dcraw)|video\/)/;
const EXIF_WRITABLE = [
  'AllDates',
  'Orientation',
  'Title',
  'Description',
  'Label',
  'Make',
  'Model',
  'LensModel',
  'Copyright',
  'GPSLatitude',
  'GPSLongitude',
  'GPSLatitudeRef',
  'GPSLongitudeRef',
  'GPSCoordinates',
  'OffsetTimeOriginal',
  'OffsetTime',
  'Rating',
];

const RATING = "coalesce(CAST(json_extract(m.exif, '$.Rating') AS INTEGER), 0)";
const CAMERA = "nullif(trim(json_extract(m.exif, '$.Model')), '')";

/** Per-user settings: [kv key, response key, default, type]. */
const SETTINGS = [
  ['timelinePath', 'timeline_path', '/', 's'],
  ['enableTopMemories', 'enable_top_memories', 'true', 'b'],
  ['stackRawFiles', 'stack_raw_files', 'true', 'b'],
  ['dedupIdentical', 'dedup_identical', 'false', 'b'],
  ['showOwnerNameTimeline', 'show_owner_name_timeline', 'false', 'b'],
  ['showPhotoBasename', 'show_photo_basename', 'false', 'b'],
  ['livephotoAutoplay', 'livephoto_autoplay', 'false', 'b'],
  ['livephotoLoop', 'livephoto_loop', 'false', 'b'],
  ['videoAutoplay', 'video_autoplay', 'true', 'b'],
  ['videoLoop', 'video_loop', 'false', 'b'],
  ['sidebarFilepath', 'sidebar_filepath', 'false', 'b'],
  ['showExifOnMobile', 'show_exif_on_mobile', 'false', 'b'],
  ['metadataInSlideshow', 'metadata_in_slideshow', 'false', 'b'],
  ['slideshowDuration', 'slideshow_duration', '5', 'n'],
  ['onthisdayDayRange', 'onthisday_day_range', '3', 'n'],
  ['onthisdayPhotosPerYear', 'onthisday_photos_per_year', '10', 'n'],
  ['foldersPath', 'folders_path', '/', 's'],
  ['showHidden', 'show_hidden_folders', 'false', 'b'],
  ['sortFolderMonth', 'sort_folder_month', 'false', 'b'],
  ['sortAlbumMonth', 'sort_album_month', 'true', 'b'],
  ['showHiddenAlbums', 'show_hidden_albums', 'false', 'b'],
  ['album_list_sort', 'album_list_sort', '3', 'n'],
  ['mapTileServerUrl', 'map_tile_server_url', '', 's'],
  ['mapClusterDensity', 'map_cluster_density', '1', 'n'],
];
const castSetting = (v, t) => (t === 'b' ? v === 'true' : t === 'n' ? Number(v) : v);

/** Prefix match on nodes.path for rel ('' = everything). */
function underSql(f, rel, col = 'n.path') {
  if (!rel) return '1';
  const k = `p${f.n++}`;
  f.args[k] = rel;
  f.args[`${k}s`] = `${rel}/`;
  f.args[`${k}l`] = rel.length + 1;
  return `(${col} = :${k} OR substr(${col}, 1, :${k}l) = :${k}s)`;
}

export function registerApi(router, ctx) {
  const { db, lib, previews } = ctx;
  const userConfig = (key) => {
    const s = SETTINGS.find((x) => x[0] === key);
    return castSetting(db.getKv(`user.${key}`, s[2]), s[3]);
  };
  const timelinePaths = () => String(userConfig('timelinePath')).split(';').map(cleanRel);

  /**
   * Build the shared WHERE for timeline queries from query params.
   * ctx.dayFilters lets cluster modules (albums, tags, places, faces) add their own.
   */
  function filter(p) {
    const f = { n: 0, args: {}, joins: [], where: ['m.livevideo = 0'], cluster: false, post: [] };
    for (const add of ctx.dayFilters) add(p, f);

    const archive = p.has('archive');
    if (p.has('folder')) {
      const rel = cleanRel(p.get('folder'));
      const folder = lib.nodeByPath(rel);
      if (!folder?.dir) throw notFound(`Folder not found: ${rel}`);
      if (p.has('recursive')) f.where.push(underSql(f, rel));
      else {
        f.where.push('n.parent = :folder');
        f.args.folder = folder.id;
      }
      f.where.push('n.archived = 0');
    } else if (archive) {
      f.where.push('n.archived = 1');
    } else {
      if (!f.cluster)
        f.where.push(
          `(${timelinePaths()
            .map((t) => underSql(f, t))
            .join(' OR ')})`,
        );
      f.where.push('n.archived = 0');
    }

    if (p.has('frating')) ((f.args.frating = Number(p.get('frating')) | 0), f.where.push(`${RATING} >= :frating`));
    if (p.has('fcamera')) ((f.args.fcamera = p.get('fcamera')), f.where.push(`${CAMERA} = :fcamera`));
    if (p.has('fperson')) {
      f.args.fperson = Number(p.get('fperson')) || 0;
      f.where.push('m.id IN (SELECT fileid FROM faces WHERE cluster = :fperson)');
    }
    if (p.has('fplace')) {
      f.args.fplace = Number(p.get('fplace')) | 0;
      f.where.push('m.id IN (SELECT fileid FROM places WHERE osm_id = :fplace)');
    }
    if (p.has('ftype')) f.where.push(`m.isvideo = ${p.get('ftype') === 'video' ? 1 : 0}`);
    if (p.has('fav')) f.where.push('n.favorite = 1');
    if (p.has('vid')) f.where.push('m.isvideo = 1');
    if (p.has('pano')) f.where.push('m.pano = 1');
    const bounds = p.get('mapbounds')?.split(',').map(Number);
    if (bounds?.length === 4 && bounds.every(Number.isFinite)) {
      f.where.push('m.lat BETWEEN :b0 AND :b1 AND m.lon BETWEEN :b2 AND :b3');
      [f.args.b0, f.args.b1, f.args.b2, f.args.b3] = bounds;
    }
    return f;
  }
  ctx.filter = filter;
  const from = (f) => `FROM media m JOIN nodes n ON n.id = m.id ${f.joins.join(' ')} WHERE ${f.where.join(' AND ')}`;

  const monthOf = (dayid) => {
    const d = new Date(dayid * 86400000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 86400000;
  };
  const monthEnd = (monthid) => {
    const d = new Date(monthid * 86400000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 86400000 - 1;
  };

  function getDays(p) {
    const f = filter(p);
    const rows = db
      .prepare(
        `SELECT m.dayid, count(DISTINCT n.id) AS count ${from(f)} GROUP BY m.dayid ORDER BY m.dayid ${p.has('reverse') ? 'ASC' : 'DESC'}`,
      )
      .all(f.args);
    if (!p.has('monthView')) return rows;
    const months = new Map();
    for (const r of rows) {
      const id = monthOf(r.dayid);
      months.set(id, { dayid: id, count: (months.get(id)?.count ?? 0) + r.count });
    }
    return [...months.values()];
  }

  function getDay(dayIds, p) {
    if (!dayIds.length) return [];
    const f = filter(p);
    const month = p.has('monthView');
    const conds = dayIds.map((d, i) => {
      f.args[`d${i}`] = d;
      if (!month) return `m.dayid = :d${i}`;
      f.args[`e${i}`] = monthEnd(d);
      return `m.dayid BETWEEN :d${i} AND :e${i}`;
    });
    const order = p.has('reverse') ? 'ASC' : 'DESC';
    const limit = Number(p.get('limit')) > 0 ? `LIMIT ${Number(p.get('limit')) | 0}` : '';
    const extra = f.select ?? '';
    const rows = db
      .prepare(
        `
      SELECT DISTINCT n.id AS fileid, m.dayid, m.w, m.h, m.liveid, m.isvideo, m.pano, m.video_duration, n.etag,
        m.indexed_at, n.name AS basename, n.size, m.epoch, n.mime AS mimetype, n.favorite, m.datetaken ${extra}
      ${from(f)} AND (${conds.join(' OR ')})
      ORDER BY m.datetaken ${order}, basename ${order}, fileid ${order} ${limit}`,
      )
      .all(f.args);
    return rows.map((r) => {
      const o = { ...r, mimetype: r.mimetype ?? 'application/octet-stream' };
      if (!o.isvideo) (delete o.isvideo, delete o.video_duration);
      if (!o.liveid) delete o.liveid;
      if (!o.pano) delete o.pano;
      if (o.favorite) o.isfavorite = 1;
      delete o.favorite;
      delete o.datetaken;
      if (month) ((o.dayid_real = o.dayid), (o.dayid = monthOf(o.dayid)));
      for (const post of f.post) post(o);
      return o;
    });
  }

  function preload(days, p) {
    if (p.has('nopreload')) return days;
    let total = 0;
    const pick = [];
    for (const d of days) {
      total += Math.max(d.count, 10);
      pick.push(d);
      if (total >= 50) break;
    }
    const byDay = new Map(pick.map((d) => [d.dayid, d]));
    for (const photo of getDay(
      pick.map((d) => d.dayid),
      p,
    ))
      (byDay.get(photo.dayid).detail ??= []).push(photo);
    return days;
  }

  const q = (url) => url.searchParams;
  const nodeMedia = (id) =>
    db.q('SELECT n.*, m.* FROM nodes n LEFT JOIN media m ON m.id = n.id WHERE n.id = ?').get(Number(id) | 0);

  /* ---------------- config ---------------- */
  router.add('GET', `${API}/config`, (req, res) => {
    const out = {
      version: ctx.version,
      base_url: '/apps/memories/',
      vod_disable: false,
      video_default_quality: '0',
      places_gis: ctx.placesGis?.() ?? -1,
      places_search_url: ctx.placesSearchUrl?.() ?? '',
      map_tile_servers: ctx.mapTileServers ?? null,
      map_cluster_density: 1,
      language: ctx.language,
      locale: ctx.locale,
      systemtags_enabled: true,
      albums_enabled: true,
      recognize_installed: !!ctx.lens,
      recognize_enabled: !!ctx.lens,
      facerecognition_installed: false,
      facerecognition_enabled: false,
      lens_enabled: !!ctx.lens,
      preview_generator_enabled: true,
      vips_enabled: !!ctx.ff,
      high_res_cond_default: 'zoom',
    };
    for (const [key, name, , t] of SETTINGS)
      out[name] = castSetting(db.getKv(`user.${key}`, SETTINGS.find((s) => s[0] === key)[2]), t);
    out.map_tile_server_url ||= ctx.mapTileUrl?.() ?? '';
    json(res, out);
  });
  router.add('PUT', `${API}/config/:key`, async (req, res, { key }) => {
    if (!SETTINGS.some((s) => s[0] === key)) throw badRequest('Unknown setting');
    const { value } = await readJson(req);
    db.setKv(`user.${key}`, value);
    json(res, {});
  });
  router.add('GET', `${API}/describe`, (req, res) =>
    json(res, { version: ctx.version, baseUrl: '/', loginFlowUrl: null, appsPath: '/apps/memories', uid: ctx.uid }),
  );

  /* ---------------- days ---------------- */
  router.add('GET', `${API}/days`, (req, res, _, url) => json(res, preload(getDays(q(url)), q(url))));
  router.add('POST', `${API}/days`, async (req, res, _, url) => {
    const { dayIds = [] } = await readJson(req);
    json(res, getDay(dayIds.slice(0, 2000).map(Number).filter(Number.isFinite), q(url)));
  });
  router.add('GET', `${API}/days/:id`, (req, res, { id }, url) =>
    json(res, getDay(id.split(',').slice(0, 2000).map(Number).filter(Number.isFinite), q(url))),
  );

  /* ---------------- folders ---------------- */
  router.add('GET', `${API}/folders/sub`, (req, res, _, url) => {
    const rel = cleanRel(q(url).get('folder'));
    const folder = lib.nodeByPath(rel);
    if (!folder?.dir) throw notFound(`Folder not found: ${rel}`);
    const hidden = userConfig('showHidden');
    const subs = db
      .q('SELECT id, name, path FROM nodes WHERE parent = ? AND dir = 1')
      .all(folder.id)
      .filter((s) => hidden || !s.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    json(
      res,
      subs.map((s) => {
        const f = { n: 0, args: {} };
        const where = underSql(f, s.path);
        const previews = db
          .prepare(
            `SELECT n.id AS fileid, n.etag, m.indexed_at FROM media m JOIN nodes n ON n.id = m.id WHERE m.livevideo = 0 AND ${where} ORDER BY m.datetaken DESC LIMIT 4`,
          )
          .all(f.args);
        return { fileid: s.id, name: s.name, previews };
      }),
    );
  });

  /* ---------------- images ---------------- */
  async function previewFile(id, x, y, square) {
    const n = nodeMedia(id);
    if (!n?.indexed_at) throw notFound();
    const file = await previews.get(n.id, lib.abs(n.path), !!n.isvideo, x, y, square);
    if (!file) throw notFound('Preview not available');
    return { file, n };
  }
  ctx.previewFile = previewFile;
  router.add('GET', `${API}/image/preview/:id`, async (req, res, { id }, url) => {
    const p = q(url);
    const { file, n } = await previewFile(id, Number(p.get('x')) || 256, Number(p.get('y')) || 256, p.get('a') !== '1');
    sendFile(req, res, file, {
      type: 'image/jpeg',
      headers: { 'Content-Disposition': contentDisposition(`${n.name}.jpg`) },
    });
  });
  router.add('POST', `${API}/image/multipreview`, async (req, res) => {
    const { files = [] } = await readJson(req);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
    // Build all previews in parallel, but write in request order
    const jobs = files
      .filter((f) => f.fileid > 0)
      .map((f) =>
        previewFile(f.fileid, Number(f.x), Number(f.y), f.a !== '1').then(
          ({ file }) => ({ f, buf: fs.readFileSync(file) }),
          () => null,
        ),
      );
    for (const job of jobs) {
      const r = await job;
      if (!r) continue;
      const head = Buffer.from(JSON.stringify({ reqid: r.f.reqid, len: r.buf.length, type: 'image/jpeg' }));
      res.write(Buffer.concat([Buffer.from([head.length]), head, r.buf]));
    }
    res.end();
  });

  function info(id, p) {
    const n = nodeMedia(id);
    if (!n?.indexed_at) throw notFound(`File not found: ${id}`);
    const out = {
      fileid: n.id,
      dayid: n.dayid,
      w: n.w,
      h: n.h,
      datetaken: n.datetaken,
      etag: n.etag,
      permissions: 'CRUD',
      mimetype: n.mime,
      size: n.size,
      basename: n.name,
      mtime: n.mtime,
      owneruid: ctx.uid,
      ownername: ctx.displayName,
      filename: `/${n.path}`,
      intimeline: timelinePaths().some((t) => !t || n.path === t || n.path.startsWith(`${t}/`)),
    };
    if (n.pano) out.pano = n.pano;
    if (!p.has('basic')) {
      out.exif = JSON.parse(n.exif || '{}');
      const address = ctx.addressOf?.(n.id);
      if (address?.length) ((out.address = address.join(', ')), (out.address_short = address[0]));
    }
    if (p.has('tags')) out.tags = ctx.tagsOf?.(n.id) ?? {};
    if (p.get('clusters'))
      out.clusters = Object.fromEntries(
        p
          .get('clusters')
          .split(',')
          .map((c) => [c, ctx.clustersOf?.[c]?.(n.id) ?? []]),
      );
    if (p.has('current')) out.current = out.exif;
    return out;
  }
  ctx.info = info;
  /** Values the filter panel can offer, narrowed by every other active filter. */
  router.add('GET', `${API}/filters`, (req, res, _, url) => {
    const facet = (param, sql) => {
      const p = new URLSearchParams(url.searchParams);
      p.delete(param);
      const f = filter(p);
      return db.prepare(sql(from(f))).all(f.args);
    };
    json(res, {
      ratings: facet(
        'frating',
        (w) => `SELECT ${RATING} AS value, count(DISTINCT n.id) AS count ${w} GROUP BY value ORDER BY value DESC`,
      ),
      cameras: facet(
        'fcamera',
        (w) =>
          `SELECT ${CAMERA} AS value, count(DISTINCT n.id) AS count ${w} AND value IS NOT NULL GROUP BY value ORDER BY count DESC, value LIMIT 50`,
      ),
      people: facet(
        'fperson',
        (w) => `SELECT fc.cluster AS value, p.name, count(DISTINCT fc.fileid) AS count
          FROM faces fc LEFT JOIN people p ON p.id = fc.cluster
          WHERE fc.cluster > 0 AND fc.fileid IN (SELECT n.id ${w})
          GROUP BY fc.cluster ORDER BY p.name IS NULL, count DESC LIMIT 50`,
      ),
      places: facet(
        'fplace',
        (w) => `SELECT pl.osm_id AS value, pt.name, pt.admin_level, count(*) AS count
          FROM places pl JOIN planet pt ON pt.osm_id = pl.osm_id
          WHERE pl.fileid IN (SELECT n.id ${w})
          GROUP BY pl.osm_id ORDER BY count DESC, pt.admin_level LIMIT 50`,
      ),
      types: facet(
        'ftype',
        (w) =>
          `SELECT CASE m.isvideo WHEN 1 THEN 'video' ELSE 'photo' END AS value, count(DISTINCT n.id) AS count ${w} GROUP BY value`,
      ),
    });
  });

  router.add('GET', `${API}/image/info/:id`, (req, res, { id }, url) => json(res, info(id, q(url))));

  router.add('GET', `${API}/image/decodable/:id`, async (req, res, { id }) => {
    const n = lib.mustNode(id);
    if (DIRECT_MIMES.includes(n.mime))
      return sendFile(req, res, lib.abs(n.path), { type: n.mime, headers: { ETag: `"${n.etag}"` } });
    const { file } = await previewFile(n.id, 4096, 4096, false);
    sendFile(req, res, file, { type: 'image/jpeg', headers: { ETag: `"${n.etag}"` } });
  });

  /** Write EXIF tags (EXIF_WRITABLE only) into the file and re-index it. */
  async function setExif(id, raw) {
    const n = lib.mustNode(id);
    if (!EDITABLE.test(n.mime ?? '')) throw badRequest(`Cannot edit ${n.name}`);
    const args = [];
    for (const [k, v] of Object.entries(raw)) {
      if (!EXIF_WRITABLE.includes(k)) throw badRequest('Invalid EXIF tag');
      args.push(`-${k}=${v ?? ''}`);
    }
    const r = await exiftool(ctx.et, [
      '-overwrite_original',
      '-preserve',
      '-n',
      '-api',
      'QuickTimeUTC',
      ...args,
      lib.abs(n.path),
    ]);
    if (r.code !== 0) throw badRequest(`exiftool: ${r.err.trim()}`);
    await ctx.indexer.indexPath(n.path);
    return n.id;
  }
  ctx.setExif = setExif;
  router.add('PATCH', `${API}/image/set-exif/:id`, async (req, res, { id }) => {
    const { raw = {} } = await readJson(req);
    json(res, info(await setExif(id, raw), new URLSearchParams('basic=1')));
  });

  router.add('POST', `${API}/image/reindex/:id`, async (req, res, { id }) => {
    const n = lib.mustNode(id);
    await ctx.indexer.indexPath(n.path);
    json(res, { indexed: true });
  });

  router.add('DELETE', `${API}/image/delete/:id`, (req, res, { id }) => {
    lib.trash(id);
    json(res, {});
  });

  /* ---------------- stream / download ---------------- */
  router.add('GET', `${API}/stream/:id`, (req, res, { id }, url) => {
    const n = lib.mustNode(id);
    sendFile(req, res, lib.abs(n.path), {
      type: n.mime,
      cache: 'private, max-age=3600',
      headers: { 'Content-Disposition': contentDisposition(n.name, q(url).has('attachment')) },
    });
  });

  const downloads = new Map();
  /** Register file ids for download; returns a handle for GET /api/download/:handle. */
  ctx.downloadHandle = (files) => {
    const handle = randomUUID();
    downloads.set(handle, files.map(Number));
    setTimeout(() => downloads.delete(handle), 3600_000).unref();
    return handle;
  };
  router.add('POST', `${API}/download`, async (req, res) => {
    const { files = [] } = await readJson(req);
    json(res, { handle: ctx.downloadHandle(files) });
  });
  router.add('GET', `${API}/download/:handle`, (req, res, { handle }) => {
    const ids = downloads.get(handle);
    if (!ids) throw notFound('Download expired');
    const nodes = ids.map((i) => lib.node(i)).filter((n) => n && !n.dir);
    if (nodes.length === 1) {
      return sendFile(req, res, lib.abs(nodes[0].path), {
        type: nodes[0].mime,
        headers: { 'Content-Disposition': contentDisposition(nodes[0].name, true) },
      });
    }
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(`download-${new Date().toISOString().slice(0, 10)}.zip`, true),
    });
    zipStream(
      res,
      nodes.map((n) => ({ name: n.name, file: lib.abs(n.path), mtime: n.mtime })),
    );
  });

  /* ---------------- archive ---------------- */
  router.add('PATCH', `${API}/archive/:id`, async (req, res, { id }) => {
    const { archive } = await readJson(req);
    lib.setArchived(id, !!archive);
    json(res, {});
  });

  /* ---------------- sharing: links need a public server, not available offline ---------------- */
  router.add('GET', `${API}/share/links`, (req, res) => json(res, []));
  router.add('POST', `${API}/share/node`, () => {
    throw badRequest(
      'Share links are not available in Frames (offline). Use download or the share button in the viewer.',
    );
  });
  router.add('POST', `${API}/share/delete`, (req, res) => json(res, {}));

  /* ---------------- admin / status (minimal) ---------------- */
  router.add('GET', `${API}/system-status`, (req, res) =>
    json(res, {
      status: ctx.indexer.status,
      indexed_count: db.q('SELECT count(*) AS n FROM media').get().n,
      library: ctx.root,
      exiftool: ctx.et,
      ffmpeg: ctx.ff?.ffmpeg ?? null,
      platform: `${os.platform()} ${os.arch()}`,
    }),
  );
  router.add('GET', `${API}/frames/status`, (req, res) =>
    json(res, { ...ctx.indexer.status, dir: ctx.root, count: db.q('SELECT count(*) AS n FROM media').get().n }),
  );
  router.add('POST', `${API}/frames/rescan`, (req, res) => (void ctx.indexer.scan(), json(res, {})));
}
