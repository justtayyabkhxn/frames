import fs from 'node:fs';
import path from 'node:path';
import { badRequest, HttpError, notFound } from './http.mjs';
import { ARCHIVE } from './indexer.mjs';

/** Normalize a user-supplied path to a clean relative path ('' = root). Rejects traversal. */
const WIN = process.platform === 'win32';
// Names Windows cannot store or silently alters (reserved devices, trailing dot/space)
const WIN_BAD = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$|[. ]$/i;

/** Rename, falling back to copy + delete across drives. */
export function moveFs(src, dst) {
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

export function cleanRel(p) {
  const parts = [];
  for (const seg of String(p ?? '')
    .replace(/\\/g, '/')
    .split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..' || seg.includes('\0') || /[<>:"|?*]/.test(seg) || (WIN && WIN_BAD.test(seg))) {
      throw badRequest(`Invalid path: ${p}`);
    }
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
    // Everything Frames creates stays in its own folder: the Bin is <data>/trash (moves across drives copy)
    this.trashDir = path.join(ctx.dataDir, 'trash');
    this.legacyTrashDir = path.join(ctx.root, '.frames-trash');
  }

  /** Same file on this filesystem? (Windows and macOS compare names case-insensitively.) */
  samePath(a, b) {
    return WIN || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  /** Node at rel, matching case-insensitively where the filesystem does. */
  nodeAt(rel) {
    return WIN || process.platform === 'darwin'
      ? this.db.q('SELECT * FROM nodes WHERE path = ? COLLATE NOCASE').get(rel)
      : this.nodeByPath(rel);
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
    const caseOnly = this.samePath(newRel, n.path);
    if (n.dir && !caseOnly && `${newRel}/`.toLowerCase().startsWith(`${n.path}/`.toLowerCase())) {
      throw badRequest('Cannot move a folder into itself');
    }
    const dest = this.nodeAt(newRel);
    if (!caseOnly && fs.existsSync(this.abs(newRel))) {
      if (!overwrite) throw new HttpError(412, 'Destination exists');
      this.trash(dest?.id ?? this.ctx.indexer.ensureNode(newRel, { dir: fs.statSync(this.abs(newRel)).isDirectory() }));
    }
    fs.mkdirSync(path.dirname(this.abs(newRel)), { recursive: true });
    moveFs(this.abs(n.path), this.abs(newRel));
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

  /** Move a node into the trash. */
  trash(id) {
    const n = this.mustNode(id);
    if (!n.path) throw badRequest('Cannot delete the library root');
    // Date, size and kind too, so the Bin can show it by date taken
    const m = this.db.q('SELECT datetaken, epoch, w, h, isvideo, video_duration FROM media WHERE id = ?').get(n.id);
    const meta = JSON.stringify({ favorite: n.favorite, dir: n.dir, ...m });
    const tid = this.db.nextId('trash');
    const file = `${tid}-${n.name}`;
    // Move first: a failed move must leave no trash row behind
    fs.mkdirSync(this.trashDir, { recursive: true });
    moveFs(this.abs(n.path), path.join(this.trashDir, file));
    this.db.tx(() => {
      this.db
        .q(
          'INSERT INTO trash (id, name, orig_path, file, deleted_at, size, mime, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(tid, n.name, n.path, file, Math.floor(Date.now() / 1000), n.size, n.mime, meta);
      this.db.q('DELETE FROM nodes WHERE id = ?').run(n.id);
    });
    this.ctx.previews.remove(n.id);
    return tid;
  }

  /** Path of a trashed item; null for a row that never got its file. */
  trashFile(t) {
    if (!t?.file || t.file.includes('/') || t.file.includes('\\')) return null;
    const f = path.join(this.trashDir, t.file);
    if (fs.existsSync(f)) return f;
    const legacy = path.join(this.legacyTrashDir, t.file);
    return fs.existsSync(legacy) ? legacy : null;
  }

  async restore(tid, toRel) {
    const t = this.db.q('SELECT * FROM trash WHERE id = ?').get(Number(tid) | 0);
    if (!t) throw notFound('Not in trash');
    const src = this.trashFile(t);
    if (!src) {
      this.db.q('DELETE FROM trash WHERE id = ?').run(t.id);
      throw notFound('This item is no longer in the trash folder');
    }
    const rel = this.freeRel(cleanRel(toRel ?? t.orig_path));
    fs.mkdirSync(path.dirname(this.abs(rel)), { recursive: true });
    moveFs(src, this.abs(rel));
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
    const src = this.trashFile(t);
    if (src) fs.rmSync(src, { recursive: true, force: true });
    this.ctx.previews.remove(`t${t.id}`);
    this.db.q('DELETE FROM trash WHERE id = ?').run(t.id);
  }

  /** Archive is a mark in the index; a folder marks everything in it. Files never move. */
  setArchived(id, archive) {
    const n = this.mustNode(id);
    this.db
      .q('UPDATE nodes SET archived = ? WHERE id = ? OR (? = 1 AND substr(path, 1, ?) = ?)')
      .run(archive ? 1 : 0, n.id, n.dir, n.path.length + 1, `${n.path}/`);
    return n.id;
  }

  /**
   * One-time move away from Frames-made folders in the library: files older versions put in
   * <library>/.archive go back to their own folder (marked archived), and the Bin moves into <data>/trash.
   */
  migrateLegacyFolders() {
    const old = this.db
      .q('SELECT * FROM nodes WHERE dir = 0 AND substr(path, 1, ?) = ? ORDER BY path')
      .all(ARCHIVE.length + 1, `${ARCHIVE}/`);
    for (const n of old) {
      try {
        const id = this.move(n.id, this.freeRel(n.path.slice(ARCHIVE.length + 1)));
        this.db.q('UPDATE nodes SET archived = 1 WHERE id = ?').run(id ?? n.id);
      } catch (e) {
        console.error(`Could not move ${n.path} out of the archive folder:`, e?.message ?? e);
      }
    }
    const archiveDir = this.abs(ARCHIVE);
    if (
      old.length &&
      fs.existsSync(archiveDir) &&
      !fs.readdirSync(archiveDir, { recursive: true }).some((f) => !fs.statSync(path.join(archiveDir, f)).isDirectory())
    ) {
      fs.rmSync(archiveDir, { recursive: true, force: true });
      this.db
        .q('DELETE FROM nodes WHERE path = ? OR substr(path, 1, ?) = ?')
        .run(ARCHIVE, ARCHIVE.length + 1, `${ARCHIVE}/`);
    }
    if (fs.existsSync(this.legacyTrashDir)) {
      fs.mkdirSync(this.trashDir, { recursive: true });
      for (const f of fs.readdirSync(this.legacyTrashDir)) {
        try {
          moveFs(path.join(this.legacyTrashDir, f), path.join(this.trashDir, f));
        } catch (e) {
          console.error(`Could not move ${f} into the Frames Bin:`, e?.message ?? e);
        }
      }
      if (!fs.readdirSync(this.legacyTrashDir).length) fs.rmSync(this.legacyTrashDir, { recursive: true, force: true });
    }
  }
}
