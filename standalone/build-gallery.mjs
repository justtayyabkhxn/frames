// Build Gallery's web app (gallery/) into gallery/web/build, which Frames serves. Needs internet for the first install.
// Usage: node standalone/build-gallery.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, cacheEnv } from './lib/tools.mjs';
import { cli } from './lib/ui.mjs';

cli();

// Always this Node and its own corepack: an older Node installed on the PC (first on PATH) has a corepack
// that cannot run current pnpm. Its folder also goes first on PATH for everything pnpm starts.
const nodeDir = path.dirname(process.execPath);
const corepack = [
  path.join(nodeDir, 'node_modules', 'corepack', 'dist', 'corepack.js'),
  path.join(nodeDir, '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'),
].find((f) => fs.existsSync(f));
if (!corepack) throw new Error(`corepack not found next to ${process.execPath}; use Node 24 (tools/node)`);
const PATH = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';

// A pnpm cached by an older corepack can name a launcher that does not exist (pnpm 11+ ships bin/pnpm.mjs, older
// corepacks record bin/pnpm.cjs), and corepack trusts that record: drop such entries so they are fetched again
const cached = path.join(cacheEnv().COREPACK_HOME, 'v1', 'pnpm');
for (const v of fs.existsSync(cached) ? fs.readdirSync(cached) : []) {
  const dir = path.join(cached, v);
  let bins = [];
  try {
    bins = Object.values(JSON.parse(fs.readFileSync(path.join(dir, '.corepack'), 'utf8')).bin ?? {});
  } catch {}
  if (!bins.length || !bins.every((b) => fs.existsSync(path.join(dir, b))))
    fs.rmSync(dir, { recursive: true, force: true });
}

const cwd = path.join(APP_ROOT, 'gallery');
const env = {
  ...process.env,
  ...cacheEnv(),
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  [PATH]: `${nodeDir}${path.delimiter}${process.env[PATH] ?? ''}`,
};
const pnpm = (...args) => execFileSync(process.execPath, [corepack, 'pnpm', ...args], { cwd, env, stdio: 'inherit' });

pnpm('install', '--filter', '@immich/sdk', '--filter', 'immich-web', '--frozen-lockfile');
pnpm('--filter', '@immich/sdk', 'build');
pnpm('--filter', 'immich-web', 'build');
console.log(`Gallery UI built in ${path.join(cwd, 'web', 'build')}`);
