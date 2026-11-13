import { badRequest, contentDisposition, notFound, readJson, sendFile } from '../http.mjs';
import { fromUuid, toUuid } from './ids.mjs';
import { ASSET_SELECT, assetFilter, projectionOf, visibilityOf } from './timeline.mjs';

const iso = (sec) => (sec == null ? null : new Date(sec * 1000).toISOString());
const exposure = (t) => (t == null ? null : t >= 1 ? `${t}` : `1/${Math.round(1 / t)}`);

/** Frames row (ASSET_SELECT) -> Gallery's AssetResponseDto. */
export function assetDto(ctx, r) {
  const x = JSON.parse(r.exif || '{}');
  const place = ctx.addressOf?.(r.id) ?? [];
  const owner = ctx.immichUser();
  return {
    id: toUuid('asset', r.id),
    type: r.isvideo ? 'VIDEO' : 'IMAGE',
    checksum: Buffer.from(String(r.etag ?? '')).toString('base64'),
    deviceAssetId: String(r.id),
    deviceId: 'frames',
    ownerId: owner.id,
    owner: {
      id: owner.id,
      name: owner.name,
      email: owner.email,
      avatarColor: owner.avatarColor,
      profileImagePath: '',
      profileChangedAt: owner.profileChangedAt,
    },
    libraryId: null,
    originalFileName: r.name,
    originalPath: r.path,
    originalMimeType: r.mime,
    createdAt: iso(r.indexed_at || r.mtime),
    updatedAt: iso(r.mtime),
    fileCreatedAt: iso(r.epoch),
    fileModifiedAt: iso(r.mtime),
    localDateTime: iso(r.datetaken),
    duration: r.isvideo ? Math.round((r.video_duration || 0) * 1000) : null,
    hasMetadata: true,
    width: r.w,
    height: r.h,
    isArchived: !!r.archived,
    isEdited: false,
    isFavorite: !!r.favorite,
    isOffline: false,
    isTrashed: false,
    visibility: visibilityOf(r),
    thumbhash: null,
    livePhotoVideoId: r.livevideo_id ? toUuid('asset', r.livevideo_id) : null,
    duplicateId: null,
    stack: null,
    people: [
      ...new Set(
        (ctx.db.q('SELECT cluster FROM faces WHERE fileid = ? AND cluster > 0').all(r.id) ?? []).map((f) => f.cluster),
      ),
    ].map((c) => ({ ...ctx.personDto(c), faces: [] })),
    tags: [],
    exifInfo: {
      make: x.Make ?? null,
      model: x.Model ?? null,
      lensModel: x.LensModel ?? null,
      fNumber: x.FNumber ?? null,
      focalLength: x.FocalLength ?? null,
      iso: x.ISO ?? null,
      exposureTime: exposure(x.ExposureTime),
      exifImageWidth: r.w,
      exifImageHeight: r.h,
      fileSizeInByte: r.size ?? null,
      orientation: x.Orientation != null ? String(x.Orientation) : null,
      dateTimeOriginal: iso(r.epoch),
      modifyDate: iso(r.mtime),
      timeZone: x.OffsetTimeOriginal ? `UTC${x.OffsetTimeOriginal}` : null,
      latitude: r.lat,
      longitude: r.lon,
      city: place[0] ?? null,
      state: place.length > 2 ? place[1] : null,
      country: place.length > 1 ? place.at(-1) : null,
      description: x.Description ?? x.ImageDescription ?? '',
      rating: x.Rating ?? null,
      projectionType: projectionOf(r),
    },
  };
}

/** Formats every browser shows natively; others (HEIC, RAW, TIFF) are served as Frames' JPEG preview. */
const WEB_IMAGES = ['image/png', 'image/webp', 'image/avif', 'image/jpeg', 'image/gif'];
const SIZES = { thumbnail: 250, preview: 1440, fullsize: 4096 };

