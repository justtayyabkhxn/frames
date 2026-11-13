import fs from 'node:fs';
import path from 'node:path';
import { badRequest, notFound, readBody, sendFile } from './http.mjs';

/**
 * Export / import of everything Frames knows that is not inside the photos themselves:
 * favorites, archive marks, albums, tags, people and their faces, face decisions, locations,
 * ratings and descriptions, and settings. Exports are saved in <data>/exports (never outside Frames).
 * Files are matched by their path in the library, else by name and size, so an export also
 * works after re-indexing, on another PC, or after moving the library.
 */
const FORMAT = 'frames-export';
const VERSION = 1;
const SETTINGS = /^(user\.|immich\.(config|prefs)$)/;

const iou = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const i = w > 0 && h > 0 ? w * h : 0;
  return i / (a.w * a.h + b.w * b.h - i || 1);
};
const box = (f) => ({ x: f.x, y: f.y, w: f.w, h: f.h });

export function exportData(ctx) {
  const { db } = ctx;
  const pathOf = new Map(
    db
      .q('SELECT id, path FROM nodes WHERE dir = 0')
      .all()
      .map((r) => [r.id, r.path]),
  );
  const files = db
    .q(
      `SELECT n.id, n.path, n.size, n.favorite, n.archived, m.lat, m.lon, m.exif FROM nodes n JOIN media m ON m.id = n.id
       WHERE n.dir = 0 ORDER BY n.path`,
    )
    .all()
    .map((r) => {
      const x = JSON.parse(r.exif || '{}');
      return {
        path: r.path,
        size: r.size,
        ...(r.favorite && { favorite: true }),
        ...(r.archived && { archived: true }),
        ...(r.lat != null && { lat: r.lat, lon: r.lon }),
        ...(x.Rating && { rating: x.Rating }),
        ...(x.Description && { description: x.Description }),
      };
    });
  const col = (table, name) => !!db.q('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, name);
  const albums = db
    .q('SELECT * FROM albums ORDER BY id')
    .all()
    .map((a) => ({
      name: a.name,
      ...(col('albums', 'description') && a.description && { description: a.description }),
      ...(col('albums', 'asset_order') && a.asset_order && { order: a.asset_order }),
      location: a.location || undefined,
      created: a.created,
      cover: pathOf.get(a.cover),
      files: db
        .q('SELECT fileid FROM album_files WHERE album = ? ORDER BY added')
        .all(a.id)
        .map((f) => pathOf.get(f.fileid))
        .filter(Boolean),
    }));
  const tags = db
    .q('SELECT * FROM tags ORDER BY name')
    .all()
    .map((t) => ({
      name: t.name,
      ...(col('tags', 'color') && t.color && { color: t.color }),
      files: db
        .q('SELECT fileid FROM tag_files WHERE tag = ?')
        .all(t.id)
        .map((f) => pathOf.get(f.fileid))
        .filter(Boolean),
    }));
  const hasFaces = !!db.q("SELECT 1 FROM sqlite_master WHERE name = 'faces'").get();
  const faceRow = (id) => (id ? db.q('SELECT * FROM faces WHERE id = ?').get(id) : null);
  const people = hasFaces
    ? db
        .q('SELECT * FROM people ORDER BY id')
        .all()
        .map((p) => {
          const cover = faceRow(p.cover);
          return {
            id: p.id,
            name: p.name ?? '',
            ...(p.hidden && { hidden: true }),
            ...(p.favorite && { favorite: true }),
            ...(p.birthdate && { birthdate: p.birthdate }),
            ...(cover && pathOf.get(cover.fileid) && { cover: { path: pathOf.get(cover.fileid), ...box(cover) } }),
          };
        })
    : [];
  // Every face that belongs to someone, named or not, so the groups come back as they were
  const faces = hasFaces
    ? db
        .q('SELECT * FROM faces WHERE cluster > 0')
        .all()
        .filter((f) => pathOf.get(f.fileid))
        .map((f) => ({ path: pathOf.get(f.fileid), ...box(f), person: f.cluster }))
    : [];
  const decisions = hasFaces
    ? db
        .q('SELECT f.*, v.status, v.cluster AS verdict_person FROM face_verdicts v JOIN faces f ON f.point = v.point')
        .all()
        .filter((f) => pathOf.get(f.fileid))
        .map((f) => ({ path: pathOf.get(f.fileid), ...box(f), person: f.verdict_person, status: f.status }))
    : [];
  const settings = Object.fromEntries(
    db
      .q('SELECT key, value FROM kv')
      .all()
      .filter((r) => SETTINGS.test(r.key))
      .map((r) => [r.key, r.value]),
  );
  return {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    library: path.basename(ctx.root),
    counts: {
      files: files.length,
      albums: albums.length,
      tags: tags.length,
      people: people.length,
      faces: faces.length,
    },
    files,
    albums,
    tags,
    people,
    faces,
    decisions,
    settings,
  };
}

/** Apply an export to this library. Never deletes anything; existing albums/tags/people are merged by name. */
export async function importData(ctx, data) {
  if (data?.format !== FORMAT || typeof data.version !== 'number') throw badRequest('This is not a Frames export');
  if (data.version > VERSION) throw badRequest('This export was made by a newer Frames; update Frames first');
  const { db } = ctx;
  const byPath = new Map(
    db
      .q('SELECT id, path FROM nodes WHERE dir = 0')
      .all()
      .map((r) => [r.path, r.id]),
  );
  const byNameSize = new Map();
  for (const r of db.q('SELECT id, name, size FROM nodes WHERE dir = 0').all()) {
    const k = `${r.name}\0${r.size}`;
    byNameSize.set(k, byNameSize.has(k) ? null : r.id); // ambiguous names are not guessed
  }
  const sizeOf = new Map((data.files ?? []).map((f) => [f.path, f.size]));
  const idOf = (p) => {
    if (!p) return null;
    if (byPath.has(p)) return byPath.get(p);
    const size = sizeOf.get(p);
    return size == null ? null : (byNameSize.get(`${p.split('/').pop()}\0${size}`) ?? null);
  };
  const out = { files: 0, missing: 0, albums: 0, tags: 0, people: 0, faces: 0, exif: 0, settings: 0 };
  const exif = [];

  db.tx(() => {
    for (const f of data.files ?? []) {
      const id = idOf(f.path);
      if (!id) {
        out.missing++;
        continue;
      }
      out.files++;
      if (f.favorite) db.q('UPDATE nodes SET favorite = 1 WHERE id = ?').run(id);
      if (f.archived) db.q('UPDATE nodes SET archived = 1 WHERE id = ?').run(id);
      const m = db.q('SELECT lat, exif FROM media WHERE id = ?').get(id);
      const x = JSON.parse(m?.exif || '{}');
      const raw = {};
      if (f.lat != null && m?.lat == null)
        Object.assign(raw, { GPSLatitude: f.lat, GPSLongitude: f.lon, GPSLatitudeRef: f.lat, GPSLongitudeRef: f.lon });
      if (f.rating && !x.Rating) raw.Rating = f.rating;
      if (f.description && !x.Description) raw.Description = f.description;
      if (Object.keys(raw).length) exif.push([id, raw]);
    }

    const now = Math.floor(Date.now() / 1000);
    for (const a of data.albums ?? []) {
      const album =
        db.q('SELECT id FROM albums WHERE name = ?').get(a.name)?.id ??
        db
          .q('INSERT INTO albums (id, name, created, updated, location) VALUES (?, ?, ?, ?, ?) RETURNING id')
          .get(db.nextId('albums'), a.name, a.created ?? now, now, a.location ?? '').id;
      if (a.description) db.q('UPDATE albums SET description = ? WHERE id = ?').run(a.description, album);
      if (a.order) db.q('UPDATE albums SET asset_order = ? WHERE id = ?').run(a.order, album);
      for (const p of a.files ?? []) {
        const id = idOf(p);
        if (id) db.q('INSERT OR IGNORE INTO album_files (album, fileid, added) VALUES (?, ?, ?)').run(album, id, now);
      }
      const cover = idOf(a.cover);
      if (cover) db.q('UPDATE albums SET cover = ? WHERE id = ?').run(cover, album);
      out.albums++;
    }

    for (const t of data.tags ?? []) {
      const tag =
        db.q('SELECT id FROM tags WHERE name = ?').get(t.name)?.id ??
        db.q('INSERT INTO tags (id, name) VALUES (?, ?) RETURNING id').get(db.nextId('tags'), t.name).id;
      if (t.color) db.q('UPDATE tags SET color = ? WHERE id = ?').run(t.color, tag);
      for (const p of t.files ?? []) {
        const id = idOf(p);
        if (id) db.q('INSERT OR IGNORE INTO tag_files (tag, fileid) VALUES (?, ?)').run(tag, id);
      }
      out.tags++;
    }

    // People keep their ids (so faces point at them); a name already used here wins and absorbs them
    const personId = new Map();
    for (const p of data.people ?? []) {
      const named = p.name && db.q('SELECT id FROM people WHERE name = ?').get(p.name)?.id;
      const taken = db.q('SELECT name FROM people WHERE id = ?').get(p.id)?.name;
      const id = named ?? (taken && taken !== p.name ? ctx.faces.newPersonId() : p.id);
      personId.set(p.id, id);
      db.q('INSERT INTO people (id, name) VALUES (?, ?) ON CONFLICT (id) DO NOTHING').run(id, p.name || null);
      if (p.name) db.q('UPDATE people SET name = ? WHERE id = ? AND name IS NULL').run(p.name, id);
      db.q('UPDATE people SET hidden = ?, favorite = ?, birthdate = ? WHERE id = ?').run(
        p.hidden ? 1 : 0,
        p.favorite ? 1 : 0,
        p.birthdate ?? null,
        id,
      );
      out.people++;
    }
    const pending = db.q('INSERT INTO face_imports (fileid, person, x, y, w, h, status) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const f of data.faces ?? []) {
      const id = idOf(f.path);
      if (id) (pending.run(id, personId.get(f.person) ?? f.person, f.x, f.y, f.w, f.h, null), out.faces++);
    }
    for (const f of data.decisions ?? []) {
      const id = idOf(f.path);
      if (id) pending.run(id, personId.get(f.person) ?? f.person, f.x, f.y, f.w, f.h, f.status);
    }
    for (const p of data.people ?? [])
      if (p.cover) {
        const id = idOf(p.cover.path);
        if (id) pending.run(id, personId.get(p.id) ?? p.id, p.cover.x, p.cover.y, p.cover.w, p.cover.h, 'cover');
      }

    for (const [k, v] of Object.entries(data.settings ?? {})) if (SETTINGS.test(k)) (db.setKv(k, v), out.settings++);
  });

  // Locations, ratings and descriptions live in the files; only fill in what a file is missing
  for (const [id, raw] of exif) {
    try {
      await ctx.setExif?.(id, raw);
      out.exif++;
    } catch (e) {
      console.error(`Import: could not write metadata to file ${id}:`, e?.message ?? e);
    }
  }
  await applyFaceImports(ctx);
  return out;
}

/**
 * Imported faces are matched to the faces Frames detected in the same photo (same box), so they
 * apply now when the photo is already scanned, or later right after the AI engine scans it.
 */
export async function applyFaceImports(ctx) {
  const { db } = ctx;
  if (!ctx.faces || !db.q('SELECT 1 FROM face_imports LIMIT 1').get()) return 0;
  let applied = 0;
  const rows = db.q('SELECT rowid, * FROM face_imports').all();
  const byFile = Map.groupBy(rows, (r) => r.fileid);
  for (const [fileid, list] of byFile) {
    const faces = db.q('SELECT * FROM faces WHERE fileid = ?').all(fileid);
    if (!faces.length) continue; // not scanned yet
    for (const r of list) {
      const face = faces.reduce((best, f) => (iou(f, r) > (best ? iou(best, r) : 0.5) ? f : best), null);
      if (face) {
        if (!r.status) await ctx.faces.assign([face], r.person);
        else if (r.status === 'cover') db.q('UPDATE people SET cover = ? WHERE id = ?').run(face.id, r.person);
        else
          db.q('INSERT OR REPLACE INTO face_verdicts (point, cluster, status) VALUES (?, ?, ?)').run(
            face.point,
            r.person,
            r.status,
          );
        applied++;
      }
      db.q('DELETE FROM face_imports WHERE rowid = ?').run(r.rowid);
    }
  }
  return applied;
}

export function registerBackup(router, ctx, A) {
  const { db } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS face_imports (
    fileid INTEGER NOT NULL REFERENCES nodes (id) ON DELETE CASCADE, person INTEGER NOT NULL,
    x REAL, y REAL, w REAL, h REAL, status TEXT)`);
  ctx.applyFaceImports = () => applyFaceImports(ctx);
  const dir = () => path.join(ctx.dataDir, 'exports');
  const safe = (name) => {
    if (!/^frames-export-[\w.-]+\.json$/.test(name ?? '')) throw badRequest('Not an export file');
    return path.join(dir(), name);
  };
  const list = () =>
    fs.existsSync(dir())
      ? fs
          .readdirSync(dir())
          .filter((f) => /^frames-export-[\w.-]+\.json$/.test(f))
          .map((name) => {
            const s = fs.statSync(path.join(dir(), name));
            return { name, size: s.size, createdAt: s.mtime.toISOString() };
          })
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      : [];

  A.get('/frames/exports', list);
  A.post('/frames/export', () => {
    const data = exportData(ctx);
    fs.mkdirSync(dir(), { recursive: true });
    const name = `frames-export-${data.createdAt.slice(0, 19).replace(/[:T]/g, '-')}.json`;
    fs.writeFileSync(path.join(dir(), name), JSON.stringify(data));
    return { name, counts: data.counts };
  });
  A.get('/frames/exports/:name', (req, { name }, q, res) => {
    const file = safe(name);
    if (!fs.existsSync(file)) throw notFound('Export not found');
    sendFile(req, res, file, {
      type: 'application/json',
      headers: { 'Content-Disposition': `attachment; filename="${name}"` },
    });
  });
  A.del('/frames/exports/:name', (req, { name }) => (fs.rmSync(safe(name), { force: true }), null));
  /** Import a saved export by name, or an uploaded export file (JSON body). */
  A.post('/frames/import', async (req, _, q) => {
    const name = q.get('name');
    const text = name ? fs.readFileSync(safe(name), 'utf8') : (await readBody(req, 512 * 1024 * 1024)).toString('utf8');
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw badRequest('This file is not a Frames export');
    }
    return importData(ctx, data);
  });
}
