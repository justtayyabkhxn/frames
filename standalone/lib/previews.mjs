import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exiftool, run } from './tools.mjs';

const FIT = [256, 512, 1024, 2048, 4096];
const SQUARE = [64, 128, 256, 512, 1024];
const BASE = 1024;
const SCREEN = 2048;

/** Cache key of the tier serving request (x, y); non-positive sizes mean the largest screen preview. */
export function previewKey(x, y, square) {
  const need = Math.max(x, y);
  const tiers = square ? SQUARE : FIT;
  const t = tiers.find((s) => s >= (need > 0 ? need : SCREEN)) ?? tiers.at(-1);
  return `${square ? 's' : 'f'}${t}`;
}

const fitFilter = (t) => `scale=w=min(${t}\\,iw):h=min(${t}\\,ih):force_original_aspect_ratio=decrease`;
const sqFilter = (t) => `scale=w=${t}:h=${t}:force_original_aspect_ratio=increase,crop=${t}:${t}`;

/** Concurrency limiter. */
export function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) => new Promise((resolve, reject) => (queue.push({ fn, resolve, reject }), next()));
}

export class Previews {
  constructor({ dir, ff, et }) {
    this.dir = dir;
    this.ff = ff;
    this.et = et;
    this.limit = limiter(Math.max(2, os.cpus().length));
    this.pending = new Map();
  }

  file(id, key) {
    return path.join(this.dir, String(id).slice(-2), `${id}-${key}.jpg`);
  }

  remove(id) {
    const d = path.join(this.dir, String(id).slice(-2));
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d))
      if (f.startsWith(`${id}-`))
        try {
          fs.rmSync(path.join(d, f), { force: true });
        } catch {} // open elsewhere (Windows won't delete it): skipped, and overwritten by the next generate
  }

  /** ffmpeg args to read one frame of `src` (a bit into videos, avoiding black first frames). */
  input(src, video) {
    return ['-v', 'error', '-y', ...(video ? ['-ss', '1'] : []), '-i', src];
  }

  /** Index-time generation: base (fit 1024) + timeline sizes in one decode. */
  async generate(id, src, video) {
    if (!this.ff) return false;
    fs.mkdirSync(path.dirname(this.file(id, 'b')), { recursive: true });
    const outs = [
      ['base', fitFilter(BASE)],
      ['f512', fitFilter(512)],
      ['s256', sqFilter(256)],
    ];
    const graph =
      `[0:v]split=${outs.length}${outs.map((_, i) => `[i${i}]`).join('')};` +
      outs.map(([, f], i) => `[i${i}]${f}[o${i}]`).join(';');
    const args = (s, v) => [
      ...this.input(s, v),
      '-filter_complex',
      graph,
      ...outs.flatMap(([k], i) => ['-map', `[o${i}]`, '-frames:v', '1', '-q:v', '3', this.file(id, k)]),
    ];

    let r = await run(this.ff.ffmpeg, args(src, video));
    if (r.code !== 0 && video) r = await run(this.ff.ffmpeg, args(src, false)); // shorter than 1s
    if (r.code !== 0 && !video) {
      // RAW / unsupported HEIC: use the camera's embedded preview
      const tmp = this.file(id, 'embedded');
      for (const tag of ['-JpgFromRaw', '-PreviewImage', '-ThumbnailImage']) {
        const { out } = await exiftool(this.et, ['-b', tag, src]);
        if (!out.length) continue;
        fs.writeFileSync(tmp, out);
        r = await run(this.ff.ffmpeg, args(tmp, false));
        if (r.code === 0) break;
      }
      fs.rmSync(tmp, { force: true });
    }
    if (r.code !== 0) for (const [k] of outs) fs.rmSync(this.file(id, k), { force: true });
    return r.code === 0;
  }

  /** Path of a cached preview for request (x, y, a), generating it if needed. */
  async get(id, src, video, x, y, square) {
    const key = previewKey(x, y, square);
    const t = Number(key.slice(1));
    const out = this.file(id, key);
    if (fs.existsSync(out)) return out;

    const job = `${id}-${key}`;
    if (!this.pending.has(job)) {
      this.pending.set(
        job,
        this.limit(async () => {
          const base = this.file(id, 'base');
          if (!fs.existsSync(base)) await this.generate(id, src, video);
          if (fs.existsSync(out)) return;
          const from = t <= BASE && fs.existsSync(base) ? base : src;
          const useVideo = from === src && video;
          fs.mkdirSync(path.dirname(out), { recursive: true });
          const r = await run(this.ff.ffmpeg, [
            ...this.input(from, useVideo),
            '-vf',
            square ? sqFilter(t) : fitFilter(t),
            '-frames:v',
            '1',
            '-q:v',
            '3',
            out,
          ]);
          // Original not decodable by ffmpeg (RAW/HEIC): best effort from base
          if (r.code !== 0 && from !== base && fs.existsSync(base)) fs.copyFileSync(base, out);
        }).finally(() => this.pending.delete(job)),
      );
    }
    await this.pending.get(job);
    return fs.existsSync(out) ? out : null;
  }
}
