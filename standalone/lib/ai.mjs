import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LensDaemon, PINS } from './ai-lens.mjs';
import { DAV, destination, sendMultistatus } from './dav.mjs';
import { badRequest, HttpError, json, notFound, readBody, readJson, sendFile } from './http.mjs';
import { ARCHIVE } from './indexer.mjs';
import { run } from './tools.mjs';

const API = '/apps/memories/api';
const LENS = '/index.php/apps/memories/lens';
/** Faces the user removed from a person; lens never auto-clusters them again. */
const REJECTED = -1;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS faces (
    id INTEGER PRIMARY KEY,             -- stable faceid for the web UI
    point TEXT UNIQUE NOT NULL,         -- lens point id
    fileid INTEGER NOT NULL,
    cluster INTEGER,                    -- person id; NULL/-1 = unassigned
    x REAL, y REAL, w REAL, h REAL,     -- fractions of the image
    score REAL,
    gen INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS faces_fileid ON faces (fileid);
  CREATE INDEX IF NOT EXISTS faces_cluster ON faces (cluster);
  CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY, name TEXT UNIQUE, cover INTEGER);
  -- Review decisions: 'rejected'/'ignored' hide a suggestion for that person, 'stay' keeps a face out of cleanup
  CREATE TABLE IF NOT EXISTS face_verdicts (
    point TEXT NOT NULL, cluster INTEGER NOT NULL, status TEXT NOT NULL, PRIMARY KEY (point, cluster)
  );
  -- A deleted file's faces must never attach to whatever file is indexed next
  CREATE TRIGGER IF NOT EXISTS faces_node_deleted AFTER DELETE ON nodes BEGIN
    DELETE FROM faces WHERE fileid = old.id;
  END;
