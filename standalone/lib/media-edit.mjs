import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { badRequest, HttpError } from './http.mjs';
import { cleanRel, parentRel } from './library.mjs';
import { exiftool, run } from './tools.mjs';

/**
 * Photo editor save: the @radialapps/memories-vips-editor edit list, rendered with
 * the same per-pixel math as its WebGL preview (src/math.ts + transforms/*.ts,
 * float pipeline, sRGB 0..1), geometry via ffmpeg filters, encode via ffmpeg.
 */

const FORMATS = { jpg: 'jpg', jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' };
const GEOMETRY = ['rotate', 'flip', 'crop'];
const PIXEL = [
  'exposure',
  'brightnessContrast',
  'shadows',
  'highlights',
  'hueSaturation',
  'warmth',
  'vibrance',
  'sepia',
  'grayscale',
  'invert',
  'vignette',
  'blur',
  'sharpen',
];
// Orientation tag -> ffmpeg filters that bake it in
const ORIENT = {
  2: 'hflip',
  3: 'hflip,vflip',
  4: 'vflip',
  5: 'transpose=0',
  6: 'transpose=1',
  7: 'transpose=3',
  8: 'transpose=2',
};

const clamp = (lo, v, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, def, lo, hi) => clamp(lo, Number.isFinite(+v) && v !== null ? +v : def, hi);

export function normAngle(a) {
  a %= 360;
  if (a <= -180) a += 360;
  else if (a > 180) a -= 360;
  return a;
}

export function gaussianKernel(radius) {
  const r = clamp(0, radius, 100);
  if (r <= 0) return [1];
  const sigma = r / 2;
  const half = Math.min(15, Math.max(1, Math.ceil(sigma * 2)));
  const w = [];
  for (let i = -half; i <= half; i++) w.push(Math.exp(-0.5 * (i / sigma) ** 2));
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / sum);
}

/** Separable gaussian with clamped edges; returns a new buffer. */
function gaussian(px, w, h, radius) {
  const k = gaussianKernel(radius);
  const half = (k.length - 1) / 2;
  const row = w * 3;
  const tmp = new Float32Array(px.length);
  const out = new Float32Array(px.length);
  // Horizontal: edge-replicated padded row, one contiguous sweep per tap
  const pad = new Float32Array(row + half * 6);
  for (let y = 0; y < h; y++) {
    const o = y * row;
    pad.set(px.subarray(o, o + row), half * 3);
    for (let x = 0; x < half; x++)
      for (let c = 0; c < 3; c++) {
        pad[x * 3 + c] = px[o + c];
        pad[(half + w + x) * 3 + c] = px[o + row - 3 + c];
      }
    for (let i = 0; i < k.length; i++) {
      const ki = k[i];
      const s = i * 3;
      for (let j = 0; j < row; j++) tmp[o + j] += ki * pad[s + j];
    }
  }
  // Vertical: clamped source rows
  for (let y = 0; y < h; y++) {
    const o = y * row;
    for (let i = 0; i < k.length; i++) {
      const ki = k[i];
      const s = clamp(0, y + i - half, h - 1) * row;
      for (let j = 0; j < row; j++) out[o + j] += ki * tmp[s + j];
    }
  }
  return out;
}

