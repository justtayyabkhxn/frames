// Self-check for Gallery's Bin (trash) on Frames: node standalone/immich-trash-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './immich-harness.mjs';
import { toUuid } from './lib/immich/ids.mjs';
import { Library } from './lib/library.mjs';

const { api, call, media, db, ctx, tmp } = setup();
ctx.dataDir = tmp;
ctx.previews = { remove() {}, get: async (key, file) => file };
ctx.lib = new Library(ctx);
// Like the real indexer: a restored file gets indexed again (as a new node)
ctx.indexer.indexPath = async (rel) =>
  db.q('SELECT id FROM nodes WHERE path = ?').get(rel)?.id ?? media(rel, '2024-01-01T00:00:00');
const file = (rel, id) => (
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }),
  fs.writeFileSync(path.join(tmp, rel), `x${id}`),
  id
);

const a = file('2024/a.jpg', media('2024/a.jpg', '2024-03-05T10:00:00', { favorite: 1 }));
const b = file('2024/b.mp4', media('2024/b.mp4', '2024-03-20T10:00:00', { video: true }));
file('2023/c.jpg', media('2023/c.jpg', '2023-12-25T10:00:00'));

// Deleting (no force) moves to the Bin; the main timeline loses it, the Bin timeline shows it by date taken
await api('DELETE', '/api/assets', { ids: [toUuid('asset', a), toUuid('asset', b)] });
assert.deepEqual(await api('GET', '/api/timeline/buckets?visibility=timeline'), [
  { timeBucket: '2023-12-01', count: 1 },
]);
assert.deepEqual(await api('GET', '/api/timeline/buckets?isTrashed=true'), [{ timeBucket: '2024-03-01', count: 2 }]);
const bucket = await api('GET', '/api/timeline/bucket?isTrashed=true&timeBucket=2024-03-01');
assert.deepEqual(bucket.isTrashed, [true, true]);
assert.deepEqual(bucket.isImage, [false, true]);
assert.deepEqual(bucket.isFavorite, [false, true]);
const [tb, ta] = bucket.id;

// Viewer: info, thumbnail and original of a trashed item
const info = await api('GET', `/api/assets/${ta}`);
assert.deepEqual([info.isTrashed, info.originalFileName, info.type], [true, 'a.jpg', 'IMAGE']);
assert.equal((await call('GET', `/api/assets/${ta}/thumbnail?size=preview`)).status, 200);
assert.equal((await call('GET', `/api/assets/${tb}/original`)).body.toString(), `x${b}`);

// Restore one, then delete the other forever
assert.deepEqual(await api('POST', '/api/trash/restore/assets', { ids: [ta] }), { count: 1 });
assert.ok(fs.existsSync(path.join(tmp, '2024/a.jpg')));
assert.equal(db.q('SELECT count(*) AS n FROM trash').get().n, 1);
await api('DELETE', '/api/assets', { ids: [tb], force: true });
assert.equal(db.q('SELECT count(*) AS n FROM trash').get().n, 0);

// Empty and restore-all work on whatever is left; force-deleting a live file skips the Bin
const c = db.q("SELECT id FROM nodes WHERE path = '2023/c.jpg'").get().id;
await api('DELETE', '/api/assets', { ids: [toUuid('asset', c)] });
assert.deepEqual(await api('POST', '/api/trash/restore', {}), { count: 1 });
assert.ok(fs.existsSync(path.join(tmp, '2023/c.jpg')));
const c2 = db.q("SELECT id FROM nodes WHERE path = '2023/c.jpg'").get().id;
await api('DELETE', '/api/assets', { ids: [toUuid('asset', c2)], force: true });
assert.ok(!fs.existsSync(path.join(tmp, '2023/c.jpg')));
assert.equal(db.q('SELECT count(*) AS n FROM trash').get().n, 0);
const d = db.q("SELECT id FROM nodes WHERE path = '2024/a.jpg'").get()?.id;
if (d) await api('DELETE', '/api/assets', { ids: [toUuid('asset', d)] });
assert.deepEqual(await api('POST', '/api/trash/empty', {}), { count: d ? 1 : 0 });
assert.deepEqual(await api('GET', '/api/timeline/buckets?isTrashed=true'), []);

console.log('ok');
