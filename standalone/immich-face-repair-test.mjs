// Self-check for Gallery's admin Face cleanup API: node standalone/immich-face-repair-test.mjs
import assert from 'node:assert/strict';
import { toUuid } from './lib/immich/ids.mjs';
import { registerFaceRepair } from './lib/immich/face-repair.mjs';
import { setup } from './immich-harness.mjs';

// Lens audit stub: flagged faces as [point, suspected cluster]; honours `exclude` like lens does
let flagged = [];
const { db, ctx, api, call, media, lensCalls } = setup({
  register: registerFaceRepair,
  lensPost: (p, b) => {
    if (p !== '/v1/faces/audit') return {};
    const cluster = (point) => db.q('SELECT cluster FROM faces WHERE point = ?').get(point)?.cluster;
    return {
      faces: flagged
        .filter(([point]) => !b.exclude.includes(point))
        .map(([point, suspected]) => ({
          id: point,
          cluster_id: cluster(point),
          suspected,
          own: 1,
          other: 4,
          nearest: 0.3,
        })),
    };
  },
});

const faceIds = {};
const addFaces = (prefix, cluster, n) => {
  for (let i = 1; i <= n; i++) {
    const fileid = media(`${prefix}${i}.jpg`, `2024-01-0${i}T10:00:00`);
    faceIds[`${prefix}${i}`] = db
      .q(
        'INSERT INTO faces (point, fileid, cluster, x, y, w, h, score) VALUES (?, ?, ?, 0.1, 0.2, 0.25, 0.5, 0.9) RETURNING id',
      )
      .get(`${prefix}${i}`, fileid, cluster).id;
  }
};
addFaces('a', 10, 4); // Alice, named
addFaces('b', 20, 3); // unnamed, lightly contaminated
addFaces('c', 30, 2); // unnamed, fully contaminated
addFaces('d', 40, 5); // unnamed, two owners, one of them over-cap
db.q("INSERT INTO people (id, name) VALUES (10, 'Alice')").run();

const P = (c) => toUuid('person', c);
const F = (k) => toUuid('face', faceIds[k]);
const R = '/api/admin/face-repair';
const clusterOf = (k) => db.q('SELECT cluster FROM faces WHERE id = ?').get(faceIds[k]).cluster;
const latest = () => api('GET', `${R}/scan/latest`);
const byPerson = async () => Object.fromEntries((await latest()).persons.map((p) => [p.personId, p]));

// Before any scan
assert.equal(await latest(), null);
assert.deepEqual(await api('GET', `${R}/scan/person/${P(20)}`), { personId: P(20), flaggedFaces: [] });
assert.deepEqual(await api('GET', `${R}/scan/defaults`), { maxDistance: 0.5, minFaces: 3, maxFlaggedFraction: 0.5 });

// Scan, lanes and reasons
flagged = [
  ['a4', 20],
  ['b3', 10],
  ['c1', 20],
  ['c2', 20],
  ['d1', 30],
  ['d2', 10],
];
const { scanId } = await api('POST', `${R}/scan`, {});
assert.ok(scanId);
const scan = await latest();
assert.equal(scan.id, scanId);
assert.equal(scan.status, 'completed');
assert.deepEqual(scan.totals, {
  eligibleFaces: 14,
  flaggedFaces: 6,
  toRepair: 3,
  reviewOnlyFaces: 3,
  reviewOnlyPersons: 1,
  affectedPersons: 4,
  reviewOnlyByReason: { overCap: 2, badTarget: 1, unAttributable: 0 },
});
let people = await byPerson();
assert.equal(people[P(20)].recommendation, 'confident');
assert.deepEqual(people[P(20)].reviewReasons, []);
assert.equal(people[P(20)].ownerId, toUuid('user', 1));
assert.equal(people[P(20)].personName, null);
assert.equal(people[P(20)].eligible, 3);
assert.equal(people[P(20)].flagged, 1);
assert.deepEqual(people[P(20)].suspectedOwners, [
  {
    ownerPersonId: P(10),
    ownerName: 'Alice',
    thumbnailFaceId: F('a1'),
    count: 1,
    ownerFaceCount: 4,
    ownerMissing: false,
  },
]);
assert.deepEqual(people[P(10)].reviewReasons, ['named']);
assert.deepEqual(people[P(30)].reviewReasons, ['over-cap']);
assert.deepEqual(people[P(40)].reviewReasons, ['multiple-owners', 'bad-target']);
assert.equal(people[P(40)].recommendation, 'review-first');

// Large clusters go to review (threshold tuned for one run)
await api('POST', `${R}/scan`, { params: { largeClusterThreshold: 2 } });
assert.deepEqual((await byPerson())[P(20)].reviewReasons, ['large-cluster']);
await api('POST', `${R}/scan`, {});

// Flagged faces and the rest of the cluster
const pf = await api('GET', `${R}/scan/person/${P(20)}`);
assert.equal(pf.flaggedFaces.length, 1);
assert.deepEqual(pf.flaggedFaces[0], {
  assetFaceId: F('b3'),
  suspectedOwnerId: P(10),
  localDateTime: '2024-01-03T10:00:00.000Z',
  boundingBoxX1: 40,
  boundingBoxY1: 60,
  boundingBoxX2: 140,
  boundingBoxY2: 210,
  imageWidth: 400,
  imageHeight: 300,
});
const rest = await api('POST', `${R}/scan/person/${P(20)}/cluster-faces`, {
  excludeFaceIds: [F('b3')],
  page: 0,
  size: 1,
});
assert.equal(rest.total, 2);
assert.equal(rest.hasMore, true);
assert.equal(rest.faces[0].assetFaceId, F('b2'));
const rest2 = await api('POST', `${R}/scan/person/${P(20)}/cluster-faces`, {
  excludeFaceIds: [F('b3')],
  page: 1,
  size: 1,
});
assert.deepEqual([rest2.faces[0].assetFaceId, rest2.hasMore], [F('b1'), false]);

