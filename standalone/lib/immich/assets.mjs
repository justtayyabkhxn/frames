import { notFound, sendFile } from '../http.mjs';
import { fromUuid } from './ids.mjs';

/** Formats every browser shows natively; others (HEIC, RAW, TIFF) are served as Frames' JPEG preview. */
const WEB_IMAGES = ['image/png', 'image/webp', 'image/avif', 'image/jpeg', 'image/gif'];
const SIZES = { thumbnail: 250, preview: 1440, fullsize: 4096 };

export function registerAssets(router, ctx, A) {
  const { db } = ctx;
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
    const download = q.get('download') === 'true' ? { 'Content-Disposition': `attachment; filename="${n.name}"` } : {};
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
