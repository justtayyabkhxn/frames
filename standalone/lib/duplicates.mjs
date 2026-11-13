import { badRequest, HttpError, json, readJson } from './http.mjs';

const API = '/apps/memories/api';
/** Cosine distance presets for the review screen (SigLIP image vectors). */
export const SENSITIVITY = { strict: 0.015, normal: 0.03, loose: 0.06 };

const exifCount = (exif) => Object.values(JSON.parse(exif || '{}')).filter((v) => v !== '' && v != null).length;

/** The copy to keep: the largest file, then the one with the most metadata (as Gallery). */
export const pickKeep = (files) =>
  [...files].sort((a, b) => b.size - a.size || b.exifCount - a.exifCount || a.fileid - b.fileid)[0].fileid;

export const groupKey = (ids) => [...ids].sort((a, b) => a - b).join(',');

const shared = new WeakMap();

/** Lens duplicate groups, dismissals and resolving, shared by Frames' and Gallery's APIs (one cache per ctx). */
export function duplicatesOf(ctx) {
  if (shared.has(ctx)) return shared.get(ctx);
  const { db, lib } = ctx;
  let cache = null; // { distance, groups, at }

  const dismissed = () => new Set(JSON.parse(db.getKv('dup.dismissed', '[]')));
  const fileRow = db.prepare(
    `SELECT n.id AS fileid, n.name AS basename, n.path, n.size, n.etag, n.mime AS mimetype, n.favorite,
       m.w, m.h, m.datetaken, m.dayid, m.exif, m.isvideo
     FROM nodes n JOIN media m ON m.id = n.id WHERE n.id = ? AND m.livevideo = 0`,
  );

  /** Groups with their current files; drops trashed files and groups that shrank below two. */
  function present(groups) {
    const skip = dismissed();
    const out = [];
    for (const ids of groups) {
      const all = ids
        .map((id) => fileRow.get(id))
        .filter(Boolean)
        .map(({ exif, ...f }) => ({ ...f, exifCount: exifCount(exif), rating: JSON.parse(exif || '{}').Rating ?? 0 }));
      // Photos and videos are only compared with their own kind
      for (const files of Map.groupBy(all, (f) => f.isvideo).values()) {
        if (files.length < 2 || skip.has(groupKey(files.map((f) => f.fileid)))) continue;
        out.push({ key: groupKey(files.map((f) => f.fileid)), files, keep: pickKeep(files) });
      }
    }
    return out;
  }

  async function scan(distance = SENSITIVITY.normal, refresh = false) {
    if (!cache || cache.distance !== distance || refresh) {
      if (ctx.lens?.state !== 'ready') throw new HttpError(503, 'AI engine is not running');
      const { groups } = await ctx.lens.get(`/v1/duplicates?max_distance=${distance}`, 15 * 60_000);
      cache = { distance, groups, at: Date.now() };
    }
    return { scannedAt: cache.at, groups: present(cache.groups) };
  }

  /** Keep some files, trash the rest; a single kept file inherits favorite, albums and tags. Returns trashed ids. */
  function resolve(keep, trash) {
    if (keep.length === 1) {
      const [k] = keep.map(Number);
      db.tx(() => {
        for (const t of trash.map(Number)) {
          if (lib.node(t)?.favorite) db.q('UPDATE nodes SET favorite = 1 WHERE id = ?').run(k);
          db.q(
            'INSERT OR IGNORE INTO album_files (album, fileid, added) SELECT album, ?, added FROM album_files WHERE fileid = ?',
          ).run(k, t);
          db.q('INSERT OR IGNORE INTO tag_files (tag, fileid) SELECT tag, ? FROM tag_files WHERE fileid = ?').run(k, t);
        }
      });
    }
    const trashed = [];
    for (const t of trash) {
      try {
        lib.trash(t);
        trashed.push(t);
      } catch (e) {
        console.error(`duplicates: cannot trash ${t}:`, e?.message ?? e);
      }
    }
    return trashed;
  }

  /** "Keep all": hide these groups until their membership changes. */
  function dismiss(keys) {
    const all = dismissed();
    for (const k of keys) all.add(String(k));
    db.setKv('dup.dismissed', JSON.stringify([...all]));
  }

  const api = { scan, resolve, dismiss };
  shared.set(ctx, api);
  return api;
}

export function registerDuplicates(router, ctx) {
  const dups = duplicatesOf(ctx);

  router.add('GET', `${API}/duplicates`, async (req, res, _, url) => {
    const p = url.searchParams;
    json(res, await dups.scan(SENSITIVITY[p.get('sensitivity')] ?? SENSITIVITY.normal, p.has('refresh')));
  });

  router.add('POST', `${API}/duplicates/resolve`, async (req, res) => {
    const { keep = [], trash = [] } = await readJson(req);
    if (!Array.isArray(keep) || !Array.isArray(trash) || !trash.length) throw badRequest('Nothing to trash');
    json(res, { trashed: dups.resolve(keep, trash).length });
  });

  router.add('POST', `${API}/duplicates/dismiss`, async (req, res) => {
    const { keys = [] } = await readJson(req);
    dups.dismiss(keys);
    json(res, { dismissed: keys.length });
  });
}
