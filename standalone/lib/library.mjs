import fs from 'node:fs';
import path from 'node:path';
import { badRequest, HttpError, notFound } from './http.mjs';
import { ARCHIVE } from './indexer.mjs';

/** Normalize a user-supplied path to a clean relative path ('' = root). Rejects traversal. */
export function cleanRel(p) {
  const parts = [];
  for (const seg of String(p ?? '')
    .replace(/\\/g, '/')
    .split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..' || seg.includes('\0') || /[<>:"|?*]/.test(seg)) throw badRequest(`Invalid path: ${p}`);
    parts.push(seg);
  }
  return parts.join('/');
}

export const parentRel = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

/** Library operations that keep disk and index in sync. */
export class Library {
  constructor(ctx) {
    this.ctx = ctx;
    this.db = ctx.db;
    this.trashDir = path.join(ctx.dataDir, 'trash');
    fs.mkdirSync(this.trashDir, { recursive: true });
  }

  abs(rel) {
    return path.join(this.ctx.root, ...rel.split('/').filter(Boolean));
  }

  node(id) {
    return this.db.q('SELECT * FROM nodes WHERE id = ?').get(Number(id) | 0);
  }

  nodeByPath(rel) {
    return this.db.q('SELECT * FROM nodes WHERE path = ?').get(rel);
  }

  mustNode(id) {
    const n = this.node(id);
    if (!n || !fs.existsSync(this.abs(n.path))) throw notFound(`File not found: ${id}`);
    return n;
  }

  /** Free name in a folder: "a.jpg" -> "a (2).jpg". */
  freeRel(rel) {
    if (!fs.existsSync(this.abs(rel))) return rel;
    const ext = path.posix.extname(rel);
    const stem = rel.slice(0, rel.length - ext.length);
    for (let i = 2; ; i++) if (!fs.existsSync(this.abs(`${stem} (${i})${ext}`))) return `${stem} (${i})${ext}`;
  }

  mkdir(rel) {
    fs.mkdirSync(this.abs(rel), { recursive: true });
    return this.ctx.indexer.ensureNode(rel, { dir: true });
  }

  /** Move/rename a node (file or folder) to newRel; keeps ids, favorites, albums and previews. */
  move(id, newRel, { overwrite = false } = {}) {
    const n = this.mustNode(id);
    newRel = cleanRel(newRel);
    if (!newRel) throw badRequest('Cannot move to root');
    if (newRel === n.path) return n.id;
    if (n.dir && (newRel + '/').startsWith(n.path + '/')) throw badRequest('Cannot move a folder into itself');
    const dest = this.nodeByPath(newRel);
    if (fs.existsSync(this.abs(newRel))) {
      if (!overwrite) throw new HttpError(412, 'Destination exists');
      this.trash(dest?.id ?? this.ctx.indexer.ensureNode(newRel, { dir: fs.statSync(this.abs(newRel)).isDirectory() }));
    }
    fs.mkdirSync(path.dirname(this.abs(newRel)), { recursive: true });
    fs.renameSync(this.abs(n.path), this.abs(newRel));
    const parent = this.mkdir(parentRel(newRel));
    this.db.tx(() => {
      if (n.dir) {
        this.db
          .q(`UPDATE nodes SET path = ? || substr(path, ?) WHERE substr(path, 1, ?) = ?`)
          .run(newRel + '/', n.path.length + 2, n.path.length + 1, n.path + '/');
      }
      this.db
        .q('UPDATE nodes SET path = ?, name = ?, parent = ? WHERE id = ?')
        .run(newRel, path.posix.basename(newRel), parent, n.id);
    });
    return n.id;
  }

  /** Copy a file to newRel and index the copy. Returns the new id. */
  async copy(id, newRel) {
    const n = this.mustNode(id);
    if (n.dir) throw badRequest('Copying folders is not supported');
    newRel = this.freeRel(cleanRel(newRel));
    fs.mkdirSync(path.dirname(this.abs(newRel)), { recursive: true });
    fs.copyFileSync(this.abs(n.path), this.abs(newRel));
    return this.ctx.indexer.indexPath(newRel);
  }

  /** Write uploaded bytes (stream) to rel and index it. */
  async put(rel, stream) {
    rel = cleanRel(rel);
    if (!rel) throw badRequest('Missing file name');
    fs.mkdirSync(path.dirname(this.abs(rel)), { recursive: true });
    const tmp = `${this.abs(rel)}.frames-upload`;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      stream.pipe(out).on('finish', resolve).on('error', reject);
      stream.on('error', reject);
    });
    fs.renameSync(tmp, this.abs(rel));
    this.mkdir(parentRel(rel));
    return (await this.ctx.indexer.indexPath(rel)) ?? this.ctx.indexer.ensureNode(rel, { dir: false });
  }

  /** Move a node into the trash. */
  trash(id) {
    const n = this.mustNode(id);
    if (!n.path) throw badRequest('Cannot delete the library root');
    const meta = JSON.stringify({ favorite: n.favorite, dir: n.dir });
    const { tid } = this.db
      .q(
        'INSERT INTO trash (name, orig_path, file, deleted_at, size, mime, meta) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id AS tid',
      )
      .get(n.name, n.path, '', Math.floor(Date.now() / 1000), n.size, n.mime, meta);
    const file = `${tid}-${n.name}`;
    fs.renameSync(this.abs(n.path), path.join(this.trashDir, file));
    this.db.q('UPDATE trash SET file = ? WHERE id = ?').run(file, tid);
    this.ctx.previews.remove(n.id);
    this.db.q('DELETE FROM nodes WHERE id = ?').run(n.id);
    return tid;
  }

  trashFile(t) {
    return path.join(this.trashDir, t.file);
  }

  async restore(tid, toRel) {
    const t = this.db.q('SELECT * FROM trash WHERE id = ?').get(Number(tid) | 0);
    if (!t) throw notFound('Not in trash');
    const rel = this.freeRel(cleanRel(toRel ?? t.orig_path));
    fs.mkdirSync(path.dirname(this.abs(rel)), { recursive: true });
    fs.renameSync(this.trashFile(t), this.abs(rel));
    this.db.q('DELETE FROM trash WHERE id = ?').run(t.id);
    this.ctx.previews.remove(`t${t.id}`);
    const meta = JSON.parse(t.meta);
    if (meta.dir) {
      this.mkdir(rel);
      void this.ctx.indexer.scan();
      return null;
    }
    const id = await this.ctx.indexer.indexPath(rel);
    if (id && meta.favorite) this.db.q('UPDATE nodes SET favorite = 1 WHERE id = ?').run(id);
    return id;
  }

  purge(tid) {
    const t = this.db.q('SELECT * FROM trash WHERE id = ?').get(Number(tid) | 0);
    if (!t) throw notFound('Not in trash');
    fs.rmSync(this.trashFile(t), { recursive: true, force: true });
    this.ctx.previews.remove(`t${t.id}`);
    this.db.q('DELETE FROM trash WHERE id = ?').run(t.id);
  }

  isArchived(rel) {
    return rel === ARCHIVE || rel.startsWith(`${ARCHIVE}/`);
  }

  /** Archive: move into /.archive keeping the relative layout; unarchive moves it back. */
  setArchived(id, archive) {
    const n = this.mustNode(id);
    if (archive === this.isArchived(n.path)) return n.id;
    const to = archive ? `${ARCHIVE}/${n.path}` : n.path.slice(ARCHIVE.length + 1);
    return this.move(n.id, this.freeRel(to));
  }
}
