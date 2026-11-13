// Self-check for People logic in lib/ai.mjs (no Python needed): node standalone/ai-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { faceCropFilter, faceIdOf, legacyMatches, registerAi } from './lib/ai.mjs';
import { openDb } from './lib/db.mjs';
import { Router } from './lib/http.mjs';

assert.equal(faceIdOf('12-IMG 1.jpg'), 12);
assert.equal(faceIdOf('IMG.jpg'), 0);
assert.equal(
  faceCropFilter({ x: 0.1, y: 0.2, w: 0.2, h: 0.1 }),
  'crop=w=min(min(iw\\,ih)\\,1.5*max(0.20000*iw\\,0.10000*ih)):h=ow:x=max(0\\,min(iw-ow\\,0.20000*iw-ow/2)):y=max(0\\,min(ih-oh\\,0.25000*ih-oh/2)),scale=256:256',
);

{
  const box = (fileid, cluster, x = 0) => ({ fileid, cluster, x, y: 0, w: 0.1, h: 0.1 });
  const legacy = [box(1, 7), box(2, 7), box(3, 7), box(4, 8), box(5, 7)];
  // cluster 50 is mostly 7, cluster 60 is 7's old mix-up with 8 (no majority), 70 is a smaller part of 7
  const faces = [box(1, 50), box(2, 50), box(3, 50, 0.01), box(4, 60), box(5, 60), box(6, 70), box(2, 70, 0.5)];
  assert.deepEqual(legacyMatches(faces, legacy), [[50, 7]]);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-ai-'));
const db = openDb(':memory:');
db.exec(`INSERT INTO nodes (id, path, parent, name, dir) VALUES (1, '', NULL, '', 1)`);
for (const id of [2, 3, 4]) {
  db.q(`INSERT INTO nodes (id, path, parent, name, dir, etag, mime) VALUES (?, ?, 1, ?, 0, ?, 'image/jpeg')`).run(
    id,
    `p${id}.jpg`,
    `p${id}.jpg`,
    `e${id}`,
  );
  db.q(`INSERT INTO media (id, datetaken, dayid, epoch, w, h, indexed_at) VALUES (?, 0, 0, 0, 10, 10, 0)`).run(id);
}
const assigned = [];
const ctx = {
  db,
  uid: 'me',
  token: 't',
  dataDir,
  dayFilters: [],
  clustersOf: {},
  indexer: { status: {} },
  lib: { node: (id) => db.q('SELECT * FROM nodes WHERE id = ?').get(id) },
  lens: { state: 'ready', post: async (p, body) => assigned.push([p, body]) },
};
const router = new Router();
registerAi(router, ctx);

db.exec(`INSERT INTO faces (id, point, fileid, cluster, x, y, w, h, score) VALUES
  (10, 'a', 2, 100, 0, 0, .1, .1, .9), (11, 'b', 3, 100, 0, 0, .2, .2, .9), (12, 'c', 4, NULL, 0, 0, .1, .1, .9)`);

const call = async (method, p, headers = {}) => {
  const m = router.match(method, p);
  const res = { writeHead: (s) => ((res.status = s), res), end: (b) => (res.body = b) };
  await m.fn({ method, headers }, res, m.params, new URL(`http://x${p}`));
  return res;
};
const dav = (method, p, dest) =>
  ctx.davCollections.recognize(
    { method, headers: dest ? { destination: `/remote.php/dav/recognize/me/${dest}` } : {} },
    { writeHead: () => ({ end() {} }), end() {} },
    p.split('/'),
  );
const people = async () => JSON.parse((await call('GET', '/apps/memories/api/clusters/recognize')).body);

let list = await people();
assert.deepEqual(
  list.map((c) => [c.id, c.name, c.count, c.cover]),
  [[100, '', 2, 11]],
);

// Unassigned face -> new person "Alice"
await dav('MOVE', 'recognize/me/unassigned-faces/12-p4.jpg', 'faces/Alice/12-p4.jpg');
const alice = db.q("SELECT id FROM people WHERE name = 'Alice'").get().id;
assert.deepEqual(assigned.at(-1), ['/v1/faces/assign', { ids: ['c'], cluster_id: alice }]);

// Rename unnamed cluster 100 to Alice -> merge into Alice
await dav('MOVE', 'recognize/me/faces/100', 'faces/Alice');
list = await people();
assert.deepEqual(
  list.map((c) => [c.name, c.count]),
  [['Alice', 3]],
);
assert.deepEqual(
  ctx.clustersOf.recognize(3).map((c) => c.name),
  ['Alice'],
);

// Timeline filter with face rects
const f = { n: 0, args: {}, joins: [], where: [], post: [] };
ctx.dayFilters[0](new URLSearchParams('recognize=me/Alice&facerect=1'), f);
assert.equal(f.args.rcl, alice);
assert.ok(f.cluster && f.select.includes('fc.id AS faceid'));
const row = { face_x: 0.1, face_y: 0.2, face_w: 0.3, face_h: 0.4 };
f.post[0](row);
assert.deepEqual(row, { facerect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } });

// Remove one face, then delete the person
await dav('DELETE', 'recognize/me/faces/Alice/10-p2.jpg');
assert.equal(db.q('SELECT cluster FROM faces WHERE id = 10').get().cluster, -1);
await dav('DELETE', 'recognize/me/faces/Alice');
assert.deepEqual(await people(), []);
assert.equal(db.q('SELECT count(*) AS n FROM people').get().n, 0);

fs.rmSync(dataDir, { recursive: true, force: true });
console.log('ok');
