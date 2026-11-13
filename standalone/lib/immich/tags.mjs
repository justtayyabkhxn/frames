import { badRequest, json, notFound, readJson } from '../http.mjs';
import { fromUuid, maybeId, toUuid } from './ids.mjs';

const EPOCH = new Date(0).toISOString();
const COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Hierarchical Immich tags on Frames' tags/tag_files tables: a tag's name is its full path ("Travel/2024"). */
export function registerTags(router, ctx, A) {
  const { db } = ctx;
  if (!db.q('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get('tags', 'color'))
    db.exec('ALTER TABLE tags ADD COLUMN color TEXT');

  const byName = (name) => db.q('SELECT * FROM tags WHERE name = ?').get(name);
  const one = (uuid) => {
    const t = db.q('SELECT * FROM tags WHERE id = ?').get(fromUuid(uuid, 'tag'));
    if (!t) throw notFound('Tag not found');
    return t;
  };
  const dto = (t) => {
    const parent = t.name.includes('/') ? byName(t.name.slice(0, t.name.lastIndexOf('/'))) : null;
    return {
      id: toUuid('tag', t.id),
      name: t.name.split('/').at(-1),
      value: t.name,
      ...(parent && { parentId: toUuid('tag', parent.id) }),
      ...(t.color && { color: t.color }),
      createdAt: EPOCH,
      updatedAt: EPOCH,
    };
  };
  const color = (c) => {
    if (c == null || c === '') return null;
    if (!COLOR.test(c)) throw badRequest('Invalid color');
    return c.startsWith('#') ? c : `#${c}`;
  };
  /** Find or create a tag by full path, creating its parents too. */
  const upsert = (value) => {
    const parts = String(value ?? '')
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) throw badRequest('Missing tag name');
    let t;
    for (let i = 1; i <= parts.length; i++) {
      const name = parts.slice(0, i).join('/');
      t = byName(name) ?? db.q('INSERT INTO tags (name) VALUES (?) RETURNING *').get(name);
    }
    return t;
  };
  const isAsset = (id) => id && db.q('SELECT 1 FROM media WHERE id = ?').get(id);
  const link = (tag, fid) => db.q('INSERT OR IGNORE INTO tag_files (tag, fileid) VALUES (?, ?)').run(tag, fid).changes;
  const bulk = (ids, fn) =>
    (Array.isArray(ids) ? ids : []).map((uuid) => {
      const fid = maybeId(uuid, 'asset');
      if (!isAsset(fid)) return { id: uuid, success: false, error: 'not_found' };
      return fn(fid) ? { id: uuid, success: true } : { id: uuid, success: false, error: fn.error };
    });

  ctx.tagsOfAsset = (fileid) =>
    db
      .q('SELECT t.* FROM tags t JOIN tag_files tf ON tf.tag = t.id WHERE tf.fileid = ? ORDER BY t.name')
      .all(fileid)
      .map(dto);

  A.get('/tags', () => db.q('SELECT * FROM tags ORDER BY name').all().map(dto));
  A.post('/tags', async (req, _, __, res) => {
    const b = await readJson(req);
    const name = String(b.name ?? '').trim();
    if (!name || name.includes('/')) throw badRequest('Invalid tag name');
    const value = b.parentId ? `${one(b.parentId).name}/${name}` : name;
    if (byName(value)) throw badRequest(`Tag already exists: ${value}`);
    const t = db.q('INSERT INTO tags (name, color) VALUES (?, ?) RETURNING *').get(value, color(b.color));
    json(res, dto(t), 201);
  });
  A.put('/tags', async (req) => {
    const { tags = [] } = await readJson(req);
    return db.tx(() => tags.map(upsert)).map(dto);
  });
  // Fixed path before /tags/:id
  A.put('/tags/assets', async (req) => {
    const { tagIds = [], assetIds = [] } = await readJson(req);
    const tags = tagIds.map((u) => one(u).id);
    const fids = assetIds.map((u) => maybeId(u, 'asset')).filter(isAsset);
    let count = 0;
    db.tx(() => tags.forEach((t) => fids.forEach((f) => (count += link(t, f)))));
    return { count };
  });
  A.get('/tags/:id', (req, { id }) => dto(one(id)));
  A.put('/tags/:id', async (req, { id }) => {
    const t = one(id);
    const b = await readJson(req);
    if (b.color !== undefined) db.q('UPDATE tags SET color = ? WHERE id = ?').run(color(b.color), t.id);
    return dto(one(id));
  });
  A.del('/tags/:id', (req, { id }, _, res) => {
    const t = one(id);
    db.q("DELETE FROM tags WHERE name = :n OR substr(name, 1, length(:n) + 1) = :n || '/'").run({ n: t.name });
    res.writeHead(204).end();
  });
  A.put('/tags/:id/assets', async (req, { id }) => {
    const t = one(id).id;
    const add = (fid) => link(t, fid) > 0;
    add.error = 'duplicate';
    return bulk((await readJson(req)).ids, add);
  });
  A.del('/tags/:id/assets', async (req, { id }) => {
    const t = one(id).id;
    const remove = (fid) => db.q('DELETE FROM tag_files WHERE tag = ? AND fileid = ?').run(t, fid).changes > 0;
    remove.error = 'not_found';
    return bulk((await readJson(req)).ids, remove);
  });
}
