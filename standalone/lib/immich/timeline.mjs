import { maybeId, toUuid } from './ids.mjs';

const iso = (sec) => new Date(sec * 1000).toISOString();
const BUCKET = "strftime('%Y-%m-01', m.datetaken, 'unixepoch')";
const archived = 'n.archived = 1';

/** Columns every asset query selects (timeline buckets, search results, asset info). */
export const ASSET_SELECT = `n.id, n.path, n.name, n.mime, n.size, n.favorite, n.etag, n.mtime, m.w, m.h, m.datetaken, m.epoch,
  m.isvideo, m.video_duration, m.liveid, m.pano, m.lat, m.lon, m.exif, m.indexed_at,
  (SELECT lv.id FROM media lv WHERE m.liveid IS NOT NULL AND lv.liveid = m.liveid AND lv.livevideo = 1 LIMIT 1) AS livevideo_id,
  ${archived} AS archived`;

/**
 * Translate Gallery's asset query params into Frames' timeline filter (ctx.filter), adding the
 * Immich-only conditions. Returns { f, from } ready for SQL.
 */
export function assetFilter(ctx, q) {
  const vis = q.get('visibility');
  // Albums, people and tags span the whole library (archived files too), so they skip Frames' timeline-path filter
  const scoped = ['albumId', 'personId', 'personIds', 'tagId', 'tagIds'].some((k) => q.has(k));
  const p = new URLSearchParams(vis === 'archive' ? { archive: '1' } : {});
  // No visibility means everything visible (timeline and archive), as in Immich
  const wide = scoped || !vis;
  const f = wide ? { where: ['m.livevideo = 0'], args: {}, joins: [] } : ctx.filter(p);
  const add = (sql, args = {}) => (f.where.push(sql), Object.assign(f.args, args));
  if (wide && vis === 'archive') add(archived);
  if (wide && vis === 'timeline') add(`NOT ${archived}`);
  if (vis === 'hidden' || vis === 'locked' || q.get('isTrashed') === 'true') add('0');
  if (q.get('isFavorite') === 'true') add('n.favorite = 1');
  if (q.get('isFavorite') === 'false') add('n.favorite = 0');
  if (q.get('type') === 'IMAGE') add('m.isvideo = 0');
  if (q.get('type') === 'VIDEO') add('m.isvideo = 1');
  const album = maybeId(q.get('albumId'), 'album');
  if (q.has('albumId')) add('n.id IN (SELECT fileid FROM album_files WHERE album = :qalbum)', { qalbum: album });
  const people = [...q.getAll('personId'), ...q.getAll('personIds')].map((v) => maybeId(v, 'person'));
  people.forEach((id, i) => add(`n.id IN (SELECT fileid FROM faces WHERE cluster = :qp${i})`, { [`qp${i}`]: id }));
  const tags = [...q.getAll('tagId'), ...q.getAll('tagIds')].map((v) => maybeId(v, 'tag'));
  tags.forEach((id, i) => add(`n.id IN (SELECT fileid FROM tag_files WHERE tag = :qt${i})`, { [`qt${i}`]: id }));
  for (const [key, tag] of [
    ['make', 'Make'],
    ['model', 'Model'],
    ['lensModel', 'LensModel'],
  ])
    if (q.get(key)) add(`json_extract(m.exif, '$.${tag}') = :q${key}`, { [`q${key}`]: q.get(key) });
  if (q.get('rating'))
    add("coalesce(json_extract(m.exif, '$.Rating'), 0) >= :qrating", { qrating: Number(q.get('rating')) });
  if (q.get('takenAfter')) add('m.datetaken >= :qafter', { qafter: Date.parse(q.get('takenAfter')) / 1000 });
  if (q.get('takenBefore')) add('m.datetaken < :qbefore', { qbefore: Date.parse(q.get('takenBefore')) / 1000 });
  if (q.get('withCoordinates') === 'true') add('m.lat IS NOT NULL AND m.lon IS NOT NULL');
  // Map viewport: west,south,east,north (west > east crosses the antimeridian)
  const [w, s, e, n] = (q.get('bbox') ?? '').split(',').map(Number);
  if ([w, s, e, n].every(Number.isFinite))
    add(`m.lat BETWEEN :qs AND :qn AND ${w <= e ? 'm.lon BETWEEN :qw AND :qe' : '(m.lon >= :qw OR m.lon <= :qe)'}`, {
      qw: w,
      qs: s,
      qe: e,
      qn: n,
    });
  for (const key of ['city', 'state', 'country'])
    if (q.get(key))
      add(
        `n.id IN (SELECT pl.fileid FROM places pl JOIN planet pt ON pt.osm_id = pl.osm_id WHERE pt.name = :q${key})`,
        { [`q${key}`]: q.get(key) },
      );
  if (q.get('isInAlbum') === 'true') add('n.id IN (SELECT fileid FROM album_files)');
  if (q.get('isNotInAlbum') === 'true') add('n.id NOT IN (SELECT fileid FROM album_files)');
  if (q.get('originalFileName')) add("n.name LIKE '%' || :qname || '%'", { qname: q.get('originalFileName') });
  if (q.get('description'))
    add("json_extract(m.exif, '$.Description') LIKE '%' || :qdesc || '%'", { qdesc: q.get('description') });
  const from = `FROM media m JOIN nodes n ON n.id = m.id ${f.joins.join(' ')} WHERE ${f.where.join(' AND ')}`;
  return { f, from };
}

