import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { registerApi } from './lib/api.mjs';
import { registerClusters } from './lib/clusters.mjs';
import { registerDav } from './lib/dav.mjs';
import { registerAi } from './lib/ai.mjs';
import { registerMap } from './lib/map.mjs';
import { registerMedia } from './lib/media.mjs';
import { openDb } from './lib/db.mjs';
import { HttpError, json, Router, sendFile } from './lib/http.mjs';
import { Indexer } from './lib/indexer.mjs';
import { Library } from './lib/library.mjs';
import { Previews } from './lib/previews.mjs';
import { renderShell } from './lib/shell.mjs';
import { APP_ROOT, findExiftool, findFfmpeg } from './lib/tools.mjs';

const DATA = process.env.FRAMES_DATA
  ? path.resolve(process.env.FRAMES_DATA)
  : path.join(APP_ROOT, 'standalone', 'data');
const CONFIG = path.join(DATA, 'config.json');
const JS = process.env.FRAMES_JS ? path.resolve(process.env.FRAMES_JS) : path.join(APP_ROOT, 'js');
const PORT = Number(process.env.PORT) || 7310;
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);

fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(path.join(JS, 'memories-main.js'))) {
  console.error('The web interface is not built yet. Run: npm run build');
  process.exit(1);
}

async function askRoot() {
  let dir = arg('--dir') ?? JSON.parse(fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8') : '{}').dir;
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

const locale = Intl.DateTimeFormat().resolvedOptions().locale;
const ctx = {
  version: JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version,
  uid: 'me',
  displayName: os.userInfo().username,
  token: randomBytes(24).toString('hex'),
  buildId: fs.statSync(path.join(JS, 'memories-main.js')).mtimeMs.toString(36),
  language: locale.split('-')[0],
  locale: locale.replace('-', '_'),
  dataDir: DATA,
  root: await askRoot(),
  et: await findExiftool(),
  ff: findFfmpeg(),
  dayFilters: [],
  clustersOf: {},
};
if (!ctx.ff) console.warn('ffmpeg not found: thumbnails and video previews will be missing.');
ctx.db = openDb(path.join(DATA, 'frames.db'));
ctx.lib = new Library(ctx);
ctx.abs = (rel) => ctx.lib.abs(rel);
ctx.previews = new Previews({ dir: path.join(DATA, 'previews'), ff: ctx.ff, et: ctx.et });
ctx.indexer = new Indexer(ctx);

// A different library folder than last time: start from a clean index
if (ctx.db.getKv('root') !== ctx.root) {
  ctx.db.exec('DELETE FROM nodes; DELETE FROM trash;');
  fs.rmSync(path.join(DATA, 'previews'), { recursive: true, force: true });
  ctx.db.setKv('root', ctx.root);
}

const router = new Router();
registerApi(router, ctx);
registerClusters(router, ctx);
registerMap(router, ctx);
registerMedia(router, ctx);
registerAi(router, ctx);
registerDav(router, ctx);

const shell = () => renderShell(ctx);
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS', 'PROPFIND']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    // Only answer to localhost names (blocks DNS rebinding from other sites)
    if (!ALLOWED_HOSTS.has(req.headers.host)) throw new HttpError(403, 'Forbidden host');
    // State changes need the page's token (blocks cross-site requests)
    const sameOrigin = req.headers['sec-fetch-site'] === 'same-origin' || req.headers.requesttoken === ctx.token;
    if (!SAFE.has(req.method) && !sameOrigin) throw new HttpError(403, 'Cross-site request blocked');
    // No offline caching worker: serve an empty one so registration succeeds quietly
    if (p === '/apps/memories/static/service-worker.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript',
        'Service-Worker-Allowed': '/',
        'Cache-Control': 'no-store',
      });
      return res.end('// Frames: no service worker cache');
    }

    if (p === '/' || p === '/apps/memories') return res.writeHead(302, { Location: '/apps/memories/' }).end();
    if (p.startsWith('/apps/memories/js/'))
      return sendFile(req, res, path.join(JS, path.basename(p)), {
        type: p.endsWith('.js') ? 'text/javascript' : undefined,
        cache: 'no-cache',
      });
    if (p.startsWith('/apps/memories/img/'))
      return sendFile(req, res, path.join(APP_ROOT, 'img', path.basename(p)), { type: 'image/svg+xml' });
    const m = router.match(req.method, p);
    if (m) return await m.fn(req, res, m.params, url);
    if (req.method === 'GET' && p.startsWith('/apps/memories/') && !p.startsWith('/apps/memories/api/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(shell());
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(req.method, p, e);
    if (res.headersSent) return res.destroy();
    json(res, { message: e.message }, e.status ?? 500);
  }
});

const appUrl = `http://localhost:${PORT}/apps/memories/`;
const openBrowser = () => {
  const [cmd, args] = { win32: ['cmd', ['/c', 'start', '', appUrl]], darwin: ['open', [appUrl]] }[process.platform] ?? [
    'xdg-open',
    [appUrl],
  ];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
};
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.log(`Port ${PORT} is busy (Frames already running?). Opening ${appUrl}`);
  openBrowser();
  process.exit(0);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Frames: ${ctx.root}\nOpen ${appUrl} (Ctrl+C to stop)`);
  if (!process.argv.includes('--no-open')) openBrowser();
  void ctx.indexer.scan();
});
