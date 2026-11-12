import assert from 'node:assert/strict';
import { dims, parseRange, takenFrom } from './util.mjs';

assert.equal(takenFrom({ DateTimeOriginal: '2019:07:14 10:20:00' }, 0), '2019-07-14T10:20:00');
assert.equal(takenFrom({ DateTimeOriginal: '0000:00:00 00:00:00', CreateDate: '2023:03:04 12:00:00+05:30' }, 0), '2023-03-04T12:00:00');
assert.match(takenFrom({}, Date.UTC(2020, 0, 1)), /^20(19-12-31|20-01-01)T/);

assert.deepEqual(dims({ ImageWidth: 1600, ImageHeight: 900, Orientation: 6 }), [900, 1600]);
assert.deepEqual(dims({ ImageWidth: 640, ImageHeight: 360, Rotation: 90 }), [360, 640]);
assert.deepEqual(dims({}), [1, 1]);

assert.equal(parseRange(undefined, 100), null);
assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
assert.deepEqual(parseRange('bytes=10-20', 100), { start: 10, end: 20 });
assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
assert.deepEqual(parseRange('bytes=-30', 100), { start: 70, end: 99 });
assert.deepEqual(parseRange('bytes=-300', 100), { start: 0, end: 99 });
assert.equal(parseRange('bytes=100-', 100), false);
assert.equal(parseRange('bytes=20-10', 100), false);

console.log('ok');
