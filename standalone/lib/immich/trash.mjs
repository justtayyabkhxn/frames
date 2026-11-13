import { notFound, readJson, sendFile } from '../http.mjs';
import { maybeId, toUuid } from './ids.mjs';

const iso = (sec) => new Date((sec || 0) * 1000).toISOString();
const SIZES = { thumbnail: 250, preview: 1440, fullsize: 4096 };
const BUCKET = (sec) => iso(sec).slice(0, 8) + '01';

/**
 * Gallery's Bin on Frames' trash: trashed files live in <library>/.frames-trash with a `trash` row
 * (no longer in nodes/media), so they get their own id kind and are served from the trash folder.
 */
export function registerTrash(router, ctx, A) {
  const { db } = ctx;
  const rows = () =>
    db
      .q('SELECT * FROM trash ORDER BY deleted_at DESC')
      .all()
      .map((t) => ({ ...t, meta: JSON.parse(t.meta || '{}') }))
      .filter((t) => !t.meta.dir && t.mime);
  const taken = (t) => t.meta.datetaken ?? t.deleted_at;
  const one = (uuid) => {
    const id = maybeId(uuid, 'trash');
    const t = id && db.q('SELECT * FROM trash WHERE id = ?').get(id);
    if (!t) throw notFound('Not in the Bin');
    return { ...t, meta: JSON.parse(t.meta || '{}') };
  };
  const isVideo = (t) => t.mime?.startsWith('video/') || !!t.meta.isvideo;

  const dto = (t) => {
    const owner = ctx.immichUser();
    return {
      id: toUuid('trash', t.id),
      type: isVideo(t) ? 'VIDEO' : 'IMAGE',
      checksum: Buffer.from(`t${t.id}`).toString('base64'),
      deviceAssetId: `t${t.id}`,
      deviceId: 'frames',
      ownerId: owner.id,
      libraryId: null,
      originalFileName: t.name,
      originalPath: t.orig_path,
      originalMimeType: t.mime,
      createdAt: iso(t.deleted_at),
      updatedAt: iso(t.deleted_at),
      fileCreatedAt: iso(t.meta.epoch ?? taken(t)),
      fileModifiedAt: iso(t.deleted_at),
      localDateTime: iso(taken(t)),
      duration: isVideo(t) ? Math.round((t.meta.video_duration || 0) * 1000) : null,
      hasMetadata: true,
      width: t.meta.w ?? null,
      height: t.meta.h ?? null,
      isArchived: false,
      isEdited: false,
      isFavorite: !!t.meta.favorite,
      isOffline: false,
      isTrashed: true,
      visibility: 'timeline',
      thumbhash: null,
      livePhotoVideoId: null,
      duplicateId: null,
      stack: null,
      people: [],
      tags: [],
      exifInfo: { fileSizeInByte: t.size, exifImageWidth: t.meta.w ?? null, exifImageHeight: t.meta.h ?? null },
    };
  };

  /** Hooks for the shared asset and timeline routes (a trash id is not an asset id). */
  ctx.trash = {
    isTrashId: (uuid) => !!maybeId(uuid, 'trash'),
    dto: (uuid) => dto(one(uuid)),
    buckets: (q) => {
      const counts = new Map();
      for (const t of rows()) counts.set(BUCKET(taken(t)), (counts.get(BUCKET(taken(t))) ?? 0) + 1);
      const list = [...counts]
        .map(([timeBucket, count]) => ({ timeBucket, count }))
        .sort((x, y) => (x.timeBucket < y.timeBucket ? 1 : -1));
      return q.get('order') === 'asc' ? list.reverse() : list;
    },
    bucket: (q) => {
      const want = String(q.get('timeBucket')).slice(0, 10);
      const list = rows()
        .filter((t) => BUCKET(taken(t)) === want)
        .sort((x, y) => taken(y) - taken(x));
      if (q.get('order') === 'asc') list.reverse();
      const owner = ctx.immichUser().id;
      const col = (fn) => list.map(fn);
      return {
        id: col((t) => toUuid('trash', t.id)),
        ownerId: col(() => owner),
        ratio: col((t) => (t.meta.w && t.meta.h ? t.meta.w / t.meta.h : 1)),
        createdAt: col((t) => iso(t.deleted_at)),
        fileCreatedAt: col((t) => iso(t.meta.epoch ?? taken(t))),
        localOffsetHours: col((t) =>
          t.meta.epoch != null && t.meta.datetaken != null ? (t.meta.datetaken - t.meta.epoch) / 3600 : 0,
        ),
        isFavorite: col((t) => !!t.meta.favorite),
        isImage: col((t) => !isVideo(t)),
        isTrashed: col(() => true),
        duration: col((t) => (isVideo(t) ? Math.round((t.meta.video_duration || 0) * 1000) : null)),
        livePhotoVideoId: col(() => null),
        projectionType: col(() => null),
        thumbhash: col(() => null),
        visibility: col(() => 'timeline'),
        stack: col(() => null),
      };
    },
    thumbnail: async (req, uuid, size, res) => {
      const t = one(uuid);
      const src = ctx.lib.trashFile(t);
      const px = SIZES[size] ?? SIZES.thumbnail;
      const file = src && (await ctx.previews.get(`t${t.id}`, src, isVideo(t), px, px, false));
      if (!file) throw notFound('No preview');
      sendFile(req, res, file, { type: 'image/jpeg', cache: 'no-cache' });
    },
    original: (req, uuid, res) => {
      const t = one(uuid);
      const src = ctx.lib.trashFile(t);
      if (!src) throw notFound('This item is no longer in the Bin folder');
      sendFile(req, res, src, { type: t.mime });
    },
    purge: (uuid) => ctx.lib.purge(one(uuid).id),
  };

  const restore = async (ids) => {
    let count = 0;
    for (const id of ids) {
      try {
        await ctx.lib.restore(id);
        count++;
      } catch (e) {
        console.error(`Bin: cannot restore ${id}:`, e?.message ?? e);
      }
    }
    return { count };
  };
  A.post('/trash/restore', () => restore(rows().map((t) => t.id)));
  A.post('/trash/restore/assets', async (req) => {
    const { ids = [] } = await readJson(req);
    return restore(ids.map((u) => maybeId(u, 'trash')).filter(Boolean));
  });
  A.post('/trash/empty', () => {
    const all = rows();
    for (const t of all) ctx.lib.purge(t.id);
    return { count: all.length };
  });
}
