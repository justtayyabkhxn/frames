// Fetch the portable tools Frames bundles into tools/: Node.js, exiftool, ffmpeg.
// Idempotent; every download is verified against the publisher's checksum.
// Usage: node standalone/setup.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { downloadPlanet, PLANET_ZIP } from './lib/places-data.mjs';
import { findExiftool, TOOLS } from './lib/tools.mjs';

if (process.platform !== 'win32') {
  console.log('Portable tool setup is Windows-only. Install node 24+, exiftool and ffmpeg with your package manager.');
  process.exit(0);
}

const tar = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Download zipUrl, check sha256, extract, move the single top folder to tools/<name>. */
async function install(name, zipUrl, expectedSha) {
  const dest = path.join(TOOLS, name);
  if (fs.existsSync(dest)) return console.log(`${name}: present`);
  console.log(`${name}: downloading ${zipUrl}`);
  const buf = await download(zipUrl);
  if (sha256(buf) !== expectedSha) throw new Error(`${name}: checksum mismatch`);
  const tmp = path.join(TOOLS, `${name}-tmp`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'pkg.zip'), buf);
  execFileSync(tar, ['-xf', 'pkg.zip'], { cwd: tmp });
  fs.rmSync(path.join(tmp, 'pkg.zip'));
  const [top] = fs.readdirSync(tmp);
  fs.renameSync(path.join(tmp, top), dest);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${name}: installed`);
}

fs.mkdirSync(TOOLS, { recursive: true });

// Node.js 24 LTS (latest patch)
const index = JSON.parse((await download('https://nodejs.org/dist/index.json')).toString());
const nodeVer = index.find((r) => r.version.startsWith('v24.') && r.lts).version;
const nodeZip = `node-${nodeVer}-win-x64.zip`;
const nodeSums = (await download(`https://nodejs.org/dist/${nodeVer}/SHASUMS256.txt`)).toString();
await install(
  'node',
  `https://nodejs.org/dist/${nodeVer}/${nodeZip}`,
  nodeSums
    .split('\n')
    .find((l) => l.endsWith(nodeZip))
    .split(/\s+/)[0],
);

// exiftool (pinned + checksum in lib/tools.mjs)
console.log(`exiftool: ${await findExiftool()}`);

// ffmpeg (gyan.dev release essentials build, GPL)
const ffBase = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const ffSha = (await download(`${ffBase}.sha256`)).toString().trim().split(/\s+/)[0];
await install('ffmpeg', ffBase, ffSha);

// Place names for photos with GPS (OpenStreetMap boundaries, ODbL)
await downloadPlanet();
console.log(`places: ${PLANET_ZIP}`);

console.log('Tools ready in', TOOLS);
