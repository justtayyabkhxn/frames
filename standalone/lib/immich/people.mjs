import { badRequest, notFound, readJson, sendFile } from '../http.mjs';
import { fromUuid, maybeId, toUuid } from './ids.mjs';

const iso = (sec) => new Date((sec || 0) * 1000).toISOString();

/** People and faces for Gallery's UI, on Frames' faces/people tables (a person id is a face cluster id). */
export function registerPeople(router, ctx, A) {
  const { db } = ctx;
  const F = () =>
    ctx.faces ??
    (() => {
      throw notFound('Face recognition is not set up');
    })();

  const ROWS = `
    SELECT f.cluster AS id, p.name, coalesce(p.hidden, 0) AS hidden, coalesce(p.favorite, 0) AS favorite, p.birthdate,
      count(DISTINCT f.fileid) AS assets, count(*) AS faces
    FROM faces f JOIN media m ON m.id = f.fileid AND m.livevideo = 0 LEFT JOIN people p ON p.id = f.cluster
    WHERE f.cluster > 0`;
  const rows = (where = '', args = {}) =>
    db
      .q(`${ROWS} ${where} GROUP BY f.cluster ORDER BY hidden, favorite DESC, p.name IS NULL, assets DESC, f.cluster`)
      .all(args);
  const one = (id) => rows('AND f.cluster = :id', { id })[0] ?? fail(notFound('Person not found'));

  const dto = (r) => ({
    id: toUuid('person', r.id),
    name: r.name ?? '',
    birthDate: r.birthdate ?? null,
    isHidden: !!r.hidden,
    isFavorite: !!r.favorite,
    numberOfAssets: r.assets,
    thumbnailPath: `/people/${r.id}/thumbnail`,
    updatedAt: iso(0),
    type: 'person',
    otherPeople: [],
    sharedBy: [],
    sharedWith: [],
  });
  ctx.personDto = (id) => dto(one(id));

  /** Upsert the person row (unnamed clusters have none until something is set). */
  function setPerson(id, b) {
    db.q('INSERT INTO people (id) VALUES (?) ON CONFLICT (id) DO NOTHING').run(id);
    if (b.name !== undefined) {
      const name = String(b.name).trim() || null;
      const clash = name && db.q('SELECT id FROM people WHERE name = ? AND id <> ?').get(name, id);
      if (clash) throw badRequest(`Someone is already called ${name}; merge the two people instead`);
      db.q('UPDATE people SET name = ? WHERE id = ?').run(name, id);
    }
    if (b.isHidden !== undefined) db.q('UPDATE people SET hidden = ? WHERE id = ?').run(b.isHidden ? 1 : 0, id);
    if (b.isFavorite !== undefined) db.q('UPDATE people SET favorite = ? WHERE id = ?').run(b.isFavorite ? 1 : 0, id);
    if (b.birthDate !== undefined) db.q('UPDATE people SET birthdate = ? WHERE id = ?').run(b.birthDate || null, id);
    if (b.featureFaceAssetId) {
      const face = db
        .q('SELECT id FROM faces WHERE cluster = ? AND fileid = ?')
        .get(id, fromUuid(b.featureFaceAssetId, 'asset'));
      if (face) db.q('UPDATE people SET cover = ? WHERE id = ?').run(face.id, id);
    }
  }

  const page = (list, q) => {
    const size = Math.max(1, Number(q.get('size')) || 500);
    const start = (Math.max(1, Number(q.get('page')) || 1) - 1) * size;
    return { items: list.slice(start, start + size), hasNextPage: start + size < list.length };
  };

  A.get('/people', (req, _, q) => {
    const all = rows();
    const name = q.get('name')?.toLowerCase();
    let list = all.filter((r) => q.get('withHidden') === 'true' || !r.hidden);
    if (q.get('isFavorite') === 'true') list = list.filter((r) => r.favorite);
    if (name) list = list.filter((r) => r.name?.toLowerCase().includes(name));
    const { items, hasNextPage } = page(list, q);
    return { people: items.map(dto), total: all.length, hidden: all.filter((r) => r.hidden).length, hasNextPage };
  });
  A.get('/people/statistics', () => {
    const all = rows();
    return {
      total: all.length,
      hidden: all.filter((r) => r.hidden).length,
      detectedFaceCount: db.q('SELECT count(*) AS n FROM faces').get().n,
    };
  });
  A.get('/people/face-statistics', () => {
    const all = rows();
    const sum = (list) => list.reduce((s, r) => s + r.faces, 0);
    return {
      detectedFaceCount: db.q('SELECT count(*) AS n FROM faces').get().n,
      assignedVisibleFaceCount: sum(all.filter((r) => !r.hidden)),
      assignedHiddenFaceCount: sum(all.filter((r) => r.hidden)),
      namedVisiblePersonCount: all.filter((r) => !r.hidden && r.name).length,
      unassignedFaceCount: db.q('SELECT count(*) AS n FROM faces WHERE cluster IS NULL OR cluster <= 0').get().n,
    };
  });
  A.get('/search/person', (req, _, q) => {
    const name = (q.get('name') ?? '').toLowerCase();
    return rows()
      .filter((r) => (q.get('withHidden') === 'true' || !r.hidden) && r.name?.toLowerCase().includes(name))
      .map(dto);
  });
  A.post('/people', async (req) => {
    const b = await readJson(req);
    // Always a new person (Gallery's unmerge/side panel create empty ones); a taken name is left off
    const id = F().newPersonId();
    db.q('INSERT INTO people (id) VALUES (?)').run(id);
    const name = String(b.name ?? '').trim();
    setPerson(id, { ...b, name: name && !db.q('SELECT 1 FROM people WHERE name = ?').get(name) ? name : undefined });
    const row = db.q('SELECT * FROM people WHERE id = ?').get(id);
    return dto({
      id,
      name: row.name,
      hidden: row.hidden,
      favorite: row.favorite,
      birthdate: row.birthdate,
      assets: 0,
      faces: 0,
    });
  });
  A.put('/people', async (req) => {
    const { people = [] } = await readJson(req);
    return people.map((p) => {
      try {
        setPerson(fromUuid(p.id, 'person'), p);
        return { id: p.id, success: true };
      } catch (e) {
        return { id: p.id, success: false, error: 'unknown', errorMessage: e.message };
      }
    });
  });

  A.get('/people/:id', (req, { id }) => dto(one(fromUuid(id, 'person'))));
  A.put('/people/:id', async (req, { id }) => {
    const pid = fromUuid(id, 'person');
    setPerson(pid, await readJson(req));
    return dto(one(pid));
  });
  A.get('/people/:id/statistics', (req, { id }) => {
    const r = one(fromUuid(id, 'person'));
    return { assets: r.assets, faces: r.faces };
  });
  A.get('/people/:id/thumbnail', async (req, { id }, q, res) => {
    const pid = fromUuid(id, 'person');
    const cover = db.q('SELECT cover FROM people WHERE id = ?').get(pid)?.cover;
    const face =
      (cover && db.q('SELECT * FROM faces WHERE id = ? AND cluster = ?').get(cover, pid)) || F().bestFace(pid);
    const file = face && (await F().faceCrop(face));
    if (!file) throw notFound('No thumbnail');
    sendFile(req, res, file, { type: 'image/jpeg', cache: 'private, max-age=86400' });
  });
  A.post('/people/:id/merge', async (req, { id }) => {
    const into = fromUuid(id, 'person');
    const { ids = [] } = await readJson(req);
    const out = [];
    for (const other of ids) {
      const from = maybeId(other, 'person');
      if (!from || from === into) {
        out.push({ id: other, success: false, error: 'not_found' });
        continue;
      }
      await F().assign(F().facesOf(from), into);
      // An unnamed person takes over the merged person's name and birthday
      const old = db.q('SELECT name, birthdate FROM people WHERE id = ?').get(from);
      db.q('DELETE FROM people WHERE id = ?').run(from);
      if (old?.name || old?.birthdate) {
        db.q('INSERT INTO people (id) VALUES (?) ON CONFLICT (id) DO NOTHING').run(into);
        db.q('UPDATE people SET name = coalesce(name, ?), birthdate = coalesce(birthdate, ?) WHERE id = ?').run(
          old.name,
          old.birthdate,
          into,
        );
      }
      out.push({ id: other, success: true });
    }
    return out;
  });
  /** Move the faces of `personId` found in `assetId` to this person. */
  A.put('/people/:id/reassign', async (req, { id }) => {
    const into = fromUuid(id, 'person');
    const { data = [] } = await readJson(req);
    for (const { assetId, personId } of data) {
      const faces = db
        .q('SELECT * FROM faces WHERE fileid = ? AND cluster = ?')
        .all(fromUuid(assetId, 'asset'), fromUuid(personId, 'person'));
      await F().assign(faces, into);
    }
    return [dto(one(into))];
  });
  A.put('/people/:id/representative-face', async (req, { id }) => {
    const pid = fromUuid(id, 'person');
    const { assetFaceId } = await readJson(req);
    db.q('INSERT INTO people (id) VALUES (?) ON CONFLICT (id) DO NOTHING').run(pid);
    db.q('UPDATE people SET cover = ? WHERE id = ?').run(fromUuid(assetFaceId, 'face'), pid);
    return dto(one(pid));
  });

  const faceBox = (f, w, h) => ({
    id: toUuid('face', f.id),
    imageWidth: w,
    imageHeight: h,
    boundingBoxX1: Math.round(f.x * w),
    boundingBoxY1: Math.round(f.y * h),
    boundingBoxX2: Math.round((f.x + f.w) * w),
    boundingBoxY2: Math.round((f.y + f.h) * h),
    sourceType: 'machine-learning',
  });

  /** Faces of one asset, each with its person (Gallery's face overlay and people strip). */
  A.get('/faces', (req, _, q) => {
    const fileid = fromUuid(q.get('id'), 'asset');
    const m = db.q('SELECT w, h FROM media WHERE id = ?').get(fileid) ?? { w: 0, h: 0 };
    return db
      .q('SELECT * FROM faces WHERE fileid = ? ORDER BY x')
      .all(fileid)
      .map((f) => ({ ...faceBox(f, m.w, m.h), person: f.cluster > 0 ? ctx.personDto(f.cluster) : null }));
  });
  A.put('/faces/:id', async (req, { id }) => {
    const face = F().faceById(fromUuid(id, 'face'));
    const { id: personId } = await readJson(req);
    const into = fromUuid(personId, 'person');
    await F().assign([face], into);
    return dto(one(into));
  });
  A.del('/faces/:id', async (req, { id }) => {
    await F().assign([F().faceById(fromUuid(id, 'face'))], -1);
    return null;
  });
  A.get('/faces/:id/thumbnail', async (req, { id }, q, res) => {
    const file = await F().faceCrop(F().faceById(fromUuid(id, 'face')));
    if (!file) throw notFound('No thumbnail');
    sendFile(req, res, file, { type: 'image/jpeg', cache: 'private, max-age=86400' });
  });
  A.get('/people/:id/faces', (req, { id }, q) => {
    const pid = fromUuid(id, 'person');
    const cover = db.q('SELECT cover FROM people WHERE id = ?').get(pid)?.cover;
    const list = db
      .q(
        'SELECT f.*, m.w AS iw, m.h AS ih, m.epoch FROM faces f JOIN media m ON m.id = f.fileid WHERE f.cluster = ? ORDER BY m.datetaken DESC',
      )
      .all(pid);
    const { items, hasNextPage } = page(list, q);
    return {
      faces: items.map((f) => ({
        ...faceBox(f, f.iw, f.ih),
        assetId: toUuid('asset', f.fileid),
        fileCreatedAt: iso(f.epoch),
        isRepresentative: f.id === cover,
      })),
      hasNextPage,
    };
  });

  /* Face suggestions (near-misses for a named person) */
  A.get('/people/:id/face-suggestions', async (req, { id }, q) => {
    const all = await F().suggestions(fromUuid(id, 'person'));
    const { items } = page(all, q);
    return {
      total: all.length,
      items: items.map((f) => ({
        ...faceBox({ ...f, id: f.faceid }, f.iw, f.ih),
        id: undefined,
        assetFaceId: toUuid('face', f.faceid),
        assetId: toUuid('asset', f.fileid),
        distance: f.distance,
      })),
    };
  });
  for (const [path, action] of [
    ['confirm', 'confirm'],
    ['reject', 'reject'],
    ['dismiss', 'reject'],
    ['ignore', 'ignore'],
  ])
    A.post(`/people/:id/face-suggestions/:faceId/${path}`, async (req, { id, faceId }) => {
      await F().actOnSuggestion(fromUuid(id, 'person'), F().faceById(fromUuid(faceId, 'face')), action);
      return { acted: true };
    });
}

const fail = (e) => {
  throw e;
};
