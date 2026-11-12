// Build a self-contained, offline Frames folder in dist/Frames (and optionally a zip).
// Usage: node standalone/package.mjs [--zip]
// Needs: a production frontend build in js/ (npm run build) and tools/ prepared (standalone/setup.mjs).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, TOOLS } from './lib/tools.mjs';

const OUT = path.join(APP_ROOT, 'dist', 'Frames');
const exists = (p) => fs.existsSync(path.join(APP_ROOT, p));

if (!exists('js/memories-main.js')) throw new Error('Build the frontend first: npm run build');
if (!fs.existsSync(path.join(TOOLS, 'node'))) throw new Error('Run standalone/setup.mjs first (tools/node missing)');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const copy = (rel, filter = () => true) =>
  fs.cpSync(path.join(APP_ROOT, rel), path.join(OUT, rel), {
    recursive: true,
    filter: (src) => filter(path.relative(APP_ROOT, src).replace(/\\/g, '/')),
  });

// App code and assets (no PHP backend, sources, data or caches)
copy('standalone');
copy('js', (p) => !p.endsWith('.map'));
copy('img');
for (const f of ['package.json', 'frames.cmd', 'COPYING', 'README.md']) copy(f);
if (exists('lens') && fs.existsSync(path.join(TOOLS, 'python')))
  copy('lens', (p) => !/__pycache__|\.ruff_cache/.test(p));

// Bundled tools
for (const t of fs.readdirSync(TOOLS)) {
  if (/-tmp$/.test(t)) continue;
  fs.cpSync(path.join(TOOLS, t), path.join(OUT, 'tools', t), { recursive: true });
}
if (!fs.existsSync(path.join(OUT, 'tools', 'ffmpeg'))) {
  // Fall back to the ffmpeg on PATH (copy its bin folder)
  const where = spawnSync('where', ['ffmpeg'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0];
  if (!where) throw new Error('No ffmpeg: run standalone/setup.mjs or put ffmpeg on PATH');
  const bin = path.dirname(where);
  fs.cpSync(bin, path.join(OUT, 'tools', 'ffmpeg', 'bin'), { recursive: true });
  const lic = path.join(path.dirname(bin), 'LICENSE');
  if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(OUT, 'tools', 'ffmpeg', 'LICENSE'));
  console.log(`ffmpeg copied from ${bin}`);
}

fs.writeFileSync(
  path.join(OUT, 'START HERE.txt'),
  [
    'Frames - offline photo library',
    '',
    '1. Double-click frames.cmd',
    '2. Type the folder that holds your photos (asked only once; change later with: frames.cmd --dir "D:\\Photos")',
    '3. Your browser opens http://localhost:7310 - the first indexing can take a while; progress shows at the top.',
    '',
    'Everything runs on this computer. The index, thumbnails, AI index and settings are stored in the data folder.',
    'Your photos are only changed when you edit, move, archive or delete them in Frames (deleted items go to Frames trash).',
    '',
  ].join('\r\n'),
);

const size = (dir) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .reduce((a, e) => (e.isFile() ? a + fs.statSync(path.join(e.parentPath, e.name)).size : a), 0);
console.log(`Packaged ${OUT} (${(size(OUT) / 1e6).toFixed(0)} MB)`);

if (process.argv.includes('--zip')) {
  const zip = path.join(APP_ROOT, 'dist', 'Frames.zip');
  fs.rmSync(zip, { force: true });
  execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-a', '-cf', zip, 'Frames'], {
    cwd: path.dirname(OUT),
  });
  console.log(`Zipped ${zip} (${(fs.statSync(zip).size / 1e6).toFixed(0)} MB)`);
}
