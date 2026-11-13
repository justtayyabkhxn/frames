import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Indexer, isMedia } from './lib/indexer.mjs';
import { previewKey } from './lib/previews.mjs';
import { dims, parseRange, takenFrom } from './util.mjs';

assert.equal(takenFrom({ DateTimeOriginal: '2019:07:14 10:20:00' }, 0), '2019-07-14T10:20:00');
assert.equal(
  takenFrom({ DateTimeOriginal: '0000:00:00 00:00:00', CreateDate: '2023:03:04 12:00:00+05:30' }, 0),
  '2023-03-04T12:00:00',
);
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

// .mts is also a TypeScript module: only MPEG-TS content is media
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-test-'));
const write = (name, buf) => (fs.writeFileSync(path.join(tmp, name), buf), path.join(tmp, name));
const ts = (packet, lead = 0) => {
  const buf = Buffer.alloc(packet * 3);
  for (let i = lead; i < buf.length; i += packet) buf[i] = 0x47;
  return buf;
};
assert.equal(isMedia(write('index.d.mts', 'export declare const x: number;\n'.repeat(20))), false);
assert.equal(isMedia(write('clip.mts', ts(192, 4))), true);
assert.equal(isMedia(write('clip.m2ts', ts(188))), true);
assert.equal(isMedia(write('photo.jpg', 'x')), true);
assert.equal(isMedia(write('notes.txt', 'x')), false);

// The scan skips Frames' own data folder (thumbnails) when it sits inside the library
fs.mkdirSync(path.join(tmp, 'data', 'previews'), { recursive: true });
write('data/previews/1-base.jpg', 'x');
const walked = [];
for await (const e of new Indexer({ root: tmp, dataDir: path.join(tmp, 'data') }).walk(tmp, '')) walked.push(e.rel);
assert.ok(walked.includes('photo.jpg'));
assert.deepEqual(
  walked.filter((r) => r.startsWith('data')),
  [],
);
fs.rmSync(tmp, { recursive: true, force: true });

// Preview tiers; the viewer asks for x = y = -1, meaning the largest screen preview
assert.equal(previewKey(256, 256, true), 's256');
assert.equal(previewKey(511, 300, false), 'f512');
assert.equal(previewKey(1921, 1201, false), 'f2048');
assert.equal(previewKey(9999, 9999, false), 'f4096');
assert.equal(previewKey(-1, -1, false), 'f2048');

console.log('ok');
