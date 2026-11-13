// Self-check for the Immich tags API: node standalone/immich-tags-test.mjs
import assert from 'node:assert/strict';
import { setup } from './immich-harness.mjs';
import { toUuid } from './lib/immich/ids.mjs';
import { registerTags } from './lib/immich/tags.mjs';

const { api, call, media, ctx } = setup({ register: registerTags });
const a1 = media('2020/a.jpg', '2020-01-01T10:00:00');
const a2 = media('2020/b.jpg', '2020-06-01T10:00:00');
const a3 = media('2021/c.jpg', '2021-03-01T10:00:00');
const U = (id) => toUuid('asset', id);

// Create with a parent
const travel = await api('POST', '/api/tags', { name: 'Travel' });
assert.equal(travel.value, 'Travel');
assert.equal(travel.parentId, undefined);
const y24 = await api('POST', '/api/tags', { name: '2024', parentId: travel.id, color: '#ff0000' });
assert.deepEqual([y24.name, y24.value, y24.parentId, y24.color], ['2024', 'Travel/2024', travel.id, '#ff0000']);
assert.equal((await call('POST', '/api/tags', { name: 'Travel' })).status, 400);
assert.equal((await call('POST', '/api/tags', { name: 'a/b' })).status, 400);

// Upsert creates parents and returns the leaves
const up = await api('PUT', '/api/tags', { tags: ['Family/Kids/Anna', 'Travel/2024'] });
assert.deepEqual(
  up.map((t) => t.value),
  ['Family/Kids/Anna', 'Travel/2024'],
);
assert.equal(up[1].id, y24.id);

// List values and parentId
const all = await api('GET', '/api/tags');
const by = Object.fromEntries(all.map((t) => [t.value, t]));
assert.deepEqual(Object.keys(by).sort(), ['Family', 'Family/Kids', 'Family/Kids/Anna', 'Travel', 'Travel/2024']);
assert.equal(by['Family/Kids/Anna'].name, 'Anna');
assert.equal(by['Family/Kids/Anna'].parentId, by['Family/Kids'].id);
assert.equal(by['Family/Kids'].parentId, by.Family.id);
assert.equal((await api('GET', `/api/tags/${y24.id}`)).value, 'Travel/2024');
assert.equal((await call('GET', `/api/tags/${toUuid('tag', 999)}`)).status, 404);

// Tag and untag assets
assert.deepEqual(await api('PUT', `/api/tags/${y24.id}/assets`, { ids: [U(a1), U(a2), U(999)] }), [
  { id: U(a1), success: true },
  { id: U(a2), success: true },
  { id: U(999), success: false, error: 'not_found' },
]);
assert.deepEqual(await api('PUT', `/api/tags/${y24.id}/assets`, { ids: [U(a1)] }), [
  { id: U(a1), success: false, error: 'duplicate' },
]);
assert.deepEqual(await api('DELETE', `/api/tags/${y24.id}/assets`, { ids: [U(a2), U(a3)] }), [
  { id: U(a2), success: true },
  { id: U(a3), success: false, error: 'not_found' },
]);
assert.deepEqual(
  ctx.tagsOfAsset(a1).map((t) => t.value),
  ['Travel/2024'],
);

// Bulk tag
const anna = by['Family/Kids/Anna'].id;
assert.deepEqual(await api('PUT', '/api/tags/assets', { tagIds: [anna, y24.id], assetIds: [U(a1), U(a3)] }), {
  count: 3,
});

// Timeline by tag
const count = async (q) => (await api('GET', `/api/timeline/buckets?${q}`)).reduce((n, b) => n + b.count, 0);
assert.equal(await count(`tagId=${y24.id}`), 2);
assert.equal(await count(`tagId=${anna}`), 2);

// Color update
assert.equal((await api('PUT', `/api/tags/${travel.id}`, { color: '#00ff00' })).color, '#00ff00');
assert.equal((await api('GET', `/api/tags/${travel.id}`)).color, '#00ff00');
assert.equal((await call('PUT', `/api/tags/${travel.id}`, { color: 'nope' })).status, 400);

// Delete removes children and their asset links
assert.equal((await call('DELETE', `/api/tags/${travel.id}`)).status, 204);
assert.deepEqual((await api('GET', '/api/tags')).map((t) => t.value).sort(), [
  'Family',
  'Family/Kids',
  'Family/Kids/Anna',
]);
assert.deepEqual(
  ctx.tagsOfAsset(a1).map((t) => t.value),
  ['Family/Kids/Anna'],
);

console.log('ok');
