import { badRequest, HttpError, json, notFound, readBody, readJson, sendFile } from './http.mjs';
import { DAV, destination, multistatus, sendMultistatus } from './dav.mjs';
import { cleanRel } from './library.mjs';

const API = '/apps/memories/api';
const xmlUnesc = (s) =>
  s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e]);

/** Albums (Nextcloud Photos DAV + Memories cluster API) and tags (systemtags DAV + cluster API). */
export function registerClusters(router, ctx) {
  const { db, lib, uid } = ctx;
  const now = () => Math.floor(Date.now() / 1000);
  const etagOf = (id) => (id ? (db.q('SELECT etag FROM nodes WHERE id = ?').get(id)?.etag ?? '') : '');

  /* ---------------- albums ---------------- */
  const albumByName = (name) => db.q('SELECT * FROM albums WHERE name = ?').get(name);
  /** "user/name" (API) -> album row, or 404. */
  const albumByClusterId = (id) => {
    const i = String(id ?? '').indexOf('/');
    const a = i > 0 && id.slice(0, i) === uid ? albumByName(id.slice(i + 1)) : null;
    if (!a) throw notFound(`Album not found: ${id}`);
    return a;
  };
  const inAlbum = (album, fileid) =>
    !!db.q('SELECT 1 FROM album_files WHERE album = ? AND fileid = ?').get(album, fileid);

  function listAlbums(fileid = 0) {
    const rows = db
      .q(
        `SELECT a.*, count(m.id) AS count, max(af.added) AS update_id,
          (SELECT x.fileid FROM album_files x WHERE x.album = a.id ORDER BY x.added DESC LIMIT 1) AS last_added_photo
        FROM albums a
        LEFT JOIN album_files af ON af.album = a.id
        LEFT JOIN media m ON m.id = af.fileid AND m.livevideo = 0
        WHERE :f = 0 OR EXISTS (SELECT 1 FROM album_files y WHERE y.album = a.id AND y.fileid = :f)
        GROUP BY a.id`,
      )
      .all({ f: Number(fileid) | 0 });
    return rows.map((a) => {
      const cover = a.cover && inAlbum(a.id, a.cover) ? a.cover : null;
      return {
        album_id: a.id,
        name: a.name,
        user: uid,
        user_display: ctx.displayName,
        created: a.created,
        location: a.location,
        last_added_photo: a.last_added_photo ?? 0,
        last_added_photo_etag: etagOf(a.last_added_photo),
        count: a.count,
        update_id: a.update_id ?? 0,
        shared: false,
        cover,
        cover_etag: cover ? etagOf(cover) : null,
        cluster_id: `${uid}/${a.name}`,
        cluster_type: 'albums',
      };
    });
  }

  /* ---------------- tags ---------------- */
  const tagByName = (name) => db.q('SELECT * FROM tags WHERE name = ?').get(String(name ?? ''));
  const mustTag = (name) => {
    const t = tagByName(name);
    if (!t) throw notFound(`Tag not found: ${name}`);
    return t;
  };
  const createTag = (name) => {
    name = String(name ?? '').trim();
    if (!name) throw badRequest('Missing tag name');
    return tagByName(name)?.id ?? db.q('INSERT INTO tags (name) VALUES (?) RETURNING id').get(name).id;
  };
  const latestTagged = (tag) =>
    db
      .q(
        `SELECT tf.fileid FROM tag_files tf JOIN media m ON m.id = tf.fileid AND m.livevideo = 0
        WHERE tf.tag = ? ORDER BY m.datetaken DESC LIMIT 1`,
      )
      .get(tag)?.fileid ?? null;

  function listTags() {
    const rows = db
      .q(
        `SELECT t.id, t.name, t.cover, count(DISTINCT m.id) AS count,
          EXISTS (SELECT 1 FROM tag_files c WHERE c.tag = t.id AND c.fileid = t.cover) AS cover_ok
        FROM tags t JOIN tag_files tf ON tf.tag = t.id JOIN media m ON m.id = tf.fileid AND m.livevideo = 0
        GROUP BY t.id ORDER BY lower(t.name), t.id`,
      )
      .all();
    return rows.map((t) => {
      const cover = t.cover_ok ? t.cover : latestTagged(t.id);
      return {
        id: t.id,
        name: t.name,
        count: t.count,
        cover,
        cover_etag: etagOf(cover),
        cluster_id: t.name,
        cluster_type: 'tags',
      };
    });
  }

  ctx.tagsOf = (fileid) =>
    Object.fromEntries(
      db
        .q('SELECT t.id, t.name FROM tags t JOIN tag_files tf ON tf.tag = t.id WHERE tf.fileid = ?')
        .all(fileid)
        .map((t) => [t.id, t.name]),
    );
  ctx.clustersOf.albums = (fileid) => listAlbums(fileid);

  /* ---------------- timeline filters ---------------- */
  ctx.dayFilters.push((p, f) => {
    if (p.has('albums')) {
      const k = `alb${f.n++}`;
      f.args[k] = albumByClusterId(p.get('albums')).id;
      f.joins.push(`JOIN album_files ${k} ON ${k}.fileid = n.id AND ${k}.album = :${k}`);
      f.cluster = true;
    }
    if (p.has('tags')) {
      const k = `tag${f.n++}`;
      f.args[k] = mustTag(p.get('tags')).id;
      f.joins.push(`JOIN tag_files ${k} ON ${k}.fileid = n.id AND ${k}.tag = :${k}`);
      f.cluster = true;
    }
  });

  /* ---------------- cluster API ---------------- */
  const backends = {
    albums: {
      list: (p) => listAlbums(p.get('fileid')),
      files: (name) =>
        db
          .q('SELECT fileid FROM album_files WHERE album = ? ORDER BY added DESC')
          .all(albumByClusterId(name).id)
          .map((r) => r.fileid),
      cover: (name) => {
        const a = albumByClusterId(name);
        return a.cover && inAlbum(a.id, a.cover) ? a.cover : null;
      },
      setCover: (name, fileid) => {
        const a = albumByClusterId(name);
        if (!inAlbum(a.id, fileid)) throw notFound('Photo not in album');
        db.q('UPDATE albums SET cover = ? WHERE id = ?').run(fileid, a.id);
      },
    },
    tags: {
      list: () => listTags(),
      files: (name) =>
        db
          .q(
            `SELECT tf.fileid FROM tag_files tf JOIN media m ON m.id = tf.fileid WHERE tf.tag = ? ORDER BY m.datetaken DESC`,
          )
          .all(mustTag(name).id)
          .map((r) => r.fileid),
      cover: (name) => listTags().find((t) => t.name === name)?.cover ?? null,
      setCover: (name, fileid) => {
        const t = mustTag(name);
        if (!db.q('SELECT 1 FROM tag_files WHERE tag = ? AND fileid = ?').get(t.id, fileid))
          throw notFound('Photo not tagged');
        db.q('UPDATE tags SET cover = ? WHERE id = ?').run(fileid, t.id);
      },
    },
  };

  for (const [type, b] of Object.entries(backends)) {
    router.add('GET', `${API}/clusters/${type}`, (req, res, _, url) => json(res, b.list(url.searchParams)));
    router.add('GET', `${API}/clusters/${type}/preview`, async (req, res, _, url) => {
      const name = url.searchParams.get('name');
      for (const id of [b.cover(name), ...b.files(name).slice(0, 8)].filter(Boolean)) {
        const n = db.q('SELECT n.path, m.isvideo FROM nodes n JOIN media m ON m.id = n.id WHERE n.id = ?').get(id);
        const file = n && (await ctx.previews.get(id, lib.abs(n.path), !!n.isvideo, 512, 512, true));
        if (file) return sendFile(req, res, file, { type: 'image/jpeg', cache: 'no-cache' });
      }
      throw notFound('No photos found in this cluster');
    });
    router.add('POST', `${API}/clusters/${type}/set-cover`, async (req, res) => {
      const { name, fileid } = await readJson(req);
      b.setCover(name, Number(fileid) | 0);
      json(res, {});
    });
  }

  router.add('POST', `${API}/clusters/albums/download`, (req, res, _, url) => {
    const files = backends.albums.files(url.searchParams.get('name'));
    json(res, { handle: ctx.downloadHandle(files) });
  });

  router.add('PATCH', `${API}/tags/set/:id`, async (req, res, { id }) => {
    const n = lib.mustNode(id);
    const { add = [], remove = [] } = await readJson(req);
    // ids, or names for tags that do not exist yet
    const ids = (list) => list.map((t) => (Number.isFinite(Number(t)) ? Number(t) : createTag(t)));
    db.tx(() => {
      for (const t of ids(add ?? []))
        db.q('INSERT OR IGNORE INTO tag_files (tag, fileid) SELECT id, ? FROM tags WHERE id = ?').run(n.id, t);
      for (const t of ids(remove ?? [])) db.q('DELETE FROM tag_files WHERE tag = ? AND fileid = ?').run(t, n.id);
    });
    json(res, {});
  });

  /* ---------------- DAV: photos (albums) ---------------- */
  const enc = encodeURIComponent;
  const albumHref = (name) => `${DAV}/photos/${uid}/albums/${enc(name)}`;
  const albumEntry = (a) => {
    const range = db
      .q(
        'SELECT min(m.datetaken) AS lo, max(m.datetaken) AS hi, count(m.id) AS n FROM album_files af JOIN media m ON m.id = af.fileid WHERE af.album = ?',
      )
      .get(a.id);
    const last = db.q('SELECT fileid FROM album_files WHERE album = ? ORDER BY added DESC LIMIT 1').get(a.id);
    return {
      href: albumHref(a.name),
      collection: true,
      props: {
        'd:displayname': a.name,
        'd:getlastmodified': new Date(a.updated * 1000).toUTCString(),
        'oc:fileid': a.id,
        'nc:location': a.location,
        'nc:nbItems': range.n,
        'nc:last-photo': last?.fileid ?? -1,
        'nc:dateRange': JSON.stringify({ start: range.lo, end: range.hi }),
        'nc:collaborators': '',
      },
    };
  };
  const albumFileEntry = (a, n) => ({
    href: `${albumHref(a.name)}/${enc(`${n.id}-${n.name}`)}`,
    props: {
      'd:displayname': n.name,
      'd:getetag': `"${n.etag}"`,
      'd:getcontenttype': n.mime ?? 'application/octet-stream',
      'd:getcontentlength': n.size,
      'd:getlastmodified': new Date(n.mtime * 1000).toUTCString(),
      'oc:fileid': n.id,
      'oc:favorite': n.favorite ? 1 : 0,
      'nc:has-preview': 'true',
      'nc:file-name': n.name,
    },
  });
  const touch = (id) => db.q('UPDATE albums SET updated = ? WHERE id = ?').run(now(), id);
  const validName = (name) => {
    if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw badRequest('Invalid album name');
    return name;
  };
  const addToAlbum = (a, fileid) => {
    const r = db
      .q('INSERT OR IGNORE INTO album_files (album, fileid, added) VALUES (?, ?, ?)')
      .run(a.id, fileid, Date.now());
    touch(a.id);
    return r.changes > 0;
  };

  async function photos(req, res, segs) {
    if (segs[1] !== uid) throw notFound();
    if (segs[2] === 'sharedalbums') {
      if (req.method !== 'PROPFIND') throw notFound();
      if (segs[3]) throw notFound();
      await readBody(req);
      return sendMultistatus(res, [{ href: `${DAV}/photos/${uid}/sharedalbums/`, collection: true, props: {} }]);
    }
    if (segs[2] !== 'albums') throw notFound();
    const [, , , name, item] = segs;
    const a = name ? albumByName(name) : null;
    const fileid = item ? Number.parseInt(item, 10) : 0;

    switch (req.method) {
      case 'OPTIONS':
        return res
          .writeHead(200, { DAV: '1, 3', Allow: 'OPTIONS, PROPFIND, PROPPATCH, MKCOL, DELETE, MOVE, COPY' })
          .end();
      case 'PROPFIND': {
        await readBody(req);
        const depth = req.headers.depth ?? '1';
        if (!name) {
          const list = [{ href: `${DAV}/photos/${uid}/albums/`, collection: true, props: {} }];
          if (depth !== '0') list.push(...db.q('SELECT * FROM albums ORDER BY created').all().map(albumEntry));
          return sendMultistatus(res, list);
        }
        if (!a) throw notFound();
        const files = db
          .q(
            'SELECT n.* FROM album_files af JOIN nodes n ON n.id = af.fileid WHERE af.album = ? ORDER BY af.added DESC',
          )
          .all(a.id);
        if (item) {
          const n = files.find((f) => f.id === fileid);
          if (!n) throw notFound();
          return sendMultistatus(res, [albumFileEntry(a, n)]);
        }
        return sendMultistatus(res, [albumEntry(a), ...(depth === '0' ? [] : files.map((n) => albumFileEntry(a, n)))]);
      }
      case 'GET':
      case 'HEAD': {
        if (!a || !item || !inAlbum(a.id, fileid)) throw notFound();
        const n = lib.mustNode(fileid);
        return sendFile(req, res, lib.abs(n.path), { type: n.mime });
      }
      case 'MKCOL':
        if (!name || item) throw new HttpError(405, 'Method not allowed');
        if (a) throw new HttpError(405, 'Album already exists');
        db.q('INSERT INTO albums (name, created, updated) VALUES (?, ?, ?)').run(validName(name), now(), now());
        return res.writeHead(201).end();
      case 'PROPPATCH': {
        if (!a || item) throw notFound();
        const body = (await readBody(req)).toString();
        const m = /<(?:\w+:)?location\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?location>)/.exec(body);
        if (m) db.q('UPDATE albums SET location = ? WHERE id = ?').run(xmlUnesc(m[1] ?? ''), a.id);
        touch(a.id);
        // Collaborators are accepted and ignored: Frames is single-user and offline
        return sendMultistatus(res, [{ href: albumHref(a.name), collection: true, props: {} }]);
      }
      case 'DELETE':
        if (!a) throw notFound();
        if (item) {
          if (!db.q('DELETE FROM album_files WHERE album = ? AND fileid = ?').run(a.id, fileid).changes)
            throw notFound();
          if (a.cover === fileid) db.q('UPDATE albums SET cover = NULL WHERE id = ?').run(a.id);
          touch(a.id);
        } else db.q('DELETE FROM albums WHERE id = ?').run(a.id);
        return res.writeHead(204).end();
      case 'MOVE': {
        if (!a || item) throw notFound();
        const d = destination(req);
        if (d[0] !== 'photos' || d[1] !== uid || d[2] !== 'albums' || d.length !== 4)
          throw badRequest('Bad Destination');
        const to = validName(d[3]);
        if (to === a.name) return res.writeHead(201).end();
        if (albumByName(to)) throw new HttpError(412, 'Destination exists');
        db.q('UPDATE albums SET name = ?, updated = ? WHERE id = ?').run(to, now(), a.id);
        return res.writeHead(201).end();
      }
      case 'COPY': {
        // album item -> other album
        if (!a || !item || !inAlbum(a.id, fileid)) throw notFound();
        return copyInto(res, destination(req), fileid);
      }
    }
    throw new HttpError(405, 'Method not allowed');
  }

  /** COPY of a file into /photos/<uid>/albums/<name>/<basename> = add it to the album. */
  function copyInto(res, d, fileid) {
    if (d[0] !== 'photos' || d[1] !== uid || d[2] !== 'albums' || !d[3]) throw badRequest('Bad Destination');
    const a = albumByName(d[3]);
    if (!a) throw notFound('Album not found');
    if (!addToAlbum(a, fileid)) throw new HttpError(409, 'Already in album');
    return res.writeHead(201).end();
  }

  // Files COPY'd into an album arrive on the files collection; intercept before dav.mjs's handler.
  router.add('COPY', `${DAV}/files/*rest`, async (req, res, { rest }, url) => {
    const segs = ['files', ...rest.split('/').filter(Boolean)];
    const d = destination(req);
    if (d[0] !== 'photos') return ctx.davCollections.files(req, res, segs, url);
    if (segs[1] !== uid) throw notFound();
    const n = lib.nodeByPath(cleanRel(segs.slice(2).join('/')));
    if (!n || n.dir) throw notFound();
    return copyInto(res, d, n.id);
  });

  /* ---------------- DAV: systemtags ---------------- */
  async function systemtags(req, res, segs) {
    const t = segs[1] ? db.q('SELECT * FROM tags WHERE id = ?').get(Number(segs[1]) | 0) : null;
    if (segs[1] && !t) throw notFound();
    switch (req.method) {
      case 'PROPFIND': {
        await readBody(req);
        const tags = t ? [t] : db.q('SELECT * FROM tags ORDER BY lower(name)').all();
        const body = multistatus(
          tags.map((x) => ({
            href: `${DAV}/systemtags/${x.id}`,
            props: {
              'oc:id': x.id,
              'oc:display-name': x.name,
              'oc:user-visible': 'true',
              'oc:user-assignable': 'true',
              'oc:can-assign': 'true',
            },
          })),
        );
        // The collection itself, with a 404 propstat like Sabre. NcSelectTags needs >= 2 responses
        // (it iterates them with for..in), so an empty list repeats it.
        const root = `<d:response><d:href>${DAV}/systemtags/</d:href><d:propstat><d:prop><oc:id/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`;
        const roots = t ? '' : tags.length ? root : root + root;
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
        return res.end(body.replace(/(<d:multistatus[^>]*>)/, `$1${roots}`));
      }
      case 'POST': {
        if (t) throw new HttpError(405, 'Method not allowed');
        const { name } = await readJson(req);
        const id = createTag(name);
        return res.writeHead(201, { 'Content-Location': `${DAV}/systemtags/${id}` }).end();
      }
      case 'PROPPATCH': {
        if (!t) throw notFound();
        const m = /<(?:\w+:)?display-name\b[^>]*>([\s\S]*?)<\/(?:\w+:)?display-name>/.exec(
          (await readBody(req)).toString(),
        );
        const to = m && xmlUnesc(m[1]).trim();
        if (to && to !== t.name) {
          if (tagByName(to)) throw new HttpError(409, 'Tag exists');
          db.q('UPDATE tags SET name = ? WHERE id = ?').run(to, t.id);
        }
        return sendMultistatus(res, [{ href: `${DAV}/systemtags/${t.id}`, props: {} }]);
      }
      case 'DELETE':
        if (!t) throw new HttpError(405, 'Method not allowed');
        db.q('DELETE FROM tags WHERE id = ?').run(t.id);
        return res.writeHead(204).end();
    }
    throw new HttpError(405, 'Method not allowed');
  }

  ctx.davCollections ??= {};
  Object.assign(ctx.davCollections, { photos, systemtags });
}