export function registerAssets(router, ctx, A) {
  const { db } = ctx;
  const row = (id) => db.q(`SELECT ${ASSET_SELECT} FROM media m JOIN nodes n ON n.id = m.id WHERE n.id = ?`).get(id);
  ctx.assetDtoFromRow = (r) => assetDto(ctx, r);
  ctx.assetDto = (id) => {
    const r = row(id);
    if (!r) throw notFound('Asset not found');
    return assetDto(ctx, r);
  };

  /** Apply Gallery's asset update fields to one Frames file. */
  async function update(id, b) {
    if (b.isFavorite !== undefined) db.q('UPDATE nodes SET favorite = ? WHERE id = ?').run(b.isFavorite ? 1 : 0, id);
    if (b.visibility === 'archive' || b.visibility === 'timeline') ctx.lib.setArchived(id, b.visibility === 'archive');
    else if (b.visibility) throw badRequest(`Visibility ${b.visibility} is not supported`);
    const raw = {};
    if (b.rating !== undefined) raw.Rating = b.rating ?? 0;
    if (b.description !== undefined) raw.Description = b.description;
    if (b.dateTimeOriginal)
      raw.AllDates = String(b.dateTimeOriginal).replace('T', ' ').replace(/[-]/g, ':').slice(0, 19);
    if (b.latitude != null && b.longitude != null)
      Object.assign(raw, {
        GPSLatitude: b.latitude,
        GPSLongitude: b.longitude,
        GPSLatitudeRef: b.latitude,
        GPSLongitudeRef: b.longitude,
      });
    if (Object.keys(raw).length) await ctx.setExif(id, raw);
  }
  const ids = (list) => (Array.isArray(list) ? list : []).map((i) => fromUuid(i, 'asset'));

  // Fixed paths first: the router matches in order and /assets/:id would swallow them
  A.get('/assets/statistics', (req, _, q) => {
    const { f, from } = assetFilter(ctx, q);
    const r = db.prepare(`SELECT sum(m.isvideo = 0) AS images, sum(m.isvideo = 1) AS videos ${from}`).get(f.args);
    return { images: r.images ?? 0, videos: r.videos ?? 0, total: (r.images ?? 0) + (r.videos ?? 0) };
  });
  A.put('/assets/favorites', async (req) => {
    const b = await readJson(req);
    for (const id of ids(b.ids)) await update(id, { isFavorite: !!b.isFavorite });
    return null;
  });
  A.get('/assets/:id', (req, { id }) => ctx.assetDto(fromUuid(id, 'asset')));
  A.put('/assets/:id', async (req, { id }) => {
    const n = fromUuid(id, 'asset');
    await update(n, await readJson(req));
    return ctx.assetDto(n);
  });
  A.put('/assets', async (req) => {
    const b = await readJson(req);
    for (const id of ids(b.ids)) await update(id, b);
    return null;
  });
  A.del('/assets', async (req) => {
    for (const id of ids((await readJson(req)).ids)) ctx.lib.trash(id);
    return null;
  });

  // Gallery features Frames does not have (yet): OCR, stacks, spaces, per-asset album list until albums land
  A.get('/assets/:id/ocr', () => []);
  A.post('/assets/spaces', () => []);
  A.get('/albums', () => []);
  const node = (id) =>
    db.q('SELECT n.*, m.isvideo FROM nodes n JOIN media m ON m.id = n.id WHERE n.id = ?').get(fromUuid(id, 'asset'));
  const mustNode = (id) => {
    const n = node(id);
    if (!n) throw notFound('Asset not found');
    return n;
  };
  const etag = (n) => ({ ETag: `"${n.etag}"` });

  A.get('/assets/:id/thumbnail', async (req, { id }, q, res) => {
    const n = mustNode(id);
    const px = SIZES[q.get('size')] ?? SIZES.thumbnail;
    const { file } = await ctx.previewFile(n.id, px, px, false);
    sendFile(req, res, file, { type: 'image/jpeg', cache: 'private, max-age=31536000', headers: etag(n) });
  });

  A.get('/assets/:id/original', async (req, { id }, q, res) => {
    const n = mustNode(id);
    const download = q.get('download') === 'true' ? { 'Content-Disposition': contentDisposition(n.name, true) } : {};
    if (n.isvideo || WEB_IMAGES.includes(n.mime) || download['Content-Disposition'])
      return sendFile(req, res, ctx.lib.abs(n.path), { type: n.mime, headers: { ...etag(n), ...download } });
    const { file } = await ctx.previewFile(n.id, SIZES.fullsize, SIZES.fullsize, false);
    sendFile(req, res, file, { type: 'image/jpeg', headers: etag(n) });
  });

  A.get('/assets/:id/video/playback', (req, { id }, q, res) => {
    const n = mustNode(id);
    sendFile(req, res, ctx.lib.abs(n.path), { type: n.mime, headers: etag(n) });
  });
}