`;

/** New person id; same range as lens cluster ids (positive, exact in JS). */
const newPersonId = () => randomInt(1, 2 ** 48);

/** ffmpeg filter for a square face crop with 50% margin, clamped to the image. */
export function faceCropFilter({ x, y, w, h }, size = 256) {
  const f = (v) => Math.min(Math.max(v, 0), 1).toFixed(5);
  return [
    `crop=w=min(min(iw\\,ih)\\,1.5*max(${f(w)}*iw\\,${f(h)}*ih))`,
    'h=ow',
    `x=max(0\\,min(iw-ow\\,${f(x + w / 2)}*iw-ow/2))`,
    `y=max(0\\,min(ih-oh\\,${f(y + h / 2)}*ih-oh/2))`,
  ]
    .join(':')
    .concat(`,scale=${size}:${size}`);
}

const fail = (e) => {
  throw e;
};

const iou = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const i = w > 0 && h > 0 ? w * h : 0;
  return i / (a.w * a.h + b.w * b.h - i || 1);
};

/**
 * After a face model change, map new clusters to the named people of the old model.
 * A person's name goes to the one new cluster where they hold the most (and a majority of the)
 * matched faces; other clusters stay unnamed rather than repeating the old model's mix-ups.
 */
export function legacyMatches(faces, legacy) {
  const byFile = Map.groupBy(legacy, (l) => l.fileid);
  const votes = new Map();
  for (const f of faces) {
    const l = f.cluster > 0 && byFile.get(f.fileid)?.find((l) => iou(f, l) > 0.5);
    if (!l) continue;
    const v = votes.get(f.cluster) ?? votes.set(f.cluster, new Map()).get(f.cluster);
    v.set(l.cluster, (v.get(l.cluster) ?? 0) + 1);
  }
  const best = new Map();
  for (const [cluster, v] of votes) {
    const total = [...v.values()].reduce((a, b) => a + b, 0);
    const [person, n] = [...v].sort((a, b) => b[1] - a[1])[0];
    if (n * 2 > total && n > (best.get(person)?.[1] ?? 0)) best.set(person, [cluster, n]);
  }
  return [...best].map(([person, [cluster]]) => [cluster, person]);
}

const VIDEO_TILE = 'scale=512:512:force_original_aspect_ratio=increase,crop=512:512,setsar=1';

/** Seconds to sample (at 1/8, 3/8, 5/8, 7/8 of the length); short or unknown lengths sample near the start. */
export const videoFrameTimes = (len) => [1, 3, 5, 7].map((k) => (len > 2 ? (len * k) / 8 : ((k - 1) * 10) / 100));

/** "123-IMG_1.jpg" -> 123 */
export const faceIdOf = (item) => Number(/^(\d+)-/.exec(item ?? '')?.[1]) || 0;

export function registerAi(router, ctx) {
  const { db, lib, uid } = ctx;
  db.exec(SCHEMA);
  for (const col of ['hidden INTEGER NOT NULL DEFAULT 0', 'favorite INTEGER NOT NULL DEFAULT 0', 'birthdate TEXT'])
    if (!db.q('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get('people', col.split(' ')[0]))
      db.exec(`ALTER TABLE people ADD COLUMN ${col}`);
  // Faces from another model live in another embedding space: drop them, keep named ones to re-match
  if (db.getKv('ai.facemodel', '') !== PINS.FACE_REC_SHA)
    db.tx(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS faces_legacy AS
        SELECT f.fileid, f.cluster, f.x, f.y, f.w, f.h FROM faces f JOIN people p ON p.id = f.cluster`);
      db.exec('DELETE FROM faces; UPDATE people SET cover = NULL');
      db.setKv('ai.facemodel', PINS.FACE_REC_SHA);
    });
  const status = (ctx.indexer.status.ai = { state: 'unavailable' });

  /* ---------------- people ---------------- */
  const clusterOf = (name) =>
    /^\d+$/.test(name ?? '') ? Number(name) : db.q('SELECT id FROM people WHERE name = ?').get(name)?.id;
  const mustCluster = (name) => clusterOf(name) ?? fail(notFound(`No such person: ${name}`));
  const facesOf = (cluster) =>
    cluster === null
      ? db.q('SELECT * FROM faces WHERE cluster IS NULL OR cluster < 0').all()
      : db.q('SELECT * FROM faces WHERE cluster = ?').all(cluster);
  const bestFace = (cluster) =>
    db.q('SELECT * FROM faces WHERE cluster = ? ORDER BY score * w * h DESC LIMIT 1').get(cluster);

  function listPeople(fileid) {
    const rows = db
      .q(
        `SELECT f.cluster AS id, p.name, p.cover, count(DISTINCT f.fileid) AS count
         FROM faces f JOIN media m ON m.id = f.fileid AND m.livevideo = 0 LEFT JOIN people p ON p.id = f.cluster
         WHERE f.cluster > 0 AND (:fileid = 0 OR f.cluster IN (SELECT cluster FROM faces WHERE fileid = :fileid))
         GROUP BY f.cluster ORDER BY p.name IS NULL, count DESC, f.cluster`,
      )
      .all({ fileid });
    return rows.map((r) => {
      const cover =
        (r.cover && db.q('SELECT * FROM faces WHERE id = ? AND cluster = ?').get(r.cover, r.id)) || bestFace(r.id);
      return {
        id: r.id,
        user_id: uid,
        name: r.name ?? '',
        count: r.count,
        cover: cover?.id ?? null,
        cover_etag: cover ? (lib.node(cover.fileid)?.etag ?? '') : '',
        cluster_id: r.id,
        cluster_type: 'recognize',
      };
    });
  }
  ctx.clustersOf.recognize = (fileid) => listPeople(fileid);

  /** Assign faces to a person (REJECTED = unassign) in lens and locally. */
  async function assign(faces, cluster) {
    if (!faces.length) return;
    await mustLens().post('/v1/faces/assign', { ids: faces.map((f) => f.point), cluster_id: cluster });
    db.tx(() => faces.forEach((f) => db.q('UPDATE faces SET cluster = ? WHERE id = ?').run(cluster, f.id)));
  }

  /** Person id for a name, creating the person when needed. */
  function ensurePerson(name) {
    const id = clusterOf(name);
    if (id) return id;
    return db.q('INSERT INTO people (id, name) VALUES (?, ?) RETURNING id').get(newPersonId(), name).id;
  }

  async function rename(from, to) {
    const src = mustCluster(from);
    const dst = clusterOf(to);
    if (dst && dst !== src) {
      await assign(facesOf(src), dst);
      db.q('DELETE FROM people WHERE id = ?').run(src);
    } else if (!dst) {
      db.q('INSERT INTO people (id, name) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name').run(
        src,
        to,
      );
    }
  }

  /* ---------------- timeline filter ?recognize=<user>/<name> ---------------- */
  ctx.dayFilters.push((p, f) => {
    if (!p.has('recognize')) return;
    const name = p.get('recognize').split('/').slice(1).join('/');
    f.cluster = true;
    f.joins.push('JOIN faces fc ON fc.fileid = n.id');
    if (name === 'NULL') f.where.push('(fc.cluster IS NULL OR fc.cluster < 0)');
    else {
      f.where.push('fc.cluster = :rcl');
      f.args.rcl = clusterOf(name) ?? 0;
    }
    f.select = `${f.select ?? ''}, fc.id AS faceid`;
    if (!p.has('facerect')) return;
    f.select += ', fc.x AS face_x, fc.y AS face_y, fc.w AS face_w, fc.h AS face_h';
    f.post.push((o) => {
      o.facerect = { x: o.face_x, y: o.face_y, w: o.face_w, h: o.face_h };
      for (const k of ['face_x', 'face_y', 'face_w', 'face_h']) delete o[k];
    });
  });

  /* ---------------- clusters API ---------------- */
  router.add('GET', `${API}/clusters/recognize`, (req, res) => json(res, listPeople(0)));

  router.add('GET', `${API}/clusters/recognize/preview`, async (req, res, _, url) => {
    const cluster = mustCluster(url.searchParams.get('name'));
    const cover = Number(url.searchParams.get('cover')) | 0;
    const face = db.q('SELECT * FROM faces WHERE id = ? AND cluster = ?').get(cover, cluster) ?? bestFace(cluster);
    const file = face && (await faceCrop(face));
    if (!file) throw notFound('No photos found in this cluster');
    sendFile(req, res, file, { type: 'image/jpeg' });
  });

  router.add('POST', `${API}/clusters/recognize/set-cover`, async (req, res) => {
    const { name, fileid } = await readJson(req);
    const cluster = mustCluster(String(name));
    const face = db.q('SELECT id FROM faces WHERE cluster = ? AND fileid = ?').get(cluster, Number(fileid) | 0);
    if (!face) throw notFound('Photo not in this cluster');
    db.q('INSERT INTO people (id, cover) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET cover = excluded.cover').run(
      cluster,
      face.id,
    );
    json(res, {});
  });

  router.add('GET', `${API}/recognize/api-key`, (req, res) => json(res, { apiKey: '' }));

  async function basePreview(n) {
    const file = ctx.previews.file(n.id, 'base');
    if (!fs.existsSync(file)) await ctx.previews.generate(n.id, lib.abs(n.path), false);
    return fs.existsSync(file) ? file : null;
  }

  /** Four frames across a video, stacked vertically in one JPEG, for lens to embed and average. */
  async function videoStrip(n) {
    if (!ctx.ff) return null;
    const out = path.join(ctx.dataDir, 'previews', 'lens-video', `${n.id}-${n.etag}.jpg`);
    if (fs.existsSync(out)) return out;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const len = Math.max(Number(n.video_duration) || 0, 0);
    const at = videoFrameTimes(len);
    const tiles = at.map((_, i) => `[${i}:v]${VIDEO_TILE}[t${i}]`).join(';');
    const stack = `${at.map((_, i) => `[t${i}]`).join('')}vstack=inputs=${at.length}`;
    const src = lib.abs(n.path);
    await run(ctx.ff.ffmpeg, [
      '-v',
      'error',
      '-y',
      ...at.flatMap((t) => ['-ss', t.toFixed(2), '-i', src]),
      '-filter_complex',
      `${tiles};${stack}`,
      '-frames:v',
      '1',
      '-q:v',
      '3',
      out,
    ]);
    return fs.existsSync(out) ? out : null;
  }

  async function faceCrop(face) {
    const n = lib.node(face.fileid);
    if (!n || !ctx.ff) return null;
    const out = path.join(ctx.dataDir, 'previews', 'faces', `${face.id}-${n.etag}.jpg`);
    if (fs.existsSync(out)) return out;
    const base = await basePreview(n);
    if (!base) return null;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const vf = faceCropFilter(face);
    await run(ctx.ff.ffmpeg, ['-v', 'error', '-y', '-i', base, '-vf', vf, '-frames:v', '1', '-q:v', '3', out]);
    return fs.existsSync(out) ? out : null;
  }

  /* ---------------- face review: suggestions and cleanup (Gallery's rules, computed in lens) ---------------- */
  const faceById = (id) =>
    db.q('SELECT * FROM faces WHERE id = ?').get(Number(id) | 0) ?? fail(notFound('No such face'));
  const verdict = db.q('INSERT OR REPLACE INTO face_verdicts (point, cluster, status) VALUES (?, ?, ?)');
  const faceOut = (f) => {
    const n = lib.node(f.fileid);
    const m = db.q('SELECT w, h, dayid FROM media WHERE id = ?').get(f.fileid);
    return (
      n && {
        faceid: f.id,
        fileid: f.fileid,
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
        ...{ basename: n.name, etag: n.etag, mimetype: n.mime },
        iw: m?.w,
        ih: m?.h,
        dayid: m?.dayid,
      }
    );
  };
  const personName = (id) => db.q('SELECT name FROM people WHERE id = ?').get(id)?.name ?? '';

  router.add('GET', `${API}/faces/:id/crop`, async (req, res, { id }) => {
    const file = await faceCrop(faceById(id));
    if (!file) throw notFound('No preview');
    sendFile(req, res, file, { type: 'image/jpeg', cache: 'private, max-age=86400' });
  });

  /** Unassigned faces that may be this person (Gallery's 0.5-0.7 band), minus ones turned down. */
  async function suggestions(id) {
    const exclude = db
      .q("SELECT point FROM face_verdicts WHERE cluster = ? AND status IN ('rejected', 'ignored')")
      .all(id)
      .map((r) => r.point);
    const { items } = await mustLens().post('/v1/faces/suggestions', { cluster_id: id, exclude });
    const byPoint = db.q('SELECT * FROM faces WHERE point = ?');
    const out = items
      .map((it) => {
        const f = byPoint.get(it.id);
        return f && !(f.cluster > 0) && { ...faceOut(f), distance: it.distance };
      })
      .filter((f) => f?.fileid);
    return out;
  }

  async function actOnSuggestion(cluster, face, action) {
    if (action === 'confirm') await assign([face], cluster);
    else if (action === 'reject' || action === 'ignore')
      verdict.run(face.point, cluster, action === 'reject' ? 'rejected' : 'ignored');
    else throw badRequest('Unknown action');
  }

  /** Faces that look misfiled (Gallery's vote rule, in lens), each with its current local row; 'stay' faces skipped. */
  async function audit() {
    const exclude = db
      .q("SELECT point FROM face_verdicts WHERE status = 'stay'")
      .all()
      .map((r) => r.point);
    const { faces } = await mustLens().post('/v1/faces/audit', { exclude });
    const byPoint = db.q('SELECT * FROM faces WHERE point = ?');
    return faces.map((it) => ({ ...it, face: byPoint.get(it.id) })).filter((it) => it.face?.cluster === it.cluster_id);
  }

  ctx.faces = {
    assign,
    faceCrop,
    bestFace,
    facesOf,
    ensurePerson,
    suggestions,
    actOnSuggestion,
    faceById,
    personName,
    audit,
    newPersonId,
  };

  router.add('GET', `${API}/people/:cluster/suggestions`, async (req, res, { cluster }) => {
    const id = mustCluster(cluster);
    const out = await suggestions(id);
    json(res, { name: personName(id), total: out.length, items: out });
  });

  router.add('POST', `${API}/people/:cluster/suggestions/:faceid`, async (req, res, { cluster, faceid }) => {
    const { action } = await readJson(req);
    await actOnSuggestion(mustCluster(cluster), faceById(faceid), action);
    json(res, { acted: action });
  });

  router.add('GET', `${API}/faces/cleanup`, async (req, res) => {
    const people = new Map();
    for (const { face: f, ...it } of await audit()) {
      const p =
        people.get(f.cluster) ??
        people
          .set(f.cluster, {
            cluster: f.cluster,
            name: personName(f.cluster),
            total: db.q('SELECT count(*) AS n FROM faces WHERE cluster = ?').get(f.cluster).n,
            faces: [],
          })
          .get(f.cluster);
      const out = faceOut(f);
      if (out)
        p.faces.push({
          ...out,
          suspected: it.suspected,
          suspectedName: personName(it.suspected),
          votes: it.other,
          own: it.own,
        });
    }
    const list = [...people.values()].filter((p) => p.faces.length);
    for (const p of list) p.overCap = p.faces.length / p.total > 0.5;
    list.sort((a, b) => b.faces.length - a.faces.length);
    json(res, { people: list });
  });

  router.add('POST', `${API}/faces/cleanup/apply`, async (req, res) => {
    const { move = [], stay = [] } = await readJson(req);
    const byTarget = Map.groupBy(move, (m) => Number(m.to));
    for (const [to, items] of byTarget)
      await assign(
        items.map((m) => faceById(m.faceid)),
        to,
      );
    for (const id of stay) {
      const f = faceById(id);
      verdict.run(f.point, f.cluster ?? 0, 'stay');
    }
    json(res, { moved: move.length, kept: stay.length });
  });

  /* ---------------- DAV: /recognize/<uid>/faces/<name>/<faceid>-<basename> ---------------- */
  const facesHref = (...parts) => `${DAV}/recognize/${uid}/${parts.map(encodeURIComponent).join('/')}`;
  const faceEntry = (area, name, face) => {
    const n = lib.node(face.fileid);
    if (!n) return null;
    return {
      href: facesHref(area, ...(name ? [name] : []), `${face.id}-${n.name}`),
      props: {
        'd:getcontenttype': n.mime,
        'd:getcontentlength': n.size,
        'd:getetag': `"${n.etag}"`,
        'd:getlastmodified': new Date(n.mtime * 1000).toUTCString(),
        'd:displayname': n.name,
        'oc:fileid': n.id,
      },
    };
  };

  async function recognizeDav(req, res, segs) {
    if (segs[1] !== uid) throw notFound();
    const [, , area] = segs;
    const unassigned = area === 'unassigned-faces';
    if (!unassigned && area !== 'faces') throw notFound();
    const name = unassigned ? 'NULL' : segs[3];
    const item = unassigned ? segs[3] : segs[4];
    const faceOf = () => db.q('SELECT * FROM faces WHERE id = ?').get(faceIdOf(item)) ?? fail(notFound());

    switch (req.method) {
      case 'PROPFIND': {
        await readBody(req);
        const list = [
          { href: facesHref(area, ...(name && !unassigned ? [name] : [])) + '/', props: {}, collection: true },
        ];
        if (!name)
          for (const p of listPeople(0))
            list.push({ href: facesHref(area, p.name || String(p.id)) + '/', props: {}, collection: true });
        else if (req.headers.depth !== '0')
          for (const face of facesOf(unassigned ? null : mustCluster(name)))
            list.push(faceEntry(area, unassigned ? null : name, face));
        return sendMultistatus(res, list.filter(Boolean));
      }
      case 'MKCOL':
        if (!name || unassigned || item) throw badRequest();
        if (clusterOf(name)) throw new HttpError(405, 'Already exists');
        ensurePerson(name);
        return res.writeHead(201).end();
      case 'MOVE': {
        const [dRoot, dUid, dArea, dName] = destination(req);
        if (dRoot !== 'recognize' || dUid !== uid || dArea !== 'faces' || !dName) throw badRequest('Bad Destination');
        if (item) await assign([faceOf()], ensurePerson(dName));
        else if (!unassigned) await rename(name, dName);
        else throw badRequest();
        return res.writeHead(201).end();
      }
      case 'DELETE':
        if (item) await assign([faceOf()], REJECTED);
        else if (name && !unassigned) {
          const cluster = mustCluster(name);
          await assign(facesOf(cluster), REJECTED);
          db.q('DELETE FROM people WHERE id = ?').run(cluster);
        } else throw badRequest();
        return res.writeHead(204).end();
    }
    throw new HttpError(405, 'Method not allowed');
  }
  ctx.davCollections ??= {};
  ctx.davCollections.recognize = recognizeDav;

  /* ---------------- smart search ---------------- */
  router.add('GET', `${API}/lens/search`, async (req, res, _, url) => {
    const text = url.searchParams.get('text')?.trim();
    if (!text) throw badRequest('Search text must not be empty');
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const folders = db
      .q('SELECT id FROM nodes WHERE dir = 1 AND path <> ? AND path NOT LIKE ?')
      .all(ARCHIVE, `${ARCHIVE}/%`)
      .map((r) => r.id);
    const { hits } = await mustLens().post('/v1/search', { text, folders, limit });
    const byId = db.q(
      `SELECT n.id AS fileid, n.etag, n.mime AS mimetype, m.w, m.h, m.epoch, m.dayid
       FROM nodes n JOIN media m ON m.id = n.id WHERE n.id = ? AND m.livevideo = 0`,
    );
    json(res, hits.map((h) => byId.get(h.fileid) && { ...byId.get(h.fileid), score: h.score }).filter(Boolean));
  });

  /* ---------------- endpoints the lens daemon pulls from ---------------- */
  const lensAuth = () => `Basic ${Buffer.from(`frames:${ctx.token}`).toString('base64')}`;
  const guard = (req) => {
    if (req.headers.authorization !== lensAuth()) throw new HttpError(401, 'Unauthorized');
  };

  /** Leaf-first OSM places of a file (from the places module), for "photos in Paris". */
  function placesOf(fileid) {
    try {
      return db
        .q(
          `SELECT p.osm_id, pl.admin_level, pl.name FROM places p JOIN planet pl ON pl.osm_id = p.osm_id
           WHERE p.fileid = ? ORDER BY pl.admin_level DESC`,
        )
        .all(fileid);
    } catch {
      return [];
    }
  }

  const lensFile = async (req, res, { id }) => {
    guard(req);
    const n = db
      .q(
        'SELECT n.*, m.dayid, m.epoch, m.isvideo, m.video_duration FROM nodes n JOIN media m ON m.id = n.id WHERE n.id = ?',
      )
      .get(Number(id) | 0);
    if (!n) throw notFound();
    const meta = {
      etag: n.etag,
      mtime: n.mtime,
      parent_id: n.parent,
      mimetype: n.isvideo ? n.mime : 'image/jpeg',
      epoch: n.epoch,
      dayid: n.dayid,
      places: placesOf(n.id),
    };
    const headers = { 'X-Memories-Metadata': Buffer.from(JSON.stringify(meta)).toString('base64') };
    if (req.method === 'HEAD') return res.writeHead(200, headers).end();
    // Lens reads Frames' 1024px preview (fast, RAW/HEIC alike); videos as a strip of sampled frames
    const file = n.isvideo ? await videoStrip(n) : await basePreview(n);
    if (!file) throw new HttpError(500, 'Preview not available');
    sendFile(req, res, file, { type: 'image/jpeg', headers });
  };
  router.add('GET', `${LENS}/file/:id`, lensFile);
  router.add('HEAD', `${LENS}/file/:id`, lensFile);

  router.add('POST', `${LENS}/scan`, (req, res) => {
    guard(req);
    const files = db
      .q(
        `SELECT n.id AS fileid, n.parent AS parentid, n.mtime, n.etag, m.isvideo
         FROM nodes n JOIN media m ON m.id = n.id WHERE m.livevideo = 0 ORDER BY n.id`,
      )
      .all()
      .map((f) => ({ ...f, isvideo: !!f.isvideo }));
    json(res, { start: 1, end: null, done: true, files });
  });

  /* ---------------- daemon ---------------- */
  const mustLens = () => {
    if (ctx.lens?.state !== 'ready') throw new HttpError(503, 'AI engine is still starting');
    return ctx.lens;
  };
  if (ctx.lens || !LensDaemon.available()) return; // ctx.lens preset = injected (tests)

  const lens = (ctx.lens = new LensDaemon({
    appUrl: `http://127.0.0.1:${ctx.port}`,
    token: ctx.token,
    dataDir: ctx.dataDir,
  }));
  Object.assign(status, { state: 'starting', queued: 0, indexed: 0, failed: 0, faces: 0, people: 0 });

  // Send freshly indexed photos to lens right away (the periodic lens scan catches the rest)
  const indexIds = ctx.indexer.indexIds.bind(ctx.indexer);
  ctx.indexer.indexIds = async (ids, onDone) => {
    await indexIds(ids, onDone);
    if (lens.state !== 'ready') return;
    for (const id of ids) {
      const n = db
        .q('SELECT n.parent FROM nodes n JOIN media m ON m.id = n.id WHERE n.id = ? AND m.livevideo = 0')
        .get(id);
      if (n) await lens.post('/v1/index', { fileid: id, parent_id: n.parent }).catch(() => {});
    }
  };

  let facesVersion = -1;
  let busy = false;
  async function syncFaces() {
    const { version, faces } = await lens.get('/v1/faces');
    const gen = Number(db.getKv('ai.facegen', 0)) + 1;
    const up = db.q(
      `INSERT INTO faces (point, fileid, cluster, x, y, w, h, score, gen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (point) DO UPDATE SET fileid = excluded.fileid, cluster = excluded.cluster, x = excluded.x,
         y = excluded.y, w = excluded.w, h = excluded.h, score = excluded.score, gen = excluded.gen`,
    );
    db.tx(() => {
      for (const f of faces) up.run(f.id, f.fileid, f.cluster_id ?? null, f.x, f.y, f.w, f.h, f.det_score, gen);
      db.q('DELETE FROM faces WHERE gen <> ?').run(gen);
      db.setKv('ai.facegen', gen);
    });
    facesVersion = version;
  }

  async function carryOverNames() {
    const legacy = db.q('SELECT * FROM faces_legacy').all();
    for (const [cluster, person] of legacyMatches(db.q('SELECT * FROM faces').all(), legacy))
      await assign(facesOf(cluster), person);
    db.exec('DROP TABLE faces_legacy');
    console.log('People names carried over to the new face model.');
  }

  async function poll() {
    if (busy || lens.state !== 'ready') return;
    busy = true;
    try {
      const s = await lens.get('/v1/stats');
      const queued = s.queue_depth + s.in_flight.length;
      if (s.faces_version !== facesVersion) await syncFaces();
      // Only once every photo was re-scanned: one full sweep finished and nothing left to do
      if (!queued && s.scan?.sweeps_total && db.q("SELECT 1 FROM sqlite_master WHERE name = 'faces_legacy'").get())
        await carryOverNames();
      if (status.queued && !queued) console.log('AI index up to date.');
      Object.assign(status, {
        state: queued || s.scan?.status === 'scanning' ? 'indexing' : 'ready',
        queued,
        indexed: s.indexed_total,
        failed: s.failed_total,
        faces: db.q('SELECT count(*) AS n FROM faces').get().n,
        people: db.q('SELECT count(DISTINCT cluster) AS n FROM faces WHERE cluster > 0').get().n,
      });
    } catch (e) {
      status.error = String(e?.message ?? e);
    } finally {
      busy = false;
    }
  }

  void lens.start().then((ok) => {
    if (!ok) return Object.assign(status, { state: 'error', error: lens.error });
    console.log('AI engine ready (People, smart search).');
    setInterval(poll, 5000).unref();
    return poll();
  });
}
