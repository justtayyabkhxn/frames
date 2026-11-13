import { badRequest, notFound, readJson } from '../http.mjs';
import { fromUuid, maybeId, toUuid } from './ids.mjs';
import { ASSET_SELECT } from './timeline.mjs';

const iso = (sec) => (sec == null ? null : new Date(sec * 1000).toISOString());

/** Albums for Gallery's UI, on Frames' albums/album_files tables (single owner, never shared). */
export function registerAlbums(router, ctx, A) {
  const { db } = ctx;
  const now = () => Math.floor(Date.now() / 1000);
  for (const col of ["description TEXT NOT NULL DEFAULT ''", 'asset_order TEXT'])
    if (!db.q('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get('albums', col.split(' ')[0]))
      db.exec(`ALTER TABLE albums ADD COLUMN ${col}`);

  const ROWS = `
    SELECT a.*, count(m.id) AS n, min(m.datetaken) AS lo, max(m.datetaken) AS hi, max(af.added) AS last,
      coalesce((SELECT y.fileid FROM album_files y WHERE y.album = a.id AND y.fileid = a.cover),
        (SELECT x.fileid FROM album_files x JOIN media xm ON xm.id = x.fileid AND xm.livevideo = 0
          WHERE x.album = a.id ORDER BY xm.datetaken DESC LIMIT 1)) AS thumb
    FROM albums a LEFT JOIN album_files af ON af.album = a.id LEFT JOIN media m ON m.id = af.fileid AND m.livevideo = 0`;
  const rows = (where = '', args = {}) => db.q(`${ROWS} ${where} GROUP BY a.id ORDER BY a.updated DESC`).all(args);
  const one = (id) => {
    const r = rows('WHERE a.id = :id', { id })[0];
    if (!r) throw notFound('Album not found');
    return r;
  };

  const owner = () => {
    const u = ctx.immichUser();
    const keys = ['id', 'name', 'email', 'avatarColor', 'profileImagePath', 'profileChangedAt'];
    return Object.fromEntries(keys.map((k) => [k, u[k]]));
  };
  const dto = (r) => ({
    id: toUuid('album', r.id),
    albumName: r.name,
    description: r.description,
    albumThumbnailAssetId: r.thumb ? toUuid('asset', r.thumb) : null,
    // Gallery reads the owner from albumUsers[0]
    albumUsers: [{ role: 'owner', user: owner() }],
    assetCount: r.n,
    contributorCounts: [],
    createdAt: iso(r.created),
    updatedAt: iso(r.updated),
    startDate: iso(r.lo),
    endDate: iso(r.hi),
    lastModifiedAssetTimestamp: r.last ? new Date(r.last).toISOString() : null,
    hasSharedLink: false,
    isActivityEnabled: false,
    order: r.asset_order ?? 'desc',
    shared: false,
    sharedSpaceLinks: [],
  });

  const touch = (id) => db.q('UPDATE albums SET updated = ? WHERE id = ?').run(now(), id);
  const validName = (name) => {
    name = String(name ?? '').trim();
    if (name === '.' || name === '..' || /[\\/\0]/.test(name)) throw badRequest('Invalid album name');
    return name;
  };
  /** Names are unique in Frames; Gallery allows duplicates and empty names, so number them. */
  const freeName = (name) => {
    const base = validName(name) || 'Untitled';
    let out = base;
    for (let i = 2; db.q('SELECT 1 FROM albums WHERE name = ?').get(out); i++) out = `${base} (${i})`;
    return out;
  };
  const albumId = (uuid) => one(fromUuid(uuid, 'album')).id;
  const isAsset = (id) => id && db.q('SELECT 1 FROM media WHERE id = ?').get(id);
  const add = (album, fileid) =>
    db.q('INSERT OR IGNORE INTO album_files (album, fileid, added) VALUES (?, ?, ?)').run(album, fileid, Date.now())
      .changes > 0;

  /** BulkIdResponseDto[] for adding or removing asset ids. */
  const bulk = (album, ids, fn) => {
    const out = (Array.isArray(ids) ? ids : []).map((uuid) => {
      const fid = maybeId(uuid, 'asset');
      if (!isAsset(fid)) return { id: uuid, success: false, error: 'not_found' };
      const r = fn(fid);
      return r === true ? { id: uuid, success: true } : { id: uuid, success: false, error: r };
    });
    touch(album);
    return out;
  };

  // Fixed paths first: the router matches in order and /albums/:id would swallow them
  A.get('/albums', (req, _, q) => {
    if (q.get('shared') === 'true' || q.get('isShared') === 'true') return [];
    const fid = maybeId(q.get('assetId'), 'asset');
    if (q.get('assetId') && !fid) return [];
    if (!fid) return rows().map(dto);
    return rows('WHERE EXISTS (SELECT 1 FROM album_files y WHERE y.album = a.id AND y.fileid = :fid)', { fid }).map(
      dto,
    );
  });
  A.post('/albums', async (req) => {
    const b = await readJson(req);
    const t = now();
    const { id } = db
      .q('INSERT INTO albums (id, name, created, updated, description) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .get(db.nextId('albums'), freeName(b.albumName), t, t, String(b.description ?? ''));
    bulk(id, b.assetIds, (fid) => add(id, fid));
    return dto(one(id));
  });
  A.get('/albums/names', () =>
    rows().map((r) => {
      const d = dto(r);
      return {
        id: d.id,
        albumName: d.albumName,
        albumThumbnailAssetId: d.albumThumbnailAssetId,
        assetCount: d.assetCount,
        shared: false,
        startDate: d.startDate,
        endDate: d.endDate,
      };
    }),
  );
  A.get('/albums/statistics', () => {
    const n = db.q('SELECT count(*) AS n FROM albums').get().n;
    return { owned: n, shared: 0, notShared: n };
  });
  A.put('/albums/assets', async (req) => {
    const { albumIds = [], assetIds = [] } = await readJson(req);
    let added = false;
    for (const a of albumIds.map(albumId))
      added = bulk(a, assetIds, (fid) => add(a, fid)).some((r) => r.success) || added;
    return added ? { success: true } : { success: false, error: 'duplicate' };
  });
  A.post('/albums/add-targets', async (req) => {
    const { albumIds = [], assetIds = [] } = await readJson(req);
    const ids = assetIds.map((u) => maybeId(u, 'asset')).filter(isAsset);
    const albums = albumIds
      .filter((u) => maybeId(u, 'album') && db.q('SELECT 1 FROM albums WHERE id = ?').get(maybeId(u, 'album')))
      .map((albumId) => ({ albumId, acceptedAssetCount: ids.length }))
      .filter((a) => a.acceptedAssetCount > 0);
    return { albums, shareableAssetCount: ids.length };
  });

  A.get('/albums/:id', (req, { id }, q) => {
    const d = dto(one(fromUuid(id, 'album')));
    if (q.get('withoutAssets') !== 'false') return d;
    const assets = db
      .q(
        `SELECT ${ASSET_SELECT} FROM album_files af JOIN media m ON m.id = af.fileid AND m.livevideo = 0
         JOIN nodes n ON n.id = m.id WHERE af.album = ? ORDER BY m.datetaken DESC`,
      )
      .all(fromUuid(id, 'album'));
    return { ...d, assets: assets.map(ctx.assetDtoFromRow) };
  });
  A.patch('/albums/:id', async (req, { id }) => {
    const a = albumId(id);
    const b = await readJson(req);
    if (b.albumName !== undefined) {
      const name = validName(b.albumName) || 'Untitled';
      if (db.q('SELECT 1 FROM albums WHERE name = ? AND id <> ?').get(name, a))
        throw badRequest(`An album is already called ${name}`);
      db.q('UPDATE albums SET name = ? WHERE id = ?').run(name, a);
    }
    if (b.description !== undefined)
      db.q('UPDATE albums SET description = ? WHERE id = ?').run(String(b.description), a);
    if (b.order === 'asc' || b.order === 'desc') db.q('UPDATE albums SET asset_order = ? WHERE id = ?').run(b.order, a);
    if (b.albumThumbnailAssetId) {
      const fid = fromUuid(b.albumThumbnailAssetId, 'asset');
      if (!db.q('SELECT 1 FROM album_files WHERE album = ? AND fileid = ?').get(a, fid))
        throw badRequest('Asset is not in the album');
      db.q('UPDATE albums SET cover = ? WHERE id = ?').run(fid, a);
    }
    touch(a);
    return dto(one(a));
  });
  A.del('/albums/:id', (req, { id }) => {
    db.q('DELETE FROM albums WHERE id = ?').run(albumId(id));
    return null;
  });
  A.put('/albums/:id/assets', async (req, { id }) => {
    const a = albumId(id);
    return bulk(a, (await readJson(req)).ids, (fid) => add(a, fid) || 'duplicate');
  });
  A.del('/albums/:id/assets', async (req, { id }) => {
    const a = albumId(id);
    const out = bulk(
      a,
      (await readJson(req)).ids,
      (fid) => db.q('DELETE FROM album_files WHERE album = ? AND fileid = ?').run(a, fid).changes > 0 || 'not_found',
    );
    db.q(
      'UPDATE albums SET cover = NULL WHERE id = ? AND cover NOT IN (SELECT fileid FROM album_files WHERE album = ?)',
    ).run(a, a);
    return out;
  });
  A.get('/albums/:id/map-markers', (req, { id }) =>
    db
      .q(
        `SELECT m.id, m.lat, m.lon FROM album_files af JOIN media m ON m.id = af.fileid AND m.livevideo = 0
         WHERE af.album = ? AND m.lat IS NOT NULL AND m.lon IS NOT NULL`,
      )
      .all(albumId(id))
      .map((r) => {
        const place = ctx.addressOf?.(r.id) ?? [];
        return {
          id: toUuid('asset', r.id),
          lat: r.lat,
          lon: r.lon,
          city: place[0] ?? null,
          state: place.length > 2 ? place[1] : null,
          country: place.length > 1 ? place.at(-1) : null,
        };
      }),
  );

  // Sharing, album users and stacks: Frames is single-user and has no stacks
  A.get('/albums/:id/stacks/:stackId', () => {
    throw notFound('Stack not found');
  });
  A.put('/albums/:id/users', (req, { id }) => dto(one(albumId(id))));
  A.put('/albums/:id/user/:userId', () => null);
  A.del('/albums/:id/user/:userId', () => null);
}
