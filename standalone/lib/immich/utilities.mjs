import { duplicatesOf } from '../duplicates.mjs';
import { badRequest, readJson } from '../http.mjs';
import { fromUuid, maybeId, toUuid } from './ids.mjs';
import { ASSET_SELECT, assetFilter } from './timeline.mjs';

const U = (id) => toUuid('asset', id);
const iso = (sec) => new Date(sec * 1000).toISOString();
const DAY = 86_400_000;
const HOG_MIN = 100 * 1024 ** 2;
const BURST_GAP = 2;
const BURST_MIN = 3;
const ALL_MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].flatMap((n, m) =>
  Array.from({ length: n }, (_, d) => (m + 1) * 100 + d + 1),
);
const MD = "CAST(strftime('%m%d', m.datetaken, 'unixepoch') AS INTEGER)";
const SCOPE = 'FROM media m JOIN nodes n ON n.id = m.id WHERE m.livevideo = 0';
const COLS = `n.id, n.name, n.size, n.favorite, m.w, m.h, m.datetaken, m.isvideo, m.video_duration,
  EXISTS (SELECT 1 FROM album_files af WHERE af.fileid = n.id) AS in_album`;
const NOT_KEPT = 'n.id NOT IN (SELECT value FROM json_each(:kept))';
// Gallery's rule: screenshot-like names, or PNGs without a camera make/model
const SCREENSHOT = `m.isvideo = 0 AND (n.name LIKE '%screenshot%' OR n.name LIKE '%screen shot%'
  OR ((n.mime = 'image/png' OR n.name LIKE '%.png') AND json_extract(m.exif, '$.Make') IS NULL AND json_extract(m.exif, '$.Model') IS NULL))`;
const TYPE = { image: 'm.isvideo = 0', video: 'm.isvideo = 1' };

/** Days a review was completed on, counted back from today (or yesterday) in the user's time zone. */
function streak(dates, tz) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' });
  } catch {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' });
  }
  const key = (t) => fmt.format(new Date(t));
  const days = new Set(dates.map((d) => key(Date.parse(d))));
  let t = Date.now();
  if (!days.has(key(t))) t -= DAY;
  let n = 0;
  while (days.has(key(t))) (n++, (t -= DAY));
  return n;
}

