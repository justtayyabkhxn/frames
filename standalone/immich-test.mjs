// Self-check for the Immich API that serves Gallery's web UI: node standalone/immich-test.mjs
import assert from 'node:assert/strict';
import { openDb } from './lib/db.mjs';
import { Router } from './lib/http.mjs';
import { fromUuid, toUuid } from './lib/immich/ids.mjs';
import { registerImmich } from './lib/immich/server.mjs';

assert.equal(fromUuid(toUuid('asset', 1234), 'asset'), 1234);
assert.equal(fromUuid(toUuid('person', 2 ** 52 + 7), 'person'), 2 ** 52 + 7);
assert.match(toUuid('asset', 1), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
assert.throws(() => fromUuid('not-a-uuid', 'asset'));
assert.throws(() => fromUuid(toUuid('album', 5), 'asset'));

const db = openDb(':memory:');
const ctx = { db, root: process.cwd(), dayFilters: [], clustersOf: {}, indexer: { status: {} }, displayName: 'Me' };
const router = new Router();
registerImmich(router, ctx);

export const call = async (method, p, body, headers = {}) => {
  const url = new URL(`http://x${p}`);
  const m = router.match(method, url.pathname);
  assert.ok(m, `no route for ${method} ${url.pathname}`);
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    headers,
    url: p,
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
  const res = {
    status: 200,
    headers: {},
    headersSent: false,
    writeHead(s, h) {
      this.status = s;
      Object.assign(this.headers, h);
      this.headersSent = true;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
    write(b) {
      (this.chunks ??= []).push(Buffer.from(b));
      return true;
    },
    end(b) {
      if (b) (this.chunks ??= []).push(Buffer.from(b));
      this.body = Buffer.concat(this.chunks ?? []);
      this.headersSent = true;
    },
    on() {},
    once() {},
    emit() {},
  };
  await m.fn(req, res, m.params, url);
  return res;
};
export const api = async (method, p, body) => {
  const res = await call(method, p, body);
  return res.body?.length ? JSON.parse(res.body) : undefined;
};

const cfg = await api('GET', '/api/server/config');
assert.equal(cfg.isInitialized, true);
assert.equal(cfg.isOnboarded, true);
const me = await api('GET', '/api/users/me');
assert.equal(me.isAdmin, true);
assert.ok(me.license);
assert.equal((await api('GET', '/api/server/features')).ocr, false);
assert.equal((await api('GET', '/api/admin/config')).machineLearning.facialRecognition.modelName, 'buffalo_l');
assert.ok((await api('GET', '/api/public/config')).ffmpeg);
const prefs = await api('PUT', '/api/users/me/preferences', { ratings: { enabled: true } });
assert.equal(prefs.ratings.enabled, true);
assert.equal(prefs.people.enabled, true);
assert.deepEqual(await api('GET', '/api/notifications'), []);

console.log('ok');
