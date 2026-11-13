// Build Gallery's web app (gallery/) into gallery/web/build, which Frames serves. Needs internet for the first install.
// Usage: node standalone/build-gallery.mjs
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { APP_ROOT } from './lib/tools.mjs';

const cwd = path.join(APP_ROOT, 'gallery');
const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
const pnpm = (...args) =>
  execFileSync(process.platform === 'win32' ? 'corepack.cmd' : 'corepack', ['pnpm', ...args], {
    cwd,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

pnpm('install', '--filter', '@immich/sdk', '--filter', 'immich-web', '--frozen-lockfile');
pnpm('--filter', '@immich/sdk', 'build');
pnpm('--filter', 'immich-web', 'build');
console.log(`Gallery UI built in ${path.join(cwd, 'web', 'build')}`);
