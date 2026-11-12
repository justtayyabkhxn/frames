import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { DatabaseSync } from 'node:sqlite';
import { dims, parseRange, takenFrom } from './util.mjs';

const HERE = import.meta.dirname;
const DATA = path.join(HERE, 'data');
const THUMBS = path.join(DATA, 'thumbs');
const BIN = path.join(HERE, 'bin');
const CONFIG = path.join(DATA, 'config.json');
const PORT = Number(process.env.PORT) || 7310;
const MEDIA = /\.(jpe?g|png|gif|webp|heic|heif|avif|tiff?|bmp|dng|cr2|cr3|nef|arw|orf|rw2|raf|mp4|mov|m4v|webm|mkv|avi|3gp)$/i;
const TAGS = ['DateTimeOriginal', 'CreateDate', 'MediaCreateDate', 'ImageWidth', 'ImageHeight', 'Orientation', 'Rotation']
  .concat(['GPSLatitude', 'GPSLongitude', 'Make', 'Model', 'MIMEType', 'Duration'])
  .map((t) => `-${t}`);
const ET_VER = '13.63';
const ET_SHA256 = '7a4bff4b1d6ee15adef882837847f76c0ed23228d294feed285939b6c9b293bd';

fs.mkdirSync(THUMBS, { recursive: true });

const works = (cmd, arg) => spawnSync(cmd, [arg], { windowsHide: true, stdio: 'ignore' }).status === 0;

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    const out = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.resume();
    p.on('error', () => resolve({ code: -1, out: Buffer.alloc(0) }));
    p.on('close', (code) => resolve({ code, out: Buffer.concat(out) }));
  });
}