/** Apply pixel edits in order to interleaved RGB floats (0..1, unclamped between edits). */
export function applyPixels(px, w, h, edits) {
  const point = (fn) => {
    for (let i = 0; i < px.length; i += 3) fn(i);
  };
  for (const e of edits) {
    switch (e.edit) {
      case 'exposure': {
        const m = 2 ** num(e.stops, 0, -5, 5);
        for (let i = 0; i < px.length; i++) px[i] *= m;
        break;
      }
      case 'brightnessContrast': {
        const b = num(e.brightness, 0, -1, 1);
        const c = num(e.contrast, 0, -1, 1);
        const f = c > 0 ? 1 / Math.max(1 - c, 0.0009765625) : 1 + c;
        for (let i = 0; i < px.length; i++) px[i] = (px[i] + b - 0.5) * f + 0.5;
        break;
      }
      case 'shadows':
      case 'highlights': {
        const a = num(e.amount, 0, -1, 1) * 0.5;
        const sh = e.edit === 'shadows';
        point((i) => {
          const l = clamp(0, (px[i] + px[i + 1] + px[i + 2]) / 3, 1);
          const d = a * (sh ? (1 - l) ** 2 : l * l);
          px[i] += d;
          px[i + 1] += d;
          px[i + 2] += d;
        });
        break;
      }
      case 'hueSaturation': {
        const ang = num(e.hue, 0, -1, 1) * Math.PI;
        const sat = num(e.saturation, 0, -1, 1);
        const [s, c, r3] = [Math.sin(ang), Math.cos(ang), Math.sqrt(3)];
        const [wx, wy, wz] = [2 * c, -r3 * s - c, r3 * s - c].map((v) => (v + 1) / 3);
        const k = sat > 0 ? 1 - 1 / (1.001 - sat) : -sat;
        point((i) => {
          const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
          const nr = r * wx + g * wy + b * wz;
          const ng = r * wz + g * wx + b * wy;
          const nb = r * wy + g * wz + b * wx;
          const avg = (nr + ng + nb) / 3;
          px[i] = nr + (avg - nr) * k;
          px[i + 1] = ng + (avg - ng) * k;
          px[i + 2] = nb + (avg - nb) * k;
        });
        break;
      }
      case 'warmth': {
        const a = num(e.amount, 0, -1, 1);
        point((i) => {
          px[i] *= 1 + a * 0.3;
          px[i + 2] *= 1 - a * 0.3;
        });
        break;
      }
      case 'vibrance': {
        const a = num(e.amount, 0, -1, 1);
        point((i) => {
          const mx = Math.max(px[i], px[i + 1], px[i + 2]);
          const amt = (mx - (px[i] + px[i + 1] + px[i + 2]) / 3) * (-a * 3);
          for (let c = 0; c < 3; c++) px[i + c] += (mx - px[i + c]) * amt;
        });
        break;
      }
      case 'sepia': {
        const a = num(e.amount, 1, 0, 1);
        point((i) => {
          const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
          px[i] = r * (1 - 0.607 * a) + g * 0.769 * a + b * 0.189 * a;
          px[i + 1] = r * 0.349 * a + g * (1 - 0.314 * a) + b * 0.168 * a;
          px[i + 2] = r * 0.272 * a + g * 0.534 * a + b * (1 - 0.869 * a);
        });
        break;
      }
      case 'grayscale':
        point((i) => (px[i] = px[i + 1] = px[i + 2] = (px[i] + px[i + 1] + px[i + 2]) / 3));
        break;
      case 'invert':
        for (let i = 0; i < px.length; i++) px[i] = 1 - px[i];
        break;
      case 'vignette': {
        const size = num(e.size, 0.5, 0, 1);
        const amount = num(e.amount, 0.5, 0, 1);
        const e1 = size * 0.799;
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const [dx, dy] = [(x + 0.5) / w - 0.5, (y + 0.5) / h - 0.5];
            const d = Math.sqrt(dx * dx + dy * dy) * (amount + size);
            const t = clamp(0, (d - 0.8) / (e1 - 0.8), 1);
            const m = t * t * (3 - 2 * t);
            const i = (y * w + x) * 3;
            px[i] *= m;
            px[i + 1] *= m;
            px[i + 2] *= m;
          }
        break;
      }
      case 'blur': {
        const r = num(e.radius, 0, 0, 100);
        if (r > 0) px.set(gaussian(px, w, h, r));
        break;
      }
      case 'sharpen': {
        const r = num(e.radius, 2, 0, 50);
        const s = num(e.amount, 0.5, 0, 5);
        if (r <= 0 || s <= 0) break;
        const bl = gaussian(px, w, h, r);
        for (let i = 0; i < px.length; i++) px[i] = bl[i] + (px[i] - bl[i]) * (1 + s);
        break;
      }
    }
  }
  return px;
}

