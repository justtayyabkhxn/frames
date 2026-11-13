// Fetch the portable tools Frames bundles into tools/: Node.js, exiftool, ffmpeg.
// Idempotent; every download is verified against the publisher's checksum.
// Usage: node standalone/setup.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { downloadPlanet } from './lib/places-data.mjs';
import { findExiftool, TOOLS } from './lib/tools.mjs';
import { cli, download, ok } from './lib/ui.mjs';

cli();
if (process.platform !== 'win32') {
  console.log('Portable tool setup is Windows-only. Install node 24+, exiftool and ffmpeg with your package manager.');
  process.exit(0);
}

const tar = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const text = async (url, what) => (await download(url, what, { quiet: true })).toString();

/** Download zipUrl, check sha256, extract, move the single top folder to tools/<name>. */
async function install(name, zipUrl, expectedSha) {
  const dest = path.join(TOOLS, name);
  if (fs.existsSync(dest)) return ok(`${name} already here`);
  const buf = await download(zipUrl, name);
  if (sha256(buf) !== expectedSha) throw new Error(`${name}: download is corrupt (checksum mismatch), try again`);
  const tmp = path.join(TOOLS, `${name}-tmp`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'pkg.zip'), buf);
  execFileSync(tar, ['-xf', 'pkg.zip'], { cwd: tmp });
  fs.rmSync(path.join(tmp, 'pkg.zip'));
  const [top] = fs.readdirSync(tmp);
  fs.renameSync(path.join(tmp, top), dest);
  fs.rmSync(tmp, { recursive: true, force: true });
  ok(`${name} installed`);
}

fs.mkdirSync(TOOLS, { recursive: true });

// Node.js 24 LTS (latest patch); frames.cmd normally fetched it already
if (!fs.existsSync(path.join(TOOLS, 'node'))) {
  const sums = await text('https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt', 'Node.js checksums');
  const [sha, zip] = sums
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([, f]) => /^node-v24[\d.]+-win-x64\.zip$/.test(f ?? ''));
  await install('node', `https://nodejs.org/dist/${zip.match(/v24[\d.]+\d/)[0]}/${zip}`, sha);
}

// exiftool (pinned + checksum in lib/tools.mjs)
await findExiftool();
ok('exiftool ready');

// ffmpeg: BtbN's GitHub builds (GPL) of the newest stable release; GitHub is far faster and more reliable than
// gyan.dev. The "shared" build (exes + DLLs side by side) is less than half the size of the static one.
const FF = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';
const ver = (f) =>
  f
    .match(/-n(\d+)\.(\d+)/)
    .slice(1)
    .map(Number);
const [ffSha, ffZip] = (await text(`${FF}/checksums.sha256`, 'ffmpeg checksums'))
  .split('\n')
  .map((l) => l.trim().split(/\s+/))
  .filter(([, f]) => /^ffmpeg-n[\d.]+-latest-win64-gpl-shared-[\d.]+\.zip$/.test(f ?? ''))
  .sort(([, a], [, b]) => ver(b)[0] - ver(a)[0] || ver(b)[1] - ver(a)[1])[0];
await install('ffmpeg', `${FF}/${ffZip}`, ffSha);

// Place names for photos with GPS (OpenStreetMap boundaries, ODbL)
await downloadPlanet();
ok('place names ready');
