import { badRequest, notFound, readJson, sendFile } from '../http.mjs';
import { zipStream } from '../zip.mjs';
import { fromUuid, maybeId, toUuid } from './ids.mjs';

/** Smaller Gallery endpoints: downloads, asset jobs, usage heatmap, aliases, and clear "not in Frames" answers. */
export function registerExtras(router, ctx, A) {
  const { db } = ctx;
  const files = (ids) =>
    (Array.isArray(ids) ? ids : [])
      .map((u) =>
        db.q('SELECT id, path, name, size, mtime FROM nodes WHERE id = ? AND dir = 0').get(fromUuid(u, 'asset')),
      )
      .filter(Boolean);

  A.post('/download/info', async (req) => {
    const b = await readJson(req);
    const album = maybeId(b.albumId, 'album');
    const list = album
      ? db.q('SELECT n.id, n.size FROM album_files af JOIN nodes n ON n.id = af.fileid WHERE af.album = ?').all(album)
      : files(b.assetIds);
    const limit = Number(b.archiveSize) || 4 * 1024 ** 3;
    const archives = [];
    for (const f of list) {
      const last = archives.at(-1);
      if (!last || (last.size + f.size > limit && last.assetIds.length)) archives.push({ assetIds: [], size: 0 });
      archives.at(-1).assetIds.push(toUuid('asset', f.id));
      archives.at(-1).size += f.size;
    }
    return { totalSize: list.reduce((s, f) => s + f.size, 0), archives };
  });
  A.post('/download/archive', async (req, _, q, res) => {
    const list = files((await readJson(req)).assetIds);
    if (!list.length) throw badRequest('Nothing to download');
    const seen = new Map();
    const entries = list.map((f) => {
      const n = seen.get(f.name) ?? 0;
      seen.set(f.name, n + 1);
      const name = n ? f.name.replace(/(\.[^.]*)?$/, (ext) => ` (${n + 1})${ext}`) : f.name;
      return { name, file: ctx.lib.abs(f.path), mtime: f.mtime };
    });
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="frames-${new Date().toISOString().slice(0, 10)}.zip"`,
    });
    await zipStream(res, entries);
  });

  /** refresh-metadata / regenerate-thumbnail / refresh-faces / transcode-video all mean: index this file again. */
  A.post('/assets/jobs', async (req) => {
    for (const f of files((await readJson(req)).assetIds)) {
      ctx.previews?.remove?.(f.id);
      await ctx.indexer.indexPath(f.path);
    }
    return null;
  });
  A.post('/assets/editable', async (req) => ({
    editableAssetIds: files((await readJson(req)).assetIds).map((f) => toUuid('asset', f.id)),
  }));

  A.get('/users/me/calendar-heatmap', (req, _, q) => {
    const from = q.get('from') ?? '1970-01-01';
    const to = q.get('to') ?? '9999-12-31';
    const series = db
      .q(
        `SELECT date(m.datetaken, 'unixepoch') AS date, count(*) AS count FROM media m JOIN nodes n ON n.id = m.id
         WHERE m.livevideo = 0 AND date(m.datetaken, 'unixepoch') BETWEEN ? AND ? GROUP BY date ORDER BY date`,
      )
      .all(from.slice(0, 10), to.slice(0, 10));
    return { from, to, series, totalCount: series.reduce((s, d) => s + d.count, 0) };
  });

  A.get('/system-config', () => ctx.immichConfig());
  A.put('/system-config', async (req) => {
    db.setKv('immich.config', JSON.stringify(await readJson(req)));
    return ctx.immichConfig();
  });
  A.post('/classification/scan', () => null);
  A.get('/server/ml-health', () => ({ smartSearchHealthy: ctx.lens?.state === 'ready' }));
  A.get('/people/:id/faces/:faceId/thumbnail', async (req, { faceId }, q, res) => {
    const file = await ctx.faces?.faceCrop(ctx.faces.faceById(fromUuid(faceId, 'face')));
    if (!file) throw notFound('No thumbnail');
    sendFile(req, res, file, { type: 'image/jpeg', cache: 'private, max-age=86400' });
  });

  const unsupported = (what) => () => {
    throw badRequest(`${what} are not available in Frames`);
  };
  for (const [method, p] of [
    ['post', '/stacks'],
    ['del', '/stacks'],
    ['put', '/stacks/:id'],
    ['del', '/stacks/:id/assets/:assetId'],
  ])
    A[method](p, unsupported('Stacks'));
  A.post('/faces', unsupported('Manually drawn faces'));
}