/** Geometry edits -> ffmpeg filters + resulting size (vips rotate/flip/crop semantics). */
export function geometry(edits, w, h) {
  const filters = [];
  for (const e of edits) {
    if (e.edit === 'rotate') {
      const a = normAngle(num(e.angle, 0, -1e6, 1e6));
      const q = Math.round(a / 90);
      if (a === 0) continue;
      if (Math.abs(a - q * 90) < 1e-9) {
        filters.push({ 1: 'transpose=1', '-1': 'transpose=2', 2: 'hflip,vflip' }[q]);
        if (q !== 2) [w, h] = [h, w];
        continue;
      }
      const rad = (a * Math.PI) / 180;
      const [c, s] = [Math.abs(Math.cos(rad)), Math.abs(Math.sin(rad))];
      [w, h] = [Math.round(w * c + h * s), Math.round(w * s + h * c)];
      filters.push(`rotate=a=${rad.toFixed(9)}:ow=${w}:oh=${h}:c=black`);
    } else if (e.edit === 'flip') {
      filters.push(e.direction === 'vertical' ? 'vflip' : 'hflip');
    } else if (e.edit === 'crop') {
      const x = num(e.x, 0, 0, 1 - 1e-4);
      const y = num(e.y, 0, 0, 1 - 1e-4);
      const cw = num(e.width, 1, 1e-4, 1 - x);
      const ch = num(e.height, 1, 1e-4, 1 - y);
      const left = Math.min(w - 1, Math.max(0, Math.round(x * w)));
      const top = Math.min(h - 1, Math.max(0, Math.round(y * h)));
      const nw = Math.min(w - left, Math.max(1, Math.round(cw * w)));
      const nh = Math.min(h - top, Math.max(1, Math.round(ch * h)));
      filters.push(`crop=${nw}:${nh}:${left}:${top}`);
      [w, h] = [nw, nh];
    }
  }
  return { filters, w, h };
}

export function validateEdits(edits) {
  if (!Array.isArray(edits) || edits.length > 32) throw badRequest('Invalid edits');
  for (const e of edits)
    if (!e || typeof e !== 'object' || ![...PIXEL, ...GEOMETRY].includes(e.edit))
      throw badRequest(`Unknown edit: ${String(e?.edit).slice(0, 64)}`);
}

/** Split a PAM (P7) image into size + raw RGB bytes. */
export function parsePam(buf) {
  const end = buf.indexOf('ENDHDR\n');
  if (end < 0) return null;
  const head = buf.subarray(0, end).toString();
  const w = +/WIDTH (\d+)/.exec(head)?.[1];
  const h = +/HEIGHT (\d+)/.exec(head)?.[1];
  const data = buf.subarray(end + 7, end + 7 + w * h * 3);
  return w && h && data.length === w * h * 3 ? { w, h, data } : null;
}

async function decode(ctx, n) {
  const src = ctx.abs(n.path);
  const { out: o } = await exiftool(ctx.et, ['-n', '-s3', '-Orientation', src]);
  const orient = ORIENT[+o.toString().trim()];
  const pam = (file, vf) =>
    run(ctx.ff.ffmpeg, [
      '-v',
      'error',
      '-noautorotate',
      '-i',
      file,
      '-frames:v',
      '1',
      ...(vf ? ['-vf', vf] : []),
      '-f',
      'image2pipe',
      '-c:v',
      'pam',
      '-pix_fmt',
      'rgb24',
      '-',
    ]).then((r) => (r.code === 0 ? parsePam(r.out) : null));
  // HEIC/RAW that ffmpeg can't decode: the (already oriented) 4096 preview
  const img = (await pam(src, orient)) ?? (await pam(await ctx.previews.get(n.id, src, false, 4096, 4096, false)));
  if (!img) throw new HttpError(415, 'Cannot decode image');
  return img;
}

