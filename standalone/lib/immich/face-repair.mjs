import { randomUUID } from 'node:crypto';
import { badRequest, notFound, readJson, sendFile } from '../http.mjs';
import { fromUuid, maybeId, toUuid } from './ids.mjs';

const DEFAULTS = { maxDistance: 0.5, minFaces: 3, maxFlaggedFraction: 0.5, largeClusterThreshold: 50 };
const KV = 'faceRepair.scan';
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS face_repair_resolutions (
    id TEXT PRIMARY KEY, point TEXT, cluster INTEGER NOT NULL, status TEXT NOT NULL, owners TEXT,
    created INTEGER NOT NULL, UNIQUE (point, cluster)
  );`;
const iso = (sec) => new Date(sec * 1000).toISOString();
const countBy = (list, key) => list.reduce((m, x) => m.set(key(x), (m.get(key(x)) ?? 0) + 1), new Map());

/**
 * Gallery's admin Face cleanup ("face-repair") on Frames: the scan is lens' audit (ctx.faces.audit), kept as one
 * snapshot in kv and read live; keep/lock are 'stay' verdicts, dismissals are cluster mutes, both logged as resolutions.
 */
export function registerFaceRepair(router, ctx, A) {
  const { db } = ctx;
  db.exec(SCHEMA);
  const F = () => ctx.faces ?? fail(notFound('Face recognition is not set up'));
  const owner = toUuid('user', 1);
  const faceUuid = (id) => toUuid('face', id);
  const now = () => Math.floor(Date.now() / 1000);

  const FACE = 'SELECT f.*, m.w AS iw, m.h AS ih, m.datetaken FROM faces f JOIN media m ON m.id = f.fileid';
  const photo = (f) => ({
    localDateTime: iso(f.datetaken ?? 0),
    boundingBoxX1: Math.round(f.x * f.iw),
    boundingBoxY1: Math.round(f.y * f.ih),
    boundingBoxX2: Math.round((f.x + f.w) * f.iw),
    boundingBoxY2: Math.round((f.y + f.h) * f.ih),
    imageWidth: f.iw,
    imageHeight: f.ih,
  });
  const faceCount = (cluster) => db.q('SELECT count(*) AS n FROM faces WHERE cluster = ?').get(cluster).n;
  const name = (cluster) => db.q('SELECT name FROM people WHERE id = ?').get(cluster)?.name || null;
  const thumb = (cluster) => {
    const cover = db.q('SELECT cover FROM people WHERE id = ?').get(cluster)?.cover;
    const f =
      (cover && db.q('SELECT id FROM faces WHERE id = ? AND cluster = ?').get(cover, cluster)) || F().bestFace(cluster);
    return f ? faceUuid(f.id) : null;
  };
  const faceOf = (uuid) => db.q('SELECT * FROM faces WHERE id = ?').get(maybeId(uuid, 'face') ?? 0);

  /* ---------------- verdicts and resolutions ---------------- */
  const record = (point, cluster, status, owners = null) =>
    db
      .q(
        `INSERT OR REPLACE INTO face_repair_resolutions (id, point, cluster, status, owners, created)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), point, cluster, status, owners && JSON.stringify(owners), now());
  /** Keep a face out of later scans ('stay' = keep here, 'locked' = confirmed for good). */
  const keep = (f, cluster, status) => {
    db.q("INSERT OR REPLACE INTO face_verdicts (point, cluster, status) VALUES (?, ?, 'stay')").run(f.point, cluster);
    record(f.point, cluster, status);
  };
  const mutes = () => {
    const out = new Map();
    for (const r of db.q("SELECT cluster, owners FROM face_repair_resolutions WHERE status = 'muted'").all())
      out.set(r.cluster, new Set([...(out.get(r.cluster) ?? []), ...JSON.parse(r.owners)]));
    return out;
  };

  /* ---------------- scan ---------------- */
  const saved = () => JSON.parse(db.getKv(KV, 'null'));

  async function scan(params) {
    const p = { ...DEFAULTS, ...params };
    const base = { id: randomUUID(), createdAt: iso(now()), params: p, flagged: [], eligible: {}, overCap: [] };
    try {
      const flagged = (await F().audit()).map((it) => ({
        face: it.face.id,
        cluster: it.face.cluster,
        owner: it.suspected,
      }));
      const eligible = Object.fromEntries(
        db
          .q('SELECT cluster, count(*) AS n FROM faces WHERE cluster > 0 GROUP BY cluster')
          .all()
          .map((r) => [r.cluster, r.n]),
      );
      const perPerson = countBy(flagged, (f) => f.cluster);
      const overCap = [...perPerson].filter(([c, n]) => n / eligible[c] > p.maxFlaggedFraction).map(([c]) => c);
      const over = (c) => overCap.includes(c);
      const badTarget = flagged.filter((f) => !over(f.cluster) && over(f.owner)).length;
      const overFaces = flagged.filter((f) => over(f.cluster)).length;
      const totals = {
        eligibleFaces: Object.values(eligible).reduce((a, b) => a + b, 0),
        flaggedFaces: flagged.length,
        toRepair: flagged.length - overFaces - badTarget,
        reviewOnlyFaces: overFaces + badTarget,
        reviewOnlyPersons: overCap.length,
        affectedPersons: perPerson.size,
        reviewOnlyByReason: { overCap: overFaces, badTarget, unAttributable: 0 },
      };
      Object.assign(base, { status: 'completed', error: null, flagged, eligible, overCap, totals });
    } catch (e) {
      Object.assign(base, { status: 'failed', error: String(e?.message ?? e), totals: null });
    }
    db.setKv(KV, JSON.stringify(base));
    return base.id;
  }

  /** The snapshot's flagged faces still standing: not moved since, not kept, not in a dismissed cluster. */
  function live(s) {
    const stayed = new Set(
      db
        .q("SELECT point FROM face_verdicts WHERE status = 'stay'")
        .all()
        .map((r) => r.point),
    );
    const byId = db.q(`${FACE} WHERE f.id = ?`);
    const rows = s.flagged
      .map((x) => ({ ...x, row: byId.get(x.face) }))
      .filter((x) => x.row?.cluster === x.cluster && !stayed.has(x.row.point));
    const muted = mutes();
    return new Map(
      [...Map.groupBy(rows, (x) => x.cluster)].filter(([c, list]) => !list.every((x) => muted.get(c)?.has(x.owner))),
    );
  }

  function personOut(s, cluster, list) {
    const owners = countBy(list, (x) => x.owner);
    const personName = name(cluster);
    const count = faceCount(cluster);
    const over = (c) => s.overCap.includes(c);
    const reasons = [
      over(cluster) && 'over-cap',
      personName && 'named',
      count > s.params.largeClusterThreshold && 'large-cluster',
      owners.size > 1 && 'multiple-owners',
      [...owners.keys()].some(over) && 'bad-target',
    ].filter(Boolean);
    const eligible = s.eligible[cluster] ?? count;
    return {
      personId: toUuid('person', cluster),
      ownerId: owner,
      personName,
      faceCount: count,
      thumbnailFaceId: thumb(cluster),
      eligible,
      flagged: list.length,
      flaggedFraction: eligible ? list.length / eligible : 0,
      suspectedOwners: [...owners].map(([o, n]) => {
        const ownerFaceCount = faceCount(o);
        return {
          ownerPersonId: toUuid('person', o),
          ownerName: name(o),
          thumbnailFaceId: thumb(o),
          count: n,
          ownerFaceCount,
          ownerMissing: !ownerFaceCount && !db.q('SELECT 1 FROM people WHERE id = ?').get(o),
        };
      }),
      recommendation: reasons.length ? 'review-first' : 'confident',
      reviewReasons: reasons,
    };
  }

  A.get('/admin/face-repair/scan/defaults', () => {
    const { maxDistance, minFaces, maxFlaggedFraction } = DEFAULTS;
    return { maxDistance, minFaces, maxFlaggedFraction };
  });
  A.post('/admin/face-repair/scan', async (req) => ({ scanId: await scan((await readJson(req)).params) }));
  A.get('/admin/face-repair/scan/latest', () => {
    const s = saved();
    if (!s) return null;
    const persons = [...live(s)].map(([c, list]) => personOut(s, c, list)).sort((a, b) => b.flagged - a.flagged);
    const total = s.totals?.eligibleFaces ?? 0;
    return {
      ...{ id: s.id, status: s.status, error: s.error, totals: s.totals, persons },
      progress: s.totals ? { scanned: total, total } : null,
      ...{ startedAt: s.createdAt, finishedAt: s.createdAt, createdAt: s.createdAt },
    };
  });
  A.get('/admin/face-repair/scan/person/:personId', (req, { personId }) => {
    const s = saved();
    const list = (s && live(s).get(fromUuid(personId, 'person'))) ?? [];
    return {
      personId,
      flaggedFaces: list.map((x) => ({
        assetFaceId: faceUuid(x.face),
        suspectedOwnerId: toUuid('person', x.owner),
        ...photo(x.row),
      })),
    };
  });
  A.post('/admin/face-repair/scan/person/:personId/cluster-faces', async (req, { personId }) => {
    const { excludeFaceIds = [], page = 0, size = 50 } = await readJson(req);
    const skip = new Set(excludeFaceIds.map((id) => maybeId(id, 'face')));
    const all = db
      .q(`${FACE} WHERE f.cluster = ? ORDER BY m.datetaken DESC, f.id`)
      .all(fromUuid(personId, 'person'))
      .filter((f) => !skip.has(f.id));
    const start = page * size;
    return {
      faces: all.slice(start, start + size).map((f) => ({ assetFaceId: faceUuid(f.id), ...photo(f) })),
      total: all.length,
      hasMore: start + size < all.length,
    };
  });

  /* ---------------- people ---------------- */
  A.get('/admin/face-repair/person/:personId', (req, { personId }) => {
    const id = fromUuid(personId, 'person');
    const count = faceCount(id);
    if (!count && !db.q('SELECT 1 FROM people WHERE id = ?').get(id)) throw notFound('Person not found');
    return { id: personId, name: name(id) ?? '', ownerId: owner, faceCount: count, thumbnailFaceId: thumb(id) };
  });
  A.get('/admin/face-repair/owner/:ownerId/people', (req, _, q) => {
    const query = q.get('query')?.trim().toLowerCase();
    const page = Math.max(0, Number(q.get('page')) || 0);
    const all = db
      .q(
        `SELECT c.id, p.name, count(f.id) AS faces
         FROM (SELECT cluster AS id FROM faces WHERE cluster > 0 UNION SELECT id FROM people) c
         LEFT JOIN people p ON p.id = c.id LEFT JOIN faces f ON f.cluster = c.id
         GROUP BY c.id ORDER BY p.name IS NULL, faces DESC, p.name`,
      )
      .all()
      .filter((r) => !query || r.name?.toLowerCase().includes(query));
    const size = 50;
    return {
      people: all.slice(page * size, (page + 1) * size).map((r) => ({
        id: toUuid('person', r.id),
        name: r.name ?? '',
        faceCount: r.faces,
        thumbnailFaceId: thumb(r.id),
      })),
      total: all.length,
      hasMore: (page + 1) * size < all.length,
    };
  });
  A.post('/admin/face-repair/owner/:ownerId/people', async (req) => {
    const n = String((await readJson(req)).name ?? '').trim();
    if (!n) throw badRequest('Name is required');
    return { id: toUuid('person', F().ensurePerson(n)) };
  });

  /* ---------------- face images ---------------- */
  const mustFace = (id) => F().faceById(fromUuid(id, 'face'));
  A.get('/admin/face-repair/faces/:id/thumbnail', async (req, { id }, q, res) => {
    const file = await F().faceCrop(mustFace(id));
    if (!file) throw notFound('No thumbnail');
    sendFile(req, res, file, { type: 'image/jpeg', cache: 'private, max-age=86400' });
  });
  A.get('/admin/face-repair/faces/:id/preview', async (req, { id }, q, res) => {
    const { file } = (await ctx.previewFile?.(mustFace(id).fileid, 1440, 1440, false)) ?? {};
    if (!file) throw notFound('No preview');
    sendFile(req, res, file, { type: 'image/jpeg', cache: 'private, max-age=86400' });
  });

  /* ---------------- resolve ---------------- */
  A.post('/admin/face-repair/resolve', async (req) => {
    const b = await readJson(req);
    const cluster = fromUuid(b.personId, 'person');
    const { moveToPerson = [], stay = [], lock = [], detach = [], unknown = [], entireCluster } = b;
    const ids = [...moveToPerson.flatMap((g) => g.faceIds ?? []), ...stay, ...lock, ...detach, ...unknown];
    if (entireCluster && ids.length)
      throw badRequest('entireCluster cannot be combined with per-face resolution buckets');
    if (!entireCluster && !ids.length) throw badRequest('Resolve request has no faces to act on');
    if (new Set(ids).size !== ids.length)
      throw badRequest('A face cannot be resolved more than one way in the same request');
    const out = { moved: 0, declined: 0, locked: 0, detached: 0, unknown: 0, skipped: 0 };

    if (entireCluster) {
      const all = F().facesOf(cluster);
      await F().assign(all, fromUuid(entireCluster.destinationPersonId, 'person'));
      if (!name(cluster)) db.q('DELETE FROM people WHERE id = ?').run(cluster);
      return { ...out, moved: all.length };
    }
    /** This person's faces among `list`; the rest are counted as skipped. */
    const mine = (list) => {
      const faces = list.map(faceOf).filter((f) => f?.cluster === cluster);
      out.skipped += list.length - faces.length;
      return faces;
    };
    for (const g of moveToPerson) {
      const to = fromUuid(g.destinationPersonId, 'person');
      const faces = mine(g.faceIds ?? []);
      await F().assign(faces, to);
      if (g.lock) faces.forEach((f) => keep(f, to, 'locked'));
      out.moved += faces.length;
    }
    for (const f of mine(stay)) (keep(f, cluster, 'stay'), out.declined++);
    for (const f of mine(lock)) (keep(f, cluster, 'locked'), out.locked++);
    const gone = mine(detach);
    await F().assign(gone, -1);
    out.detached = gone.length;
    const parked = mine(unknown);
    if (parked.length) {
      const fresh = F().newPersonId();
      await F().assign(parked, fresh);
      parked.forEach((f) => keep(f, fresh, 'locked'));
      out.unknown = parked.length;
    }
    return out;
  });

  A.post('/admin/face-repair/decline', async (req) => {
    const { faces = [], persons = [] } = await readJson(req);
    let created = 0;
    for (const { assetFaceId } of faces) {
      const f = faceOf(assetFaceId);
      if (f) (keep(f, f.cluster ?? 0, 'stay'), created++);
    }
    for (const p of persons) {
      record(
        null,
        fromUuid(p.personId, 'person'),
        'muted',
        (p.suspectedOwnerIds ?? []).map((o) => fromUuid(o, 'person')),
      );
      created++;
    }
    return { created };
  });

  /* ---------------- resolutions ---------------- */
  const RESOLUTIONS = `FROM face_repair_resolutions r JOIN faces f ON f.point = r.point WHERE r.status <> 'muted'`;
  A.get('/admin/face-repair/resolutions', (req, _, q) => {
    const size = Math.min(200, Math.max(1, Number(q.get('size')) || 50));
    const page = Math.max(1, Number(q.get('page')) || 1);
    const rows = db
      .q(`SELECT r.*, f.id AS faceid ${RESOLUTIONS} ORDER BY r.created DESC, r.rowid DESC LIMIT ? OFFSET ?`)
      .all(size, (page - 1) * size);
    return {
      total: db.q(`SELECT count(*) AS n ${RESOLUTIONS}`).get().n,
      resolutions: rows.map((r) => ({
        id: r.id,
        assetFaceId: faceUuid(r.faceid),
        status: r.status,
        source: 'cleanup',
        personId: r.cluster > 0 ? toUuid('person', r.cluster) : null,
        personName: name(r.cluster),
        personThumbnailFaceId: r.cluster > 0 ? thumb(r.cluster) : null,
        ...{ spacePersonId: null, spacePersonName: null, spacePersonThumbnailFaceId: null, spaceName: null },
        actorId: owner,
        actorName: ctx.displayName || null,
        createdAt: iso(r.created),
      })),
    };
  });
  A.post('/admin/face-repair/resolutions/remove', async (req) => {
    const { verdictIds = [], clusterMuteIds = [] } = await readJson(req);
    let removed = 0;
    db.tx(() => {
      for (const id of [...verdictIds, ...clusterMuteIds]) {
        const r = db.q('DELETE FROM face_repair_resolutions WHERE id = ? RETURNING point, cluster').get(id);
        if (!r) continue;
        removed++;
        if (r.point)
          db.q("DELETE FROM face_verdicts WHERE point = ? AND cluster = ? AND status = 'stay'").run(r.point, r.cluster);
      }
    });
    return { removed };
  });
}

const fail = (e) => {
  throw e;
};