export const visibilityOf = (row) => (row.archived ? 'archive' : 'timeline');
export const projectionOf = (row) => (row.pano === 2 ? 'EQUIRECTANGULAR' : null);

export function registerTimeline(router, ctx, A) {
  const { db } = ctx;
  const owner = () => ctx.immichUser().id;
  const order = (q) => (q.get('order') === 'asc' ? 'ASC' : 'DESC');

  A.get('/timeline/buckets', (req, _, q) => {
    if (q.get('isTrashed') === 'true') return ctx.trash?.buckets(q) ?? [];
    const { f, from } = assetFilter(ctx, q);
    return db
      .prepare(
        `SELECT ${BUCKET} AS timeBucket, count(DISTINCT n.id) AS count ${from} GROUP BY timeBucket ORDER BY timeBucket ${order(q)}`,
      )
      .all(f.args);
  });

  A.get('/timeline/bucket', (req, _, q) => {
    if (q.get('isTrashed') === 'true') return ctx.trash.bucket(q);
    const { f, from } = assetFilter(ctx, q);
    const rows = db
      .prepare(
        `SELECT DISTINCT ${ASSET_SELECT} ${from} AND ${BUCKET} = :bucket ORDER BY m.datetaken ${order(q)}, n.id ${order(q)}`,
      )
      .all({ ...f.args, bucket: String(q.get('timeBucket')).slice(0, 10) });
    const col = (fn) => rows.map(fn);
    return {
      id: col((r) => toUuid('asset', r.id)),
      ownerId: col(owner),
      ratio: col((r) => (r.w && r.h ? r.w / r.h : 1)),
      createdAt: col((r) => iso(r.indexed_at || r.mtime || 0)),
      fileCreatedAt: col((r) => iso(r.epoch)),
      localOffsetHours: col((r) => (r.datetaken - r.epoch) / 3600),
      isFavorite: col((r) => !!r.favorite),
      isImage: col((r) => !r.isvideo),
      isTrashed: col(() => false),
      duration: col((r) => (r.isvideo ? Math.round((r.video_duration || 0) * 1000) : null)),
      livePhotoVideoId: col((r) => (r.livevideo_id ? toUuid('asset', r.livevideo_id) : null)),
      projectionType: col(projectionOf),
      thumbhash: col(() => null),
      visibility: col(visibilityOf),
      stack: col(() => null),
      latitude: col((r) => r.lat),
      longitude: col((r) => r.lon),
    };
  });

  A.get('/timeline/bucket-covers', () => []);
}
