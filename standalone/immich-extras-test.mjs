// Self-check for smaller Gallery endpoints on Frames: node standalone/immich-extras-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './immich-harness.mjs';
import { toUuid } from './lib/immich/ids.mjs';

let suggest = [];
const { api, call, media, db, ctx, tmp } = setup({
  lensPost: (p) => (p === '/v1/faces/suggestions' ? { items: suggest } : { items: [] }),
});
const U = (id) => toUuid('asset', id);
const a = media('2024/a.jpg', '2024-03-05T10:00:00', { size: 4 });
const b = media('2024/sub/a.jpg', '2024-03-05T12:00:00', { size: 4 });
for (const [rel, id] of [
  ['2024/a.jpg', a],
  ['2024/sub/a.jpg', b],
]) {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), `img${id}`);
}

// Download: sizes, then one zip with both files (same names made unique)
const info = await api('POST', '/api/download/info', { assetIds: [U(a), U(b)] });
assert.deepEqual([info.totalSize, info.archives.length, info.archives[0].assetIds.length], [8, 1, 2]);
const zip = await call('POST', '/api/download/archive', { assetIds: [U(a), U(b)] });
assert.equal(zip.status, 200);
assert.match(zip.headers['Content-Type'], /zip/);
const body = zip.body.toString('latin1');
assert.ok(body.includes('a.jpg') && body.includes('a (2).jpg'));

// Asset jobs re-index; heatmap counts photos per day taken
const indexed = [];
ctx.indexer.indexPath = async (rel) => indexed.push(rel);
await api('POST', '/api/assets/jobs', { assetIds: [U(a)], name: 'refresh-metadata' });
assert.deepEqual(indexed, ['2024/a.jpg']);
const heat = await api('GET', '/api/users/me/calendar-heatmap?from=2024-01-01&to=2024-12-31');
assert.deepEqual([heat.totalCount, heat.series], [2, [{ date: '2024-03-05', count: 2 }]]);

// Admin config alias, ML health, editable check
assert.equal((await api('GET', '/api/system-config')).machineLearning.facialRecognition.modelName, 'buffalo_l');
assert.equal((await api('GET', '/api/server/ml-health')).smartSearchHealthy, true);
assert.deepEqual((await api('POST', '/api/assets/editable', { assetIds: [U(a)] })).editableAssetIds, [U(a)]);

// Jobs list has every queue Gallery's admin pages read; integrity summary has its counts
const jobs = await api('GET', '/api/jobs');
assert.ok(jobs.integrityCheck.queueStatus && jobs.backgroundTask.jobCounts);
assert.deepEqual(await api('GET', '/api/admin/integrity/summary'), {
  checksum_mismatch: 0,
  missing_file: 0,
  untracked_file: 0,
});

// Face suggestions with a real suggestion (was a 500)
db.exec(`INSERT INTO people (id, name) VALUES (500, 'Bob');
  INSERT INTO faces (id, point, fileid, cluster, x, y, w, h, score) VALUES (1, 'p1', ${a}, 500, 0, 0, .1, .1, .9), (2, 'p2', ${b}, NULL, .2, .2, .1, .1, .9)`);
suggest = [{ id: 'p2', distance: 0.6 }];
const s = await api('GET', `/api/people/${toUuid('person', 500)}/face-suggestions`);
assert.deepEqual([s.total, s.items[0].assetFaceId, s.items[0].assetId], [1, toUuid('face', 2), U(b)]);

// Not in Frames: clear 400s instead of 404s
assert.equal((await call('POST', '/api/stacks', { assetIds: [U(a), U(b)] })).status, 400);
assert.equal((await call('POST', '/api/faces', {})).status, 400);
console.log('ok');