// Person detail and the owner-scoped picker
assert.deepEqual(await api('GET', `${R}/person/${P(10)}`), {
  id: P(10),
  name: 'Alice',
  ownerId: toUuid('user', 1),
  faceCount: 4,
  thumbnailFaceId: F('a1'),
});
assert.equal((await call('GET', `${R}/person/${P(99)}`)).status, 404);
const owner = toUuid('user', 1);
const all = await api('GET', `${R}/owner/${owner}/people?page=0`);
assert.equal(all.total, 4);
assert.equal(all.people[0].name, 'Alice');
assert.deepEqual(
  (await api('GET', `${R}/owner/${owner}/people?query=ali`)).people.map((p) => p.id),
  [P(10)],
);
const { id: zed } = await api('POST', `${R}/owner/${owner}/people`, { name: 'Zed' });
assert.equal((await api('GET', `${R}/person/${zed}`)).name, 'Zed');

// Resolve: move, stay, lock, unknown, detach; a face from another person is skipped
assert.equal((await call('POST', `${R}/resolve`, { personId: P(40) })).status, 400);
assert.equal(
  (
    await call('POST', `${R}/resolve`, {
      personId: P(40),
      stay: [F('d1')],
      entireCluster: { destinationPersonId: P(20) },
    })
  ).status,
  400,
);
const out = await api('POST', `${R}/resolve`, {
  personId: P(40),
  moveToPerson: [{ destinationPersonId: P(10), faceIds: [F('d2')] }],
  stay: [F('d1'), F('a1')],
  lock: [F('d5')],
  unknown: [F('d3')],
  detach: [F('d4')],
});
assert.deepEqual(out, { moved: 1, declined: 1, locked: 1, detached: 1, unknown: 1, skipped: 1 });
assert.equal(clusterOf('d2'), 10);
assert.equal(clusterOf('d1'), 40);
assert.equal(clusterOf('d4'), -1);
assert.ok(clusterOf('d3') > 0 && ![10, 20, 30, 40].includes(clusterOf('d3')));
assert.equal(clusterOf('a1'), 10);
assert.ok(lensCalls.some(([m, p, b]) => p === '/v1/faces/assign' && b.cluster_id === 10 && b.ids[0] === 'd2'));
// Resolved rows leave the live scan without a re-scan
assert.equal((await byPerson())[P(40)], undefined);

// Stayed faces are excluded from the next scan
await api('POST', `${R}/scan`, {});
const audit = lensCalls.filter(([, p]) => p === '/v1/faces/audit').at(-1)[2];
assert.ok(['d1', 'd3', 'd5'].every((p) => audit.exclude.includes(p)));
people = await byPerson();
assert.equal(people[P(40)], undefined);

// Resolutions: listing and undo
const res = await api('GET', `${R}/resolutions?page=1&size=50`);
assert.equal(res.total, 3);
const d1 = res.resolutions.find((r) => r.assetFaceId === F('d1'));
assert.deepEqual(
  { status: d1.status, source: d1.source, personId: d1.personId, spacePersonId: d1.spacePersonId },
  { status: 'stay', source: 'cleanup', personId: P(40), spacePersonId: null },
);
assert.ok(res.resolutions.some((r) => r.assetFaceId === F('d3') && r.status === 'locked'));
assert.deepEqual(await api('POST', `${R}/resolutions/remove`, { verdictIds: [d1.id] }), { removed: 1 });
assert.equal((await api('GET', `${R}/resolutions`)).total, 2);
await api('POST', `${R}/scan`, {});
assert.equal((await byPerson())[P(40)].flagged, 1);

// Dismissing a cluster mutes it until another owner shows up
assert.deepEqual(await api('POST', `${R}/decline`, { persons: [{ personId: P(30), suspectedOwnerIds: [P(20)] }] }), {
  created: 1,
});
assert.equal((await byPerson())[P(30)], undefined);
await api('POST', `${R}/scan`, {});
assert.equal((await byPerson())[P(30)], undefined);
assert.equal((await api('GET', `${R}/resolutions`)).total, 2);

// Move an entire unnamed cluster
assert.deepEqual(
  await api('POST', `${R}/resolve`, { personId: P(30), entireCluster: { destinationPersonId: P(20) } }),
  {
    moved: 2,
    declined: 0,
    locked: 0,
    detached: 0,
    unknown: 0,
    skipped: 0,
  },
);
assert.deepEqual([clusterOf('c1'), clusterOf('c2')], [20, 20]);

// AI engine not ready: a failed scan, never a 404
ctx.lens.state = 'starting';
await api('POST', `${R}/scan`, {});
const failed = await latest();
assert.equal(failed.status, 'failed');
assert.deepEqual(failed.persons, []);
assert.ok(failed.error);
ctx.lens.state = 'ready';

console.log('ok');