export function registerUtilities(router, ctx, A) {
  const { db, lib } = ctx;
  const dups = duplicatesOf(ctx);
  const ids = (list) => (Array.isArray(list) ? list : []).map((u) => maybeId(u, 'asset')).filter((n) => n != null);

  // Duplicates: Frames' lens groups at its "normal" SigLIP preset (0.03 cosine distance)
  const dupId = (g) => toUuid('stack', Math.min(...g.files.map((f) => f.fileid)));
  const dupGroups = async () => (ctx.lens?.state === 'ready' ? (await dups.scan()).groups : []);
  const findGroups = async (uuids) => (await dupGroups()).filter((g) => uuids.includes(dupId(g)));

  A.get('/duplicates', async () =>
    (await dupGroups()).map((g) => ({
      duplicateId: dupId(g),
      assets: g.files.map((f) => ctx.assetDto(f.fileid)),
      suggestedKeepAssetIds: [U(g.keep)],
    })),
  );
  A.post('/duplicates/resolve', async (req) => {
    const { groups = [] } = await readJson(req);
    const found = await findGroups(groups.map((g) => g.duplicateId));
    return groups.map(({ duplicateId: id, keepAssetIds, trashAssetIds }) => {
      const g = found.find((x) => dupId(x) === id);
      if (!g) return { id, success: false, error: 'not_found' };
      const inGroup = new Set(g.files.map((f) => f.fileid));
      const keep = ids(keepAssetIds).filter((n) => inGroup.has(n));
      const trash = ids(trashAssetIds).filter((n) => inGroup.has(n) && !keep.includes(n));
      if (!keep.length || !trash.length) return { id, success: false, error: 'validation' };
      const trashed = dups.resolve(keep, trash);
      return trashed.length === trash.length
        ? { id, success: true }
        : { id, success: false, error: 'unknown', errorMessage: 'Some files could not be trashed' };
    });
  });
  const dismiss = async (uuids) => (dups.dismiss((await findGroups(uuids)).map((g) => g.key)), null);
  A.del('/duplicates', async (req) => dismiss((await readJson(req)).ids ?? []));
  A.del('/duplicates/:id', (req, { id }) => dismiss([id]));

  A.post('/search/large-assets', (req, _, q) => {
    const { f, from } = assetFilter(ctx, q);
    const size = Math.min(Math.max(Number(q.get('size')) || 250, 1), 1000);
    const page = Math.max(Number(q.get('page')) || 1, 1);
    return db
      .prepare(
        `SELECT DISTINCT ${ASSET_SELECT} ${from} AND n.size >= :qmin ORDER BY n.size DESC, n.id DESC LIMIT :qlim OFFSET :qoff`,
      )
      .all({ ...f.args, qmin: Number(q.get('minFileSize')) || 0, qlim: size, qoff: (page - 1) * size })
      .map((r) => ctx.assetDtoFromRow(r));
  });

  // Cleanup hub. "Keep" decisions and day reviews live in kv; Frames has no blur analysis, so Blurry stays empty.
  const kv = (k) => JSON.parse(db.getKv(k, '{}'));
  const keptOf = (queue) => kv('cleanup.kept')[queue] ?? [];
  const setKept = (queue, list) =>
    db.setKv('cleanup.kept', JSON.stringify({ ...kv('cleanup.kept'), [queue]: [...new Set(list)] }));

  const cleanupDto = (r, kept) => ({
    id: U(r.id),
    type: r.isvideo ? 'VIDEO' : 'IMAGE',
    originalFileName: r.name,
    localDateTime: iso(r.datetaken),
    thumbhash: null,
    width: r.w,
    height: r.h,
    duration: r.isvideo ? Math.round((r.video_duration || 0) * 1000) : 0,
    fileSize: r.size ?? 0,
    isFavorite: !!r.favorite,
    inAlbum: !!r.in_album,
    city: ctx.addressOf?.(r.id)?.[0] ?? null,
    kept: !!kept?.has(r.id),
  });
  const rowsById = (list) =>
    new Map(
      db
        .prepare(`SELECT ${COLS} ${SCOPE} AND n.id IN (SELECT value FROM json_each(:ids))`)
        .all({ ids: JSON.stringify(list) })
        .map((r) => [r.id, r]),
    );

  /** WHERE and ORDER BY of the flat list queues. */
  const listQuery = (queue, q) => {
    if (queue === 'space_hogs') {
      const type = TYPE[q.get('type')] ?? '1';
      return {
        where: `n.size >= :min AND ${type}`,
        order: 'n.size DESC, n.id DESC',
        args: { min: q.has('minSize') ? Number(q.get('minSize')) : HOG_MIN },
      };
    }
    if (queue === 'screenshots') return { where: SCREENSHOT, order: 'm.datetaken DESC, n.id DESC', args: {} };
    if (queue === 'blurry') return { where: '0', order: 'n.id', args: {} };
  };

  /** Runs of BURST_MIN+ photos, each within BURST_GAP seconds of the previous one. */
  const bursts = () => {
    const rows = db
      .prepare(`SELECT ${COLS} ${SCOPE} AND m.isvideo = 0 AND ${NOT_KEPT} ORDER BY m.datetaken, n.id`)
      .all({ kept: JSON.stringify(keptOf('bursts')) });
    const out = [];
    let run = [];
    for (const r of [...rows, null]) {
      if (r && run.length && r.datetaken - run.at(-1).datetaken <= BURST_GAP) run.push(r);
      else {
        if (run.length >= BURST_MIN) out.push(run);
        run = r ? [r] : [];
      }
    }
    return out;
  };
  const largest = (rows) => rows.reduce((a, b) => (b.size > a.size ? b : a));
  const reclaim = (groups) => groups.reduce((s, g) => s + g.reduce((t, r) => t + r.size, 0) - largest(g).size, 0);
  const dupRows = async () => {
    const groups = (await dupGroups()).filter((g) => !g.files.some((f) => keptOf('duplicates').includes(f.fileid)));
    const rows = rowsById(groups.flatMap((g) => g.files.map((f) => f.fileid)));
    return groups.map((g) => ({ g, rows: g.files.map((f) => rows.get(f.fileid)).filter(Boolean) }));
  };

  A.get('/cleanup/queues/:queue/count', async (req, { queue }, q) => {
    if (queue === 'bursts') {
      const groups = bursts();
      return { count: groups.length, bytes: reclaim(groups) };
    }
    if (queue === 'duplicates') {
      const groups = (await dupRows()).map((x) => x.rows).filter((r) => r.length > 1);
      return { count: groups.length, bytes: reclaim(groups) };
    }
    const l = listQuery(queue, q);
    if (!l) throw badRequest('Unknown queue');
    return db
      .prepare(`SELECT count(*) AS count, coalesce(sum(n.size), 0) AS bytes ${SCOPE} AND ${NOT_KEPT} AND ${l.where}`)
      .get({ ...l.args, kept: JSON.stringify(keptOf(queue)) });
  });

  A.get('/cleanup/queues/:queue', async (req, { queue }, q) => {
    const limit = Math.min(Math.max(Number(q.get('limit')) || 100, 1), 500);
    const off = Math.max(Number(q.get('cursor')) || 0, 0);
    const next = (n) => (n > off + limit ? String(off + limit) : null);
    if (queue === 'bursts' || queue === 'duplicates') {
      const all =
        queue === 'bursts'
          ? bursts().map((rows) => ({ id: U(rows[0].id), rows }))
          : (await dupRows()).filter((x) => x.rows.length > 1).map(({ g, rows }) => ({ id: dupId(g), rows }));
      const groups = all.slice(off, off + limit).map(({ id, rows }) => ({
        groupId: id,
        source: 'timeWindow',
        assets: rows.map((r) => cleanupDto(r)),
        suggestedKeepId: U(largest(rows).id),
      }));
      return { items: [], groups, nextCursor: next(all.length) };
    }
    const l = listQuery(queue, q);
    if (!l) throw badRequest('Unknown queue');
    const rows = db
      .prepare(`SELECT ${COLS} ${SCOPE} AND ${NOT_KEPT} AND ${l.where} ORDER BY ${l.order} LIMIT :lim OFFSET :off`)
      .all({ ...l.args, kept: JSON.stringify(keptOf(queue)), lim: limit + 1, off });
    return { items: rows.slice(0, limit).map((r) => cleanupDto(r)), groups: [], nextCursor: next(off + rows.length) };
  });

  A.get('/cleanup/calendar', (req, _, q) => {
    const counts = new Map(
      db
        .prepare(`SELECT ${MD} AS md, count(*) AS c ${SCOPE} GROUP BY md`)
        .all()
        .map((r) => [r.md, r.c]),
    );
    const reviews = kv('cleanup.reviews');
    const days = ALL_MONTH_DAYS.map((monthDay) => ({
      monthDay,
      assetCount: counts.get(monthDay) ?? 0,
      reviewedAt: reviews[monthDay] ?? null,
    }));
    return {
      days,
      daysReviewed: days.filter((d) => d.reviewedAt && d.assetCount).length,
      streak: streak(Object.values(reviews), q.get('tz')),
    };
  });

  A.get('/cleanup/trash', () => db.q('SELECT count(*) AS count, coalesce(sum(size), 0) AS bytes FROM trash').get());

  A.get('/cleanup/rewind/:md', (req, { md }) => ({
    years: db
      .prepare(
        `SELECT CAST(strftime('%Y', m.datetaken, 'unixepoch') AS INTEGER) AS year, count(*) AS count ${SCOPE}
         AND ${MD} = :md GROUP BY year ORDER BY year DESC`,
      )
      .all({ md: Number(md) }),
  }));
  A.get('/cleanup/rewind/:md/:year', (req, { md, year }) => {
    const kept = new Set(keptOf('rewind'));
    return {
      assets: db
        .prepare(
          `SELECT ${COLS} ${SCOPE} AND ${MD} = :md AND strftime('%Y', m.datetaken, 'unixepoch') = :year
           ORDER BY m.datetaken, n.id`,
        )
        .all({ md: Number(md), year: String(year).padStart(4, '0') })
        .map((r) => cleanupDto(r, kept)),
    };
  });

  A.post('/cleanup/commit', async (req) => {
    const b = await readJson(req);
    if (typeof b.queue !== 'string') throw badRequest('queue is required');
    const uniq = (k) => [...new Set(Array.isArray(b[k]) ? b[k] : [])];
    const trashIds = uniq('trashIds');
    const others = (k) => uniq(k).filter((u) => !trashIds.includes(u));
    const skipped = [];
    const exists = db.prepare(`SELECT 1 AS ok ${SCOPE} AND n.id = ?`);
    const valid = (list) =>
      list.filter((u) => {
        const n = maybeId(u, 'asset');
        if (n != null && exists.get(n)) return true;
        if (!skipped.some((s) => s.id === u)) skipped.push({ id: u, reason: 'not_found' });
        return false;
      });
    const trashed = valid(trashIds).filter((u) => {
      try {
        lib.trash(fromUuid(u, 'asset'));
        return true;
      } catch (e) {
        skipped.push({ id: u, reason: 'not_found' });
        console.error(`cleanup: cannot trash ${u}:`, e?.message ?? e);
        return false;
      }
    });
    const fav = valid(others('favoriteIds')).map((u) => fromUuid(u, 'asset'));
    const keep = [...new Set([...fav, ...valid(others('keepIds')).map((u) => fromUuid(u, 'asset'))])];
    for (const n of fav) db.q('UPDATE nodes SET favorite = 1 WHERE id = ?').run(n);
    if (keep.length) setKept(b.queue, [...keptOf(b.queue), ...keep]);
    if (b.completeMonthDay != null)
      db.setKv(
        'cleanup.reviews',
        JSON.stringify({ ...kv('cleanup.reviews'), [b.completeMonthDay]: new Date().toISOString() }),
      );
    return { trashed, favorited: fav.length, kept: keep.length, skipped };
  });

  A.del('/cleanup/decisions', async (req) => {
    const { queue, assetIds } = await readJson(req);
    const drop = new Set(ids(assetIds));
    setKept(
      queue,
      keptOf(queue).filter((n) => !drop.has(n)),
    );
    return null;
  });

  // Gallery's shared spaces and external libraries do not exist in Frames
  A.post('/cleanup/in-spaces', () => ({ assetIds: [], externalAssetIds: [] }));
}
