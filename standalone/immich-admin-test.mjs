// Self-check for Gallery's admin pages on Frames: node standalone/immich-admin-test.mjs
import assert from 'node:assert/strict';
import { setup } from './immich-harness.mjs';

const { api, media, ctx } = setup();
media('a.jpg', '2024-01-01T10:00:00', { size: 1000 });
media('b.mp4', '2024-01-02T10:00:00', { size: 5000, video: true });

const stats = await api('GET', '/api/server/statistics');
assert.deepEqual(
  [stats.photos, stats.videos, stats.usage, stats.usagePhotos, stats.usageVideos],
  [1, 1, 6000, 1000, 5000],
);
assert.equal(stats.usageByUser.length, 1);
assert.equal((await api('GET', '/api/admin/users')).length, 1);

ctx.indexer.status = {
  phase: 'indexing',
  done: 3,
  total: 10,
  count: 3,
  ai: { state: 'indexing', queued: 4, indexed: 6 },
};
const queues = await api('GET', '/api/queues');
const q = Object.fromEntries(queues.map((x) => [x.name, x.statistics]));
assert.deepEqual([q.library.active, q.library.waiting], [1, 7]);
assert.deepEqual([q.smartSearch.waiting, q.smartSearch.completed], [4, 6]);
let scanned = 0;
ctx.indexer.scan = () => scanned++;
await api('PUT', '/api/jobs/library', { command: 'start' });
assert.equal(scanned, 1);
for (const p of ['/api/libraries', '/api/workflows', '/api/plugins/methods', '/api/admin/integrity/summary'])
  assert.ok(await api('GET', p), p);
// Map: style and tiles come from Frames itself, nothing online
const cfg = await api('GET', '/api/server/config');
assert.equal(cfg.mapLightStyleUrl, '/api/frames/map-style/light.json');
const style = await api('GET', '/api/frames/map-style/dark.json');
assert.match(style.sources.frames.tiles[0], /^http:\/\/[^/]*\/apps\/memories\/api\/map\/tiles\//);
assert.doesNotMatch(JSON.stringify(style), /openfreemap|openstreetmap\.org\/[^c]/);
console.log('ok');
