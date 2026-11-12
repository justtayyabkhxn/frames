import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { badRequest, HttpError, notFound, readBody, sendFile } from './http.mjs';
import { cleanRel, parentRel } from './library.mjs';

export const DAV = '/remote.php/dav';
const xmlEsc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

/** Build a multistatus body from [{ href, props: { 'd:getetag': ... }, collection }]. */
export function multistatus(entries) {
  const body = entries
    .map(({ href, props, collection }) => {
      const p = Object.entries(props)
        .filter(([, v]) => v != null)
        .map(([k, v]) => `<${k}>${typeof v === 'object' ? v.raw : xmlEsc(v)}</${k}>`)
        .join('');
      const rt = collection ? '<d:resourcetype><d:collection/></d:resourcetype>' : '<d:resourcetype/>';
      return `<d:response><d:href>${xmlEsc(href)}</d:href><d:propstat><d:prop>${rt}${p}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">${body}</d:multistatus>`;
}

export function sendMultistatus(res, entries) {
  res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
  res.end(multistatus(entries));
}

/** Parse a DAV Destination header into path segments after /remote.php/dav. */
export function destination(req) {
  const d = req.headers.destination;
  if (!d) throw badRequest('Missing Destination');
  const p = decodeURIComponent(new URL(d, 'http://x').pathname);
  if (!p.startsWith(`${DAV}/`)) throw badRequest('Bad Destination');
  return p.slice(DAV.length + 1).split('/');
}

export function registerDav(router, ctx) {
  const { db, lib, uid } = ctx;
  const filesHref = (rel) => `${DAV}/files/${uid}/${encPath(rel)}`;

  const nodeProps = (n) => ({
    'd:getlastmodified': new Date(n.mtime * 1000).toUTCString(),
    'd:getetag': `"${n.etag || n.id}"`,
    'd:getcontenttype': n.dir ? 'httpd/unix-directory' : (n.mime ?? 'application/octet-stream'),
    'd:getcontentlength': n.dir ? null : n.size,
    'd:displayname': n.name,
    'oc:fileid': n.id,
    'oc:id': String(n.id).padStart(8, '0'),
    'oc:favorite': n.favorite ? 1 : 0,
    'oc:permissions': n.dir ? 'RGDNVCK' : 'RGDNVW',
    'oc:owner-id': uid,
    'oc:owner-display-name': ctx.displayName,
    'oc:size': n.size,
    'nc:has-preview': n.dir ? 'false' : 'true',
  });
  const entry = (n) => ({
    href: filesHref(n.path) + (n.dir && n.path ? '/' : ''),
    props: nodeProps(n),
    collection: !!n.dir,
  });

  /** Resolve /files/<uid>/<path> to a relative path. */
  const filesRel = (segs) => {
    if (segs[0] !== 'files' || segs[1] !== uid) throw notFound();
    return cleanRel(segs.slice(2).join('/'));
  };

  /* ---------------- chunked uploads (Nextcloud chunking v2) ---------------- */
  const uploadsDir = path.join(ctx.dataDir, 'uploads');
  const uploadDir = (id) => path.join(uploadsDir, cleanRel(id).replace(/\//g, '_'));

  async function uploads(req, res, segs) {
    if (segs[1] !== uid || !segs[2]) throw notFound();
    const dir = uploadDir(segs[2]);
    const chunk = segs[3];
    switch (req.method) {
      case 'MKCOL':
        fs.mkdirSync(dir, { recursive: true });
        return res.writeHead(201).end();
      case 'PUT': {
        if (!chunk || !/^\d+$/.test(chunk)) throw badRequest('Bad chunk');
        fs.mkdirSync(dir, { recursive: true });
        const part = path.join(dir, chunk);
        try {
          await pipeline(req, fs.createWriteStream(part));
        } catch (e) {
          fs.rmSync(part, { force: true });
          throw e;
        }
        return res.writeHead(201).end();
      }
      case 'MOVE': {
        if (chunk !== '.file') throw badRequest('Expected .file');
        const rel = filesRel(destination(req));
        const parts = fs
          .readdirSync(dir)
          .filter((f) => /^\d+$/.test(f))
          .sort((a, b) => a - b);
        const tmp = path.join(dir, 'assembled');
        const fh = await fs.promises.open(tmp, 'w');
        try {
          for (const p of parts) for await (const c of fs.createReadStream(path.join(dir, p))) await fh.write(c);
        } finally {
          await fh.close();
        }
        const existed = fs.existsSync(lib.abs(rel));
        await lib.put(rel, fs.createReadStream(tmp));
        fs.rmSync(dir, { recursive: true, force: true });
        return res.writeHead(existed ? 204 : 201).end();
      }
      case 'DELETE':
        fs.rmSync(dir, { recursive: true, force: true });
        return res.writeHead(204).end();
    }
    throw new HttpError(405, 'Method not allowed');
  }

  /* ---------------- files ---------------- */
  async function files(req, res, segs, url) {
    const rel = filesRel(segs);
    const n = lib.nodeByPath(rel);
    switch (req.method) {
      case 'OPTIONS':
        return res
          .writeHead(200, {
            DAV: '1, 3',
            Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, SEARCH',
          })
          .end();
      case 'GET':
      case 'HEAD':
        if (!n || n.dir) throw notFound();
        return sendFile(req, res, lib.abs(n.path), { type: n.mime });
      case 'PROPFIND': {
        await readBody(req);
        if (!n) throw notFound();
        const depth = req.headers.depth ?? '1';
        const list = [entry(n)];
        if (n.dir && depth !== '0')
          for (const c of db.q('SELECT * FROM nodes WHERE parent = ? ORDER BY name').all(n.id)) list.push(entry(c));
        return sendMultistatus(res, list);
      }
      case 'PROPPATCH': {
        if (!n) throw notFound();
        const body = (await readBody(req)).toString();
        const fav = /<oc:favorite>\s*([01])\s*<\/oc:favorite>/.exec(body);
        if (fav) db.q('UPDATE nodes SET favorite = ? WHERE id = ?').run(+fav[1], n.id);
        return sendMultistatus(res, [
          { href: filesHref(n.path), props: { 'oc:favorite': fav?.[1] ?? null }, collection: !!n.dir },
        ]);
      }
      case 'MKCOL':
        if (n) throw new HttpError(405, 'Already exists');
        lib.mkdir(rel);
        return res.writeHead(201).end();
      case 'PUT': {
        const existed = !!n;
        await lib.put(rel, req);
        const now = lib.nodeByPath(rel);
        return res
          .writeHead(existed ? 204 : 201, { ETag: `"${now?.etag ?? ''}"`, 'OC-FileId': String(now?.id ?? '') })
          .end();
      }
      case 'DELETE':
        if (!n) throw notFound();
        lib.trash(n.id);
        return res.writeHead(204).end();
      case 'MOVE':
      case 'COPY': {
        if (!n) throw notFound();
        const dest = filesRel(destination(req));
        if (req.method === 'COPY' && lib.samePath(dest, n.path))
          throw new HttpError(403, 'Source and destination are the same');
        const overwrite = req.headers.overwrite !== 'F';
        const existed = fs.existsSync(lib.abs(dest)) && !lib.samePath(dest, n.path);
        if (existed && !overwrite) throw new HttpError(412, 'Destination exists');
        if (req.method === 'MOVE') lib.move(n.id, dest, { overwrite });
        else {
          if (existed) {
            const d = lib.nodeAt(dest);
            if (!d) throw new HttpError(409, 'Destination is not in the library index; rescan first');
            lib.trash(d.id);
          }
          await lib.copy(n.id, dest);
        }
        return res.writeHead(existed ? 204 : 201).end();
      }
    }
    throw new HttpError(405, 'Method not allowed');
  }

  /** SEARCH by file ids (used to resolve paths of selected photos). */
  async function search(req, res) {
    const body = (await readBody(req)).toString();
    const ids = [...body.matchAll(/<d:literal>\s*(\d+)\s*<\/d:literal>/g)].map((m) => +m[1]);
    const list = ids
      .map((id) => lib.node(id))
      .filter(Boolean)
      .map(entry);
    sendMultistatus(res, list);
  }

  /* ---------------- trashbin ---------------- */
  const trashHref = (t) => `${DAV}/trashbin/${uid}/trash/${t.id}`;
  async function trashbin(req, res, segs) {
    if (segs[1] !== uid) throw notFound();
    const [, , area, item] = segs;
    const t = item ? db.q('SELECT * FROM trash WHERE id = ?').get(Number(item) | 0) : null;
    if (item && !t) throw notFound();
    switch (req.method) {
      case 'PROPFIND': {
        await readBody(req);
        const rows = t ? [t] : db.q('SELECT * FROM trash ORDER BY deleted_at DESC').all();
        const list = rows.map((r) => ({
          href: trashHref(r),
          collection: JSON.parse(r.meta).dir,
          props: {
            'd:getcontentlength': r.size,
            'd:getcontenttype': r.mime,
            'oc:fileid': r.id,
            'nc:trashbin-filename': r.name,
            'nc:trashbin-original-location': r.orig_path,
            'nc:trashbin-deletion-time': r.deleted_at,
          },
        }));
        if (!t) list.unshift({ href: `${DAV}/trashbin/${uid}/${area}/`, collection: true, props: {} });
        return sendMultistatus(res, list);
      }
      case 'GET':
      case 'HEAD':
        if (!t) throw notFound();
        return sendFile(req, res, lib.trashFile(t), { type: t.mime });
      case 'MOVE': {
        if (!t) throw notFound();
        const dest = destination(req);
        // restore to original location, or to an explicit files/ destination
        await lib.restore(t.id, dest[0] === 'files' ? filesRel(dest) : undefined);
        return res.writeHead(201).end();
      }
      case 'DELETE':
        if (t) lib.purge(t.id);
        else for (const r of db.q('SELECT id FROM trash').all()) lib.purge(r.id);
        return res.writeHead(204).end();
    }
    throw new HttpError(405, 'Method not allowed');
  }

  /** Other modules register DAV collections here: ctx.davCollections.photos = fn(req, res, segs, url). */
  ctx.davCollections = { files, uploads, trashbin, ...ctx.davCollections };

  router.add('*', `${DAV}/*rest`, async (req, res, { rest }, url) => {
    const segs = rest.split('/').filter(Boolean);
    if (req.method === 'SEARCH') return search(req, res);
    const handler = ctx.davCollections[segs[0]];
    if (!handler) throw notFound();
    return handler(req, res, segs, url);
  });

  /* ---------------- trash API used by the Trash view ---------------- */
  router.add('GET', '/apps/memories/api/trash/list', (req, res) => {
    const rows = db
      .q('SELECT * FROM trash ORDER BY deleted_at DESC')
      .all()
      .filter((t) => !JSON.parse(t.meta).dir && t.mime);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        rows.map((t) => ({
          fileid: t.id,
          deletion_time: t.deleted_at,
          basename: t.name,
          mimetype: t.mime,
          size: t.size,
          etag: String(t.id),
          trash_path: `/trashbin/${uid}/trash/${t.id}`,
          orig_path: `/${parentRel(t.orig_path)}`,
        })),
      ),
    );
  });
  router.add('GET', '/apps/files_trashbin/preview', async (req, res, _, url) => {
    const t = db.q('SELECT * FROM trash WHERE id = ?').get(Number(url.searchParams.get('fileId')) | 0);
    if (!t || !lib.trashFile(t)) throw notFound();
    const p = url.searchParams;
    const file = await ctx.previews.get(
      `t${t.id}`,
      lib.trashFile(t),
      t.mime?.startsWith('video/'),
      Number(p.get('x')) || 256,
      Number(p.get('y')) || 256,
      p.get('a') !== '1',
    );
    if (!file) throw notFound();
    sendFile(req, res, file, { type: 'image/jpeg', cache: 'no-cache' });
  });
}