/** exiftool from bin/ or PATH; on Windows fetched once (checksum-verified) if missing. */
async function findExiftool() {
  const local = path.join(BIN, `exiftool-${ET_VER}_64`, 'exiftool.exe');
  if (fs.existsSync(local)) return local;
  if (works('exiftool', '-ver')) return 'exiftool';
  if (process.platform !== 'win32') throw new Error('exiftool not found. Install it (apt install libimage-exiftool-perl / brew install exiftool).');

  console.log(`One-time setup: downloading exiftool ${ET_VER}...`);
  const res = await fetch(`https://sourceforge.net/projects/exiftool/files/exiftool-${ET_VER}_64.zip/download`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (createHash('sha256').update(buf).digest('hex') !== ET_SHA256) throw new Error('exiftool download failed (checksum mismatch)');
  fs.mkdirSync(BIN, { recursive: true });
  const zip = path.join(BIN, 'exiftool.zip');
  fs.writeFileSync(zip, buf);
  execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', zip, '-C', BIN]);
  fs.rmSync(zip);
  // The "(-k)" name makes exiftool wait for Enter on exit.
  fs.renameSync(path.join(path.dirname(local), 'exiftool(-k).exe'), local);
  return local;
}

async function askRoot() {
  const i = process.argv.indexOf('--dir');
  let dir = i > 0 ? process.argv[i + 1] : JSON.parse(fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8') : '{}').dir;
  while (!dir || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    if (dir) console.log(`Not a folder: ${dir}`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    dir = (await rl.question('Which folder holds your photos? ')).trim().replace(/^"(.*)"$/, '$1');
    rl.close();
  }
  dir = path.resolve(dir);
  fs.writeFileSync(CONFIG, JSON.stringify({ dir }, null, 2));
  return dir;
}

const ET = await findExiftool();
const FFMPEG = works('ffmpeg', '-version') ? 'ffmpeg' : null;
const ROOT = await askRoot();

const db = new DatabaseSync(path.join(DATA, 'frames.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL,
    taken TEXT NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL, video INTEGER NOT NULL, duration REAL,
    mime TEXT, lat REAL, lon REAL, make TEXT, model TEXT);
  CREATE INDEX IF NOT EXISTS files_taken ON files (taken);
`);
const q = {
  find: db.prepare('SELECT mtime, size FROM files WHERE path = ?'),
  upsert: db.prepare(`
    INSERT INTO files (path, mtime, size, taken, w, h, video, duration, mime, lat, lon, make, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, taken = excluded.taken,
      w = excluded.w, h = excluded.h, video = excluded.video, duration = excluded.duration, mime = excluded.mime,
      lat = excluded.lat, lon = excluded.lon, make = excluded.make, model = excluded.model
    RETURNING id`),
  ids: db.prepare('SELECT id, path FROM files'),
  del: db.prepare('DELETE FROM files WHERE id = ?'),
  count: db.prepare('SELECT count(*) AS n FROM files'),
  photos: db.prepare('SELECT id, taken, w, h, video, duration FROM files ORDER BY taken DESC, id DESC'),
  get: db.prepare('SELECT * FROM files WHERE id = ?'),
};
const thumbPath = (id) => path.join(THUMBS, `${id}.jpg`);

const status = { phase: 'idle', found: 0, done: 0, total: 0, error: '' };

async function* walk(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  if (entries.some((e) => e.name === '.nomedia' || e.name === '.nomemories')) return;
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && MEDIA.test(e.name)) {
      const s = await fsp.stat(p).catch(() => null);
      if (s) yield { path: p, mtime: Math.floor(s.mtimeMs), size: s.size };
    }
  }
}

async function readMeta(paths) {
  const argfile = path.join(DATA, 'exiftool-args.txt');
  fs.writeFileSync(argfile, paths.join('\n'));
  const { out } = await run(ET, ['-json', '-n', '-charset', 'filename=utf8', '-api', 'QuickTimeUTC', '-api', 'LargeFileSupport=1', ...TAGS, '-@', argfile]);
  try {
    return new Map(JSON.parse(out.toString('utf8')).map((m) => [path.resolve(m.SourceFile), m]));
  } catch {
    return new Map();
  }
}

async function makeThumb(id, file) {
  const out = thumbPath(id);
  if (FFMPEG && (await run(FFMPEG, ['-v', 'error', '-y', '-i', file, '-frames:v', '1', '-vf', 'scale=-2:360', '-q:v', '4', out])).code === 0) return;
  fs.rmSync(out, { force: true });
  for (const tag of ['-PreviewImage', '-ThumbnailImage']) {
    const { out: buf } = await run(ET, ['-b', tag, file]);
    if (buf.length) return fs.writeFileSync(out, buf);
  }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

async function scan() {
  if (status.phase !== 'idle') return;
  Object.assign(status, { phase: 'scanning', found: 0, done: 0, total: 0, error: '' });
  try {
    const seen = new Set();
    const todo = [];
    for await (const f of walk(ROOT)) {
      seen.add(f.path);
      status.found++;
      const row = q.find.get(f.path);
      if (!row || row.mtime !== f.mtime || row.size !== f.size) todo.push(f);
    }
    for (const r of q.ids.all()) {
      if (seen.has(r.path)) continue;
      q.del.run(r.id);
      fs.rmSync(thumbPath(r.id), { force: true });
    }

    Object.assign(status, { phase: 'indexing', total: todo.length });
    const workers = Math.max(2, Math.floor(os.cpus().length / 2));
    // ponytail: one exiftool process per 100 files; use -stay_open if startup cost ever dominates.
    for (let i = 0; i < todo.length; i += 100) {
      const batch = todo.slice(i, i + 100);
      const meta = await readMeta(batch.map((f) => f.path));
      const made = batch.map((f) => {
        const m = meta.get(path.resolve(f.path)) ?? {};
        const mime = m.MIMEType ?? null;
        const [w, h] = dims(m);
        const { id } = q.upsert.get(f.path, f.mtime, f.size, takenFrom(m, f.mtime), w, h, mime?.startsWith('video/') ? 1 : 0,
          m.Duration ?? null, mime, m.GPSLatitude ?? null, m.GPSLongitude ?? null, m.Make ?? null, m.Model ?? null);
        return { id, path: f.path };
      });
      await pool(made, workers, async (f) => {
        await makeThumb(f.id, f.path);
        status.done++;
      });
    }
  } catch (e) {
    status.error = String(e?.message ?? e);
    console.error(e);
  }
  status.phase = 'idle';
  console.log(`Index ready: ${q.count.get().n} items.`);
}

function sendFile(req, res, file, type) {
  const size = fs.statSync(file).size;
  const r = parseRange(req.headers.range, size);
  if (r === false) return res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
  const { start, end } = r ?? { start: 0, end: size - 1 };
  res.writeHead(r ? 206 : 200, {
    'Content-Type': type || 'application/octet-stream',
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    ...(r && { 'Content-Range': `bytes ${start}-${end}/${size}` }),
  });
  fs.createReadStream(file, { start, end }).pipe(res);
}

const json = (res, data) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const [, api, what, idStr] = url.pathname.split('/');
  const row = idStr ? q.get.get(Number(idStr) | 0) : null;
  try {
    if (url.pathname === '/') return sendFile(req, res, path.join(HERE, 'index.html'), 'text/html; charset=utf-8');
    if (api !== 'api') return res.writeHead(404).end();
    if (what === 'status') return json(res, { ...status, dir: ROOT, count: q.count.get().n });
    if (what === 'photos') return json(res, q.photos.all().map((p) => [p.id, p.taken, p.w, p.h, p.video, p.duration]));
    if (what === 'rescan' && req.method === 'POST') return scan(), json(res, { ok: true });
    if (!row || !fs.existsSync(row.path)) return res.writeHead(404).end();
    if (what === 'info') return json(res, row);
    if (what === 'file') return sendFile(req, res, row.path, row.mime);
    if (what === 'thumb') {
      if (fs.existsSync(thumbPath(row.id))) return sendFile(req, res, thumbPath(row.id), 'image/jpeg');
      return row.video ? res.writeHead(404).end() : sendFile(req, res, row.path, row.mime);
    }
    res.writeHead(404).end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

const url = `http://localhost:${PORT}/`;
const openBrowser = () => {
  const [cmd, args] = { win32: ['cmd', ['/c', 'start', '', url]], darwin: ['open', [url]] }[process.platform] ?? ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
};

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.log(`Port ${PORT} is busy (Frames already running?). Opening ${url}`);
  openBrowser();
  process.exit(0);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Frames: ${ROOT}\nOpen ${url} (Ctrl+C to stop)`);
  if (!process.argv.includes('--no-open')) openBrowser();
  scan();
});
