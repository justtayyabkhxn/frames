import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dims, takenFrom } from '../util.mjs';
import { limiter } from './previews.mjs';
import { exiftool } from './tools.mjs';

export const MIMES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  jxl: 'image/jxl',
  dng: 'image/x-dcraw',
  cr2: 'image/x-dcraw',
  cr3: 'image/x-dcraw',
  nef: 'image/x-dcraw',
  arw: 'image/x-dcraw',
  orf: 'image/x-dcraw',
  rw2: 'image/x-dcraw',
  raf: 'image/x-dcraw',
  srw: 'image/x-dcraw',
  pef: 'image/x-dcraw',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
  mts: 'video/MP2T',
  m2ts: 'video/MP2T',
  wmv: 'video/x-ms-wmv',
};
const KNOWN_MIMES = new Set(Object.values(MIMES));
export const mimeOf = (name) => MIMES[path.extname(name).slice(1).toLowerCase()] ?? null;
export const ARCHIVE = '.archive';

/** By extension, except .mts/.m2ts (also TypeScript modules): those need MPEG-TS sync bytes, 188 or 192 apart. */
export function isMedia(abs) {
  if (!mimeOf(abs)) return false;
  if (!/\.m2?ts$/i.test(abs)) return true;
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const b = Buffer.alloc(197);
    fs.readSync(fd, b, 0, 197, 0);
    return (b[0] === 0x47 && b[188] === 0x47) || (b[4] === 0x47 && b[196] === 0x47);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const EXIF_TAGS = [
  'DateTimeOriginal',
  'CreateDate',
  'MediaCreateDate',
  'OffsetTimeOriginal',
  'OffsetTime',
  'DateTimeEpoch',
  'LocationTZID',
  'Make',
  'Model',
  'LensModel',
  'CameraType',
  'SerialNumber',
  'FNumber',
  'ApertureValue',
  'FocalLength',
  'ISO',
  'ShutterSpeedValue',
  'ShutterSpeed',
  'ExposureTime',
  'WhiteBalance',
  'ColorSpace',
  'Aperture',
  'ImageUniqueID',
  'GPSLatitude',
  'GPSLongitude',
  'GPSAltitude',
  'Megapixels',
  'Rotation',
  'Orientation',
  'Title',
  'Description',
  'Label',
  'Artist',
  'Copyright',
  'Rating',
  'FOV',
  'ExifVersion',
  'Duration',
  'FrameRate',
  'VideoCodec',
  'ImageWidth',
  'ImageHeight',
  'MIMEType',
  'ContentIdentifier',
  'MotionPhoto',
  'MicroVideo',
  'ProjectionType',
];

const etagOf = (size, mtime) => `${mtime.toString(16)}${size.toString(16)}`;
const OFFSET = /^([+-])(\d\d):?(\d\d)$/;

/** Turn exiftool output into a media row. */
export function mediaRow(meta, mtimeSec, mime) {
  const taken = Date.parse(`${takenFrom(meta, mtimeSec * 1000)}Z`) / 1000;
  const off = OFFSET.exec(meta.OffsetTimeOriginal ?? meta.OffsetTime ?? '');
  const epoch = off
    ? taken - (off[1] === '-' ? -1 : 1) * (+off[2] * 3600 + +off[3] * 60)
    : meta.DateTimeEpoch | 0 || taken;
  const [w, h] = dims(meta);
  const isvideo = mime?.startsWith('video/') ? 1 : 0;
  const motion = !isvideo && (+meta.MotionPhoto === 1 || +meta.MicroVideo === 1);
  const exif = Object.fromEntries(
    Object.entries(meta).filter(([k, v]) => EXIF_TAGS.includes(k) && v !== '' && v != null),
  );
  return {
    datetaken: taken,
    dayid: Math.floor(taken / 86400),
    epoch,
    w,
    h,
    isvideo,
    video_duration: isvideo ? Math.round(+meta.Duration || 0) : 0,
    liveid: motion ? 'self__trailer' : meta.ContentIdentifier ? String(meta.ContentIdentifier) : null,
    pano: meta.ProjectionType === 'equirectangular' ? 1 : 0,
    lat: Number.isFinite(meta.GPSLatitude) ? meta.GPSLatitude : null,
    lon: Number.isFinite(meta.GPSLongitude) ? meta.GPSLongitude : null,
    exif: JSON.stringify(exif),
  };
}

export class Indexer {
  status = { phase: 'idle', found: 0, done: 0, total: 0, error: '' };

  constructor(ctx) {
    this.ctx = ctx;
    this.db = ctx.db;
    this.thumbs = limiter(Math.max(2, Math.floor(os.cpus().length / 2)));
  }

  /** Ensure a node exists for this relative path (and its parents); returns its id. */
  ensureNode(rel, { dir, size = 0, mtime = 0 }) {
    const { db } = this;
    const parent =
      rel === ''
        ? null
        : this.ensureNode(path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel), { dir: true });
    const name = rel === '' ? '' : path.posix.basename(rel);
    const existing = db.q('SELECT id, size, mtime, dir FROM nodes WHERE path = ?').get(rel);
    if (existing && (dir || (existing.size === size && existing.mtime === mtime))) return existing.id;
    return db
      .q(
        `
      INSERT INTO nodes (id, path, parent, name, dir, size, mtime, etag, mime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (path) DO UPDATE SET parent = excluded.parent, name = excluded.name, dir = excluded.dir,
        size = excluded.size, mtime = excluded.mtime, etag = excluded.etag, mime = excluded.mime
      RETURNING id`,
      )
      .get(
        existing?.id ?? db.nextId('nodes'),
        rel,
        parent,
        name,
        dir ? 1 : 0,
        size,
        mtime,
        dir ? '' : etagOf(size, mtime),
        dir ? null : mimeOf(name),
      ).id;
  }

  /** Yields folders and media files; unreadable entries yield { keep } so the scan never deletes them. */
  async *walk(abs, rel) {
    const entries = await fsp.readdir(abs, { withFileTypes: true }).catch(() => null);
    if (!entries) return yield { rel, keep: true };
    if (entries.some((e) => e.name === '.nomedia' || e.name === '.nomemories')) return;
    yield { rel, dir: true };
    for (const e of entries) {
      if (e.name.startsWith('.') && !(rel === '' && e.name === ARCHIVE)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(abs, e.name);
      // Frames' own data (thumbnails, caches) can sit inside the library
      if (e.isDirectory() && path.relative(childAbs, this.ctx.dataDir ?? '') === '') continue;
      if (e.isDirectory()) yield* this.walk(childAbs, childRel);
      else if (e.isFile() && isMedia(childAbs)) {
        const s = await fsp.stat(childAbs).catch(() => null);
        yield s
          ? { rel: childRel, dir: false, size: s.size, mtime: Math.floor(s.mtimeMs / 1000) }
          : { rel: childRel, keep: true };
      }
    }
  }

  async readMeta(absPaths) {
    const { out } = await exiftool(this.ctx.et, [
      '-json',
      '-n',
      '-api',
      'QuickTimeUTC',
      '-api',
      'LargeFileSupport=1',
      ...EXIF_TAGS.map((t) => `-${t}`),
      ...absPaths,
    ]);
    try {
      return new Map(JSON.parse(out.toString('utf8')).map((m) => [path.resolve(m.SourceFile), m]));
    } catch {
      return new Map();
    }
  }

  saveMedia(id, row) {
    this.db
      .q(
        `
      INSERT INTO media (id, datetaken, dayid, epoch, w, h, isvideo, video_duration, liveid, pano, lat, lon, exif, indexed_at)
      VALUES (:id, :datetaken, :dayid, :epoch, :w, :h, :isvideo, :video_duration, :liveid, :pano, :lat, :lon, :exif, :indexed_at)
      ON CONFLICT (id) DO UPDATE SET datetaken = excluded.datetaken, dayid = excluded.dayid, epoch = excluded.epoch,
        w = excluded.w, h = excluded.h, isvideo = excluded.isvideo, video_duration = excluded.video_duration,
        liveid = excluded.liveid, pano = excluded.pano, lat = excluded.lat, lon = excluded.lon, exif = excluded.exif,
        indexed_at = excluded.indexed_at`,
      )
      .run({ ...row, id, indexed_at: Math.floor(Date.now() / 1000) });
  }

  /** Read metadata + make previews for these node ids. */
  async indexIds(ids, onDone = () => {}) {
    const { db, ctx } = this;
    for (let i = 0; i < ids.length; i += 100) {
      const nodes = ids
        .slice(i, i + 100)
        .map((id) => db.q('SELECT * FROM nodes WHERE id = ?').get(id))
        .filter(Boolean);
      const meta = await this.readMeta(nodes.map((n) => ctx.abs(n.path)));
      // Only a re-index (changed file) has stale thumbnails; a first index keeps ones made on demand meanwhile
      const reindexed = new Set(
        nodes.filter((n) => db.q('SELECT 1 FROM media WHERE id = ?').get(n.id)).map((n) => n.id),
      );
      const liveids = [];
      db.tx(() => {
        for (const n of nodes) {
          const m = meta.get(path.resolve(ctx.abs(n.path))) ?? {};
          // Only trust known media types: a script disguised as .jpg must never be served as SVG/XML
          const mime = KNOWN_MIMES.has(m.MIMEType) ? m.MIMEType : n.mime;
          if (mime !== n.mime) db.q('UPDATE nodes SET mime = ? WHERE id = ?').run(mime, n.id);
          const row = mediaRow(m, n.mtime, mime);
          if (row.liveid) liveids.push(row.liveid);
          this.saveMedia(n.id, row);
        }
      });
      this.linkLivePhotos(liveids);
      await Promise.all(
        nodes.map((n) =>
          this.thumbs(async () => {
            // One file's thumbnails failing (locked, unreadable) must not stop the rest; they are made on demand later
            try {
              if (reindexed.has(n.id)) ctx.previews.remove(n.id);
              await ctx.previews.generate(n.id, ctx.abs(n.path), mimeOf(n.name)?.startsWith('video/'));
            } catch (e) {
              console.warn(`Thumbnails for ${n.path}: ${e.message}`);
            }
            onDone(n);
          }),
        ),
      );
    }
  }

  /** Hide the video half of Apple live photos (only for the given liveids); the photo keeps the liveid. */
  linkLivePhotos(liveids) {
    for (const l of new Set(liveids)) {
      if (l === 'self__trailer') continue;
      this.db
        .q(
          `UPDATE media SET livevideo = EXISTS (
            SELECT 1 FROM media p JOIN nodes pn ON pn.id = p.id
            WHERE p.liveid = :l AND p.isvideo = 0 AND pn.parent = (SELECT parent FROM nodes WHERE id = media.id))
          WHERE liveid = :l AND isvideo = 1`,
        )
        .run({ l });
    }
  }

  /** Un-hide companion videos whose photo is gone (cheap: only rows currently hidden). */
  unlinkOrphanLiveVideos() {
    this.db.exec(`
      UPDATE media SET livevideo = 0 WHERE livevideo = 1 AND NOT EXISTS (
        SELECT 1 FROM media p WHERE p.liveid = media.liveid AND p.isvideo = 0)`);
  }

  async scan() {
    if (this.status.phase !== 'idle') return;
    const { db, ctx, status } = this;
    Object.assign(status, { phase: 'scanning', found: 0, done: 0, total: 0, error: '' });
    try {
      const seen = new Set();
      const keep = [];
      const todo = [];
      for await (const e of this.walk(ctx.root, '')) {
        if (e.keep) {
          keep.push(e.rel);
          continue;
        }
        const before = e.dir
          ? null
          : db
              .q(
                'SELECT n.id, n.size, n.mtime, m.id AS indexed FROM nodes n LEFT JOIN media m ON m.id = n.id WHERE n.path = ?',
              )
              .get(e.rel);
        const id = this.ensureNode(e.rel, e);
        seen.add(id);
        if (e.dir) continue;
        status.found++;
        if (!before?.indexed || before.size !== e.size || before.mtime !== e.mtime) todo.push(id);
      }
      const kept = (p) => keep.some((k) => !k || p === k || p.startsWith(`${k}/`));
      for (const { id, path: p } of db.q('SELECT id, path FROM nodes').all()) {
        if (seen.has(id) || kept(p)) continue;
        db.q('DELETE FROM nodes WHERE id = ?').run(id);
        ctx.previews.remove(id);
      }
      this.unlinkOrphanLiveVideos();
      if (keep.length)
        console.warn(`Could not read ${keep.length} item(s); kept their index entries: ${keep.slice(0, 5).join(', ')}`);
      Object.assign(status, { phase: 'indexing', total: todo.length });
      await this.indexIds(todo, () => status.done++);
    } catch (e) {
      status.error = String(e?.message ?? e);
      console.error(e);
    }
    status.phase = 'idle';
    this.ctx.onIndexed?.();
    console.log(`Index ready: ${db.q('SELECT count(*) AS n FROM media').get().n} items.`);
  }

  /** Index (or re-index) a single file by relative path, e.g. after upload or move. */
  async indexPath(rel) {
    const s = fs.statSync(this.ctx.abs(rel), { throwIfNoEntry: false });
    if (!s?.isFile() || !isMedia(this.ctx.abs(rel))) return null;
    const id = this.ensureNode(rel, { dir: false, size: s.size, mtime: Math.floor(s.mtimeMs / 1000) });
    await this.indexIds([id]);
    this.ctx.onIndexed?.();
    return id;
  }
}