function encodeArgs(fmt, quality) {
  switch (fmt) {
    case 'jpg':
      return ['-c:v', 'mjpeg', '-qmin', '1', '-q:v', String(clamp(2, Math.round((100 - quality) / 4), 31))];
    case 'png':
      return ['-c:v', 'png'];
    case 'webp':
      return ['-c:v', 'libwebp', '-quality', String(quality)];
    case 'avif':
      return [
        '-c:v',
        'libaom-av1',
        '-still-picture',
        '1',
        '-cpu-used',
        '6',
        '-crf',
        String(Math.round(63 - quality * 0.6)),
      ];
  }
}

function encode(ffmpeg, { w, h, data }, filters, args, out) {
  return new Promise((resolve, reject) => {
    const vf = [...filters, 'format=' + (args[1] === 'png' ? 'rgb24' : args[1] === 'mjpeg' ? 'yuvj444p' : 'yuv420p')];
    const p = spawn(
      ffmpeg,
      ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-i', '-'].concat([
        '-vf',
        vf.join(','),
        '-frames:v',
        '1',
        ...args,
        '-update',
        '1',
        out,
      ]),
      { windowsHide: true },
    );
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new HttpError(500, `ffmpeg: ${err.trim().slice(-300)}`))));
    p.stdin.on('error', () => {});
    p.stdin.end(data);
  });
}

/** PUT /image/edit/:id. Returns the id of the saved file. */
export async function editImage(ctx, n, body) {
  const { name, extension, edits = [], quality = 90, copy = false } = body ?? {};
  const fmt = FORMATS[String(extension).toLowerCase()];
  if (!fmt) throw badRequest('Invalid image format');
  if (!(quality >= 10 && quality <= 100)) throw badRequest('Invalid quality');
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || /[\0-\x1f]/.test(name))
    throw badRequest('Invalid file name');
  cleanRel(name);
  validateEdits(edits);
  if (!n.mime?.startsWith('image/')) throw new HttpError(403, 'Not an image');

  const live = !!ctx.db.q('SELECT liveid FROM media WHERE id = ?').get(n.id)?.liveid;
  const dir = parentRel(n.path);
  const join = (f) => (dir ? `${dir}/${f}` : f);
  // A new format never overwrites the original in place (a .jpg must not end up holding PNG bytes)
  const sameFormat = FORMATS[n.name.split('.').pop().toLowerCase()] === fmt;
  const asCopy = copy || live || name !== n.name || !sameFormat;
  const rel = asCopy ? ctx.lib.freeRel(join(name)) : n.path;

  const img = await decode(ctx, n);
  const pixel = edits.filter((e) => PIXEL.includes(e.edit));
  if (pixel.length) {
    const f = new Float32Array(img.data.length);
    for (let i = 0; i < f.length; i++) f[i] = img.data[i] / 255;
    applyPixels(f, img.w, img.h, pixel);
    img.data = Buffer.alloc(f.length);
    for (let i = 0; i < f.length; i++) img.data[i] = Math.round(clamp(0, f[i], 1) * 255);
  }
  const geo = geometry(
    edits.filter((e) => GEOMETRY.includes(e.edit)),
    img.w,
    img.h,
  );

  const tmp = ctx.abs(join(`.frames-edit-${randomBytes(4).toString('hex')}.${fmt}`));
  try {
    await encode(ctx.ff.ffmpeg, img, geo.filters, encodeArgs(fmt, quality), tmp);
    // Carry metadata over; orientation is baked in, stale thumbnails and live-photo links dropped
    const drop = ['Orientation', 'ThumbnailImage', 'PreviewImage', 'XMP-GCamera:all', 'XMP-Container:all'];
    if (live) drop.push('MakerNotes:all', 'ContentIdentifier');
    await exiftool(ctx.et, [
      '-overwrite_original',
      '-TagsFromFile',
      ctx.abs(n.path),
      '-all:all',
      ...drop.map((t) => `--${t}`),
      ...(fmt === 'jpg' ? [`-ExifImageWidth=${geo.w}`, `-ExifImageHeight=${geo.h}`] : []),
      tmp,
    ]);
    fs.renameSync(tmp, ctx.abs(rel));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return ctx.indexer.indexPath(rel);
}
