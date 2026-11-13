import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP_ROOT = path.resolve(import.meta.dirname, '..', '..');
export const TOOLS = path.join(APP_ROOT, 'tools');
/** Caches of the tools Frames runs (AI libraries, package managers) stay inside the Frames folder. */
export const CACHE = path.join(TOOLS, 'cache');
export const cacheEnv = () => ({
  XDG_CACHE_HOME: CACHE,
  HF_HOME: path.join(CACHE, 'huggingface'),
  TORCH_HOME: path.join(CACHE, 'torch'),
  PIP_CACHE_DIR: path.join(CACHE, 'pip'),
  COREPACK_HOME: path.join(CACHE, 'corepack'),
  npm_config_cache: path.join(CACHE, 'npm'),
  npm_config_store_dir: path.join(CACHE, 'pnpm-store'),
});
/** Gallery's web app, built by standalone/build-gallery.mjs; served at / */
export const GALLERY_BUILD = path.join(APP_ROOT, 'gallery', 'web', 'build');

const ET_VER = '13.63';
const ET_SHA256 = '7a4bff4b1d6ee15adef882837847f76c0ed23228d294feed285939b6c9b293bd';

const works = (cmd, arg) => spawnSync(cmd, [arg], { windowsHide: true, stdio: 'ignore' }).status === 0;
const firstExisting = (...files) => files.find((f) => fs.existsSync(f));

/** Run a process, collecting stdout. Never rejects. */
export function run(cmd, args, { input } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    const out = [];
    const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => resolve({ code: -1, out: Buffer.alloc(0), err: String(e) }));
    p.on('close', (code) => resolve({ code, out: Buffer.concat(out), err: Buffer.concat(err).toString() }));
    if (input != null) p.stdin.end(input);
  });
}

/**
 * Run exiftool with every argument in a UTF-8 argfile. Windows hands command-line
 * arguments to exiftool (Perl) in the ANSI code page, which mangles non-ASCII paths and values.
 */
export async function exiftool(et, args) {
  const file = path.join(os.tmpdir(), `frames-et-${randomUUID()}.txt`);
  const escape = args.some((a) => /[\r\n]/.test(a));
  const lines = escape ? args.map((a) => a.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/\r/g, '')) : args;
  fs.writeFileSync(file, lines.join('\n'));
  try {
    return await run(et, ['-charset', 'filename=utf8', ...(escape ? ['-ec'] : []), '-@', file]);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** exiftool: bundled tools/exiftool, then PATH; on Windows fetched once (checksum-verified). */
export async function findExiftool() {
  const local = path.join(TOOLS, 'exiftool', 'exiftool.exe');
  if (fs.existsSync(local)) return local;
  if (works('exiftool', '-ver')) return 'exiftool';
  if (process.platform !== 'win32')
    throw new Error('exiftool not found. Install it (apt install libimage-exiftool-perl / brew install exiftool).');

  console.log(`One-time setup: downloading exiftool ${ET_VER}...`);
  const res = await fetch(`https://sourceforge.net/projects/exiftool/files/exiftool-${ET_VER}_64.zip/download`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (createHash('sha256').update(buf).digest('hex') !== ET_SHA256)
    throw new Error('exiftool download failed (checksum mismatch)');
  const tmp = path.join(TOOLS, 'exiftool-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'et.zip'), buf);
  execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', 'et.zip'], { cwd: tmp });
  fs.renameSync(path.join(tmp, `exiftool-${ET_VER}_64`), path.dirname(local));
  // The "(-k)" name makes exiftool wait for Enter on exit.
  fs.renameSync(path.join(path.dirname(local), 'exiftool(-k).exe'), local);
  fs.rmSync(tmp, { recursive: true, force: true });
  return local;
}

/** ffmpeg + ffprobe: bundled tools/ffmpeg, then PATH. */
export function findFfmpeg() {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const bundled = firstExisting(path.join(TOOLS, 'ffmpeg', 'bin', `ffmpeg${exe}`));
  if (bundled) return { ffmpeg: bundled, ffprobe: path.join(path.dirname(bundled), `ffprobe${exe}`) };
  if (works('ffmpeg', '-version')) return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  return null;
}
