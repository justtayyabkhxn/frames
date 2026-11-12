import assert from 'node:assert/strict';
import { applyPixels, gaussianKernel, geometry, parsePam } from './lib/media-edit.mjs';
import { trailerOffset } from './lib/media.mjs';
import {
  copySegments,
  parseKeyframes,
  parseProbe,
  renditions,
  uniformSegments,
  variantPlaylist,
  Vod,
} from './lib/media-vod.mjs';

// probe: rotation swaps display size
const p = parseProbe({
  streams: [
    {
      codec_type: 'video',
      codec_name: 'hevc',
      width: 1920,
      height: 1080,
      avg_frame_rate: '30000/1001',
      side_data_list: [{ rotation: -90 }],
    },
    { codec_type: 'audio', codec_name: 'aac', channels: 2 },
  ],
  format: { duration: '10.5', start_time: '0.0' },
});
assert.deepEqual([p.codec, p.w, p.h, p.duration], ['hevc', 1080, 1920, 10.5]);
assert.equal(Math.round(p.fps * 100), 2997);
assert.equal(parseProbe({ streams: [{ codec_type: 'audio' }] }), null);

// renditions: copy when playable, else ladder on the short side, capped at 1080p
assert.deepEqual(
  renditions(p, ['h264', 'hevc']).map((r) => r.q),
  ['direct'],
);
const ladder = renditions(p, ['h264']);
assert.deepEqual(
  ladder.map((r) => r.q),
  ['480p', '720p', '1080p'],
);
assert.deepEqual([ladder[0].w, ladder[0].h], [480, 854]);
assert.deepEqual(
  renditions({ ...p, w: 640, h: 360 }, []).map((r) => r.q),
  ['360p'],
);

// keyframes + segments
const keys = parseKeyframes('0.033000,K__\n0.066000,___\n1.033000,K__\nN/A,K__\n2.033000,K_\n', 0.033);
assert.deepEqual(
  keys.map((k) => +k.toFixed(3)),
  [0, 1, 2],
);
assert.deepEqual(
  copySegments([0, 1, 2], 2.5).map((s) => [s.start, s.dur]),
  [
    [0, 1],
    [1, 1],
    [2, 0.5],
  ],
);
assert.equal(copySegments([], 3), null);
assert.deepEqual(
  uniformSegments(9).map((s) => s.dur),
  [4, 4, 1],
);
const pl = variantPlaylist('720p', uniformSegments(9), '?codecs=h264');
assert.match(pl, /#EXT-X-MAP:URI="720p-init\.mp4\?codecs=h264"/);
assert.match(pl, /#EXTINF:1\.000000,\n720p-000002\.m4s\?codecs=h264\n#EXT-X-ENDLIST/);

// storyboard plan/vtt
const sb = Vod.plan({ duration: 20, w: 1920, h: 1080 });
assert.deepEqual([sb.count, sb.sprites, sb.tw, sb.th], [4, 1, 160, 90]);
assert.match(Vod.vtt(sb, ''), /00:00:15\.000 --> 00:00:20\.000\nstoryboard-0\.jpg#xywh=480,0,160,90/);

// motion photo trailer
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(50), Buffer.from([0xff, 0xd9])]);
const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 16]),
  Buffer.from('ftypisom0000'),
  Buffer.from([0, 0, 0, 8]),
  Buffer.from('mdat'),
]);
assert.equal(trailerOffset(Buffer.concat([jpeg, mp4]), jpeg.length - 2), jpeg.length);
assert.equal(trailerOffset(jpeg), -1);

// editor math (matches the vips-editor preview shaders)
const px = (edits, rgb = [0.25, 0.5, 0.75]) =>
  [...applyPixels(Float32Array.from(rgb), 1, 1, edits)].map((v) => +v.toFixed(4));
assert.deepEqual(px([{ edit: 'exposure', stops: 1 }]), [0.5, 1, 1.5]);
assert.deepEqual(px([{ edit: 'brightnessContrast', brightness: 0.1, contrast: -0.5 }]), [0.425, 0.55, 0.675]);
assert.deepEqual(px([{ edit: 'grayscale' }]), [0.5, 0.5, 0.5]);
assert.deepEqual(px([{ edit: 'invert' }]), [0.75, 0.5, 0.25]);
assert.deepEqual(px([{ edit: 'warmth', amount: 1 }]), [0.325, 0.5, 0.525]);
assert.deepEqual(px([{ edit: 'hueSaturation', hue: 0, saturation: -1 }]), [0.5, 0.5, 0.5]);
assert.deepEqual(px([{ edit: 'hueSaturation', hue: 2 / 3, saturation: 0 }]), [0.75, 0.25, 0.5]);
assert.deepEqual(px([{ edit: 'shadows', amount: 1 }], [0, 0, 0]), [0.5, 0.5, 0.5]);
assert.equal(
  +gaussianKernel(4)
    .reduce((a, b) => a + b)
    .toFixed(6),
  1,
);
assert.deepEqual(px([{ edit: 'blur', radius: 3 }]), [0.25, 0.5, 0.75]);

// geometry: quarter turns swap, crop runs on the rotated size
assert.deepEqual(
  geometry(
    [
      { edit: 'rotate', angle: 90 },
      { edit: 'crop', x: 0.5, y: 0, width: 0.5, height: 0.5 },
    ],
    400,
    200,
  ),
  {
    filters: ['transpose=1', 'crop=100:200:100:0'],
    w: 100,
    h: 200,
  },
);
assert.deepEqual(
  geometry(
    [
      { edit: 'rotate', angle: -180 },
      { edit: 'flip', direction: 'vertical' },
    ],
    4,
    2,
  ).filters,
  ['hflip,vflip', 'vflip'],
);
const g = geometry([{ edit: 'rotate', angle: 10 }], 100, 50);
assert.deepEqual([g.w, g.h], [107, 67]);

const pam = parsePam(
  Buffer.concat([
    Buffer.from('P7\nWIDTH 2\nHEIGHT 1\nDEPTH 3\nMAXVAL 255\nTUPLTYPE RGB\nENDHDR\n'),
    Buffer.alloc(6, 7),
  ]),
);
assert.deepEqual([pam.w, pam.h, pam.data.length], [2, 1, 6]);

console.log('ok');
