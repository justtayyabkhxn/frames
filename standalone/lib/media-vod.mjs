import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { HttpError, notFound } from './http.mjs';
import { run } from './tools.mjs';

/**
 * On-demand HLS (fMP4) in the go-vod URL scheme the frontend expects:
 * index.m3u8 -> <q>.m3u8 -> <q>-init.mp4 + <q>-NNNNNN.m4s.
 * "direct" stream-copies browser-playable codecs on the source keyframe grid;
 * "<h>p" re-encodes with libx264 on a fixed CHUNK-second keyframe grid.
 * Segment args mirror go-vod/ffmpeg/args.go (SegmentArgs).
 */

export const CHUNK = 4;
const LADDER = [480, 720, 1080];
const COPYABLE = ['h264', 'hevc', 'av1', 'vp9'];
const LOOKAHEAD = 4; // segments past the encoder head we wait for instead of restarting
const AHEAD = 30; // a job is stopped this many segments past the last request
const MAX_JOBS = 2;
const IDLE_KILL = 20_000;
const IDLE_EVICT = 10 * 60_000;
const WAIT = 60_000;

const even = (x) => Math.max(2, Math.round(x / 2) * 2);
const pad = (n) => String(n).padStart(6, '0');

/** ffprobe JSON -> what the transcoder needs (display-oriented size). */
export function parseProbe(j) {
  const v = j?.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!v) return null;
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const rot = Number(v.side_data_list?.find((d) => d.rotation != null)?.rotation ?? v.tags?.rotate ?? 0);
  const [num, den] = String(v.avg_frame_rate || v.r_frame_rate || '')
    .split('/')
    .map(Number);
  const fps = num > 0 && den > 0 ? num / den : 30;
  const [w, h] = Math.abs(rot) % 180 === 90 ? [v.height, v.width] : [v.width, v.height];
  return {
    codec: v.codec_name,
    w,
    h,
    fps: Math.min(fps, 120),
    duration: Number(j.format?.duration ?? v.duration) || 0,
    start: Number(j.format?.start_time) || 0,
    bitrate: Number(j.format?.bit_rate) || 0,
    audio: a ? { codec: a.codec_name, channels: a.channels } : null,
  };
}

/** ffprobe packet CSV ("pts_time,flags") -> keyframe times relative to the file start. */
export function parseKeyframes(csv, start = 0) {
  const out = [];
  for (const line of csv.split(/\r?\n/)) {
    const [t, flags] = line.split(',');
    if (flags?.startsWith('K') && Number.isFinite(+t) && t !== '') out.push(+t - start);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** One segment per keyframe (the muxer cuts at each); segment 0 opens at 0. Port of go-vod CopySegments. */
export function copySegments(keys, total) {
  if (!keys.length || total <= 0) return null;
  const bounds = [0, ...keys.slice(1).filter((k) => k > 0 && k < total)];
  const segs = bounds.map((b, i) => ({ start: b, dur: (bounds[i + 1] ?? total) - b })).filter((s) => s.dur > 0);
  return segs.length ? segs : null;
}

export const uniformSegments = (total, chunk = CHUNK) =>
  Array.from({ length: Math.max(1, Math.ceil(total / chunk)) }, (_, i) => ({
    start: i * chunk,
    dur: Math.max(0.001, Math.min(chunk, total - i * chunk)),
  }));

/** Renditions for a probe: stream copy when the browser plays the codec, else an x264 ladder up to 1080p. */
export function renditions(p, codecs, copyable = true) {
  if (copyable && COPYABLE.includes(p.codec) && codecs.includes(p.codec))
    return [{ q: 'direct', copy: true, w: p.w, h: p.h, bw: p.bitrate || 8_000_000 }];
  const short = Math.min(p.w, p.h);
  const sizes = [...LADDER.filter((t) => t < short), Math.min(short, 1080)];
  return sizes.map((t) => {
    const w = even((p.w * t) / short);
    const h = even((p.h * t) / short);
    return { q: `${t}p`, t, w, h, bw: Math.round(w * h * Math.min(p.fps, 60) * 0.1) };
  });
}

export function masterPlaylist(rends, fps, query) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const r of rends)
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${r.bw},RESOLUTION=${r.w}x${r.h},FRAME-RATE=${fps.toFixed(3)}`,
      `${r.q}.m3u8${query}`,
    );
  return lines.join('\n') + '\n';
}

export function variantPlaylist(q, segs, query) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...segs.map((s) => s.dur)))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MAP:URI="${q}-init.mp4${query}"`,
  ];
  segs.forEach((s, i) => lines.push(`#EXTINF:${s.dur.toFixed(6)},`, `${q}-${pad(i)}.m4s${query}`));
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/** ffmpeg argv for one run of a rendition, starting at segment `n`; cwd is the rendition dir. */
export function segmentArgs({ src, p, r, segs, n, run: runId }) {
  const args = ['-hide_banner', '-loglevel', 'warning'];
  const at = n > 0 ? segs[n].start + (r.copy ? 0.001 : 0) : 0;
  if (at > 0) args.push('-ss', at.toFixed(6));
  args.push('-i', src, '-copyts', '-fflags', '+genpts');
  if (r.copy) {
    args.push('-map', '0:v:0', '-c:v', 'copy');
    if (p.codec === 'hevc') args.push('-tag:v', 'hvc1');
  } else {
    const scale = p.w >= p.h ? `-2:${r.t}` : `${r.t}:-2`;
    // First frame is a keyframe; then one on every CHUNK grid point (t is source time under -copyts)
    const s = p.start.toFixed(6);
    const keys = `expr:if(isnan(prev_forced_t),1,gte(t,${s}+(floor((prev_forced_t-${s})/${CHUNK}+0.5)+1)*${CHUNK}))`;
    args.push('-vf', `scale=${scale},format=yuv420p`, '-map', '0:v:0', '-c:v', 'libx264');
    args.push('-preset', 'veryfast', '-crf', '23', '-x264-params', 'scenecut=0:keyint=infinite');
    args.push('-force_key_frames', keys, '-fps_mode', 'passthrough', '-bf', '0');
  }
  if (p.audio) {
    args.push('-map', '0:a:0?');
    // Copied audio would start at the seek keyframe, not the accurate -ss point
    if (r.copy && p.audio.codec === 'aac' && p.audio.channels >= 1 && p.audio.channels <= 2) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '128k');
  }
  return [
    ...args,
    '-start_number',
    String(n),
    '-avoid_negative_ts',
    'disabled',
    '-f',
    'hls',
    // Cut at every keyframe: the source grid (copy) or the forced CHUNK grid (x264)
    '-hls_time',
    '0.001',
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    `${r.q}-init-${runId}.mp4`,
    '-hls_segment_options',
    'movflags=+frag_discont+negative_cts_offsets:use_editlist=0',
    '-hls_segment_filename',
    `${r.q}-%06d.m4s`,
    '-',
  ];
}

const deferred = () => {
  let res, rej;
  const promise = new Promise((a, b) => ((res = a), (rej = b)));
  return { promise, res, rej };
};

export class Vod {
  constructor(ctx) {
    this.ctx = ctx;
    this.dir = path.join(ctx.dataDir, 'vod');
    fs.rmSync(this.dir, { recursive: true, force: true });
    this.probes = new Map();
    this.streams = new Map();
    this.boards = new Map();
    setInterval(() => this.tick(), 5000).unref();
  }

  /** Cached probe (+ keyframes when a copy may be wanted) for a node. */
  probe(n, keyframes = false, src = this.ctx.abs(n.path)) {
    const key = `${n.id}-${n.etag}${keyframes ? '-k' : ''}`;
    if (!this.probes.has(key)) {
      const job = (async () => {
        const { ffprobe } = this.ctx.ff;
        const r = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', src]);
        const p = parseProbe(JSON.parse(r.out.toString() || '{}'));
        if (!p) throw new HttpError(415, 'No video stream');
        if (keyframes && COPYABLE.includes(p.codec)) {
          const k = await run(ffprobe, [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_entries',
            'packet=pts_time,flags',
            '-of',
            'csv=p=0',
            src,
          ]);
          p.keyframes = parseKeyframes(k.out.toString(), p.start);
        }
        return p;
      })();
      job.catch(() => this.probes.delete(key));
      this.probes.set(key, job);
    }
    return this.probes.get(key);
  }

  async rends(n, codecs) {
    const p = await this.probe(
      n,
      codecs.some((c) => COPYABLE.includes(c)),
    );
    return { p, rends: renditions(p, codecs, !!copySegments(p.keyframes ?? [], p.duration)) };
  }

  segs(p, r) {
    return r.copy ? copySegments(p.keyframes, p.duration) : uniformSegments(p.duration);
  }

  async stream(n, codecs, q) {
    const key = `${n.id}-${n.etag}-${q}`;
    let s = this.streams.get(key);
    if (!s) {
      const { p, rends } = await this.rends(n, codecs);
      const r = rends.find((x) => x.q === q);
      if (!r) throw notFound('Unknown quality');
      if (this.streams.has(key)) return this.streams.get(key);
      const dir = path.join(this.dir, `${n.id}-${n.etag}`, q);
      fs.mkdirSync(dir, { recursive: true });
      s = { key, dir, src: this.ctx.abs(n.path), p, r, segs: this.segs(p, r), done: new Set(), waiters: new Map() };
      Object.assign(s, { job: null, run: 0, init: null, initWait: deferred(), lastReq: Date.now(), lastN: 0 });
      s.initWait.promise.catch(() => {});
      this.streams.set(key, s);
    }
    s.lastReq = Date.now();
    return s;
  }

  async playlist(n, codecs, file, query) {
    if (file === 'index.m3u8') {
      const { p, rends } = await this.rends(n, codecs);
      return masterPlaylist(rends, p.fps, query);
    }
    const q = /^([a-z0-9]+)\.m3u8$/.exec(file)?.[1];
    if (!q) throw notFound();
    const s = await this.stream(n, codecs, q);
    return variantPlaylist(q, s.segs, query);
  }

  /** Path of the init segment, transcoding as needed. */
  async init(n, codecs, q) {
    const s = await this.stream(n, codecs, q);
    if (!s.init && !s.job) this.start(s, s.lastN);
    return this.timeout(s.initWait.promise);
  }

  /** Path of segment `i`, transcoding as needed. */
  async segment(n, codecs, q, i) {
    const s = await this.stream(n, codecs, q);
    if (!(i >= 0 && i < s.segs.length)) throw notFound();
    s.lastN = i;
    const file = path.join(s.dir, `${q}-${pad(i)}.m4s`);
    if (s.done.has(i)) return file;
    const j = s.job;
    if (!j || i < j.start || i > j.head + LOOKAHEAD) this.start(s, i);
    if (!s.waiters.has(i)) s.waiters.set(i, deferred());
    await this.timeout(s.waiters.get(i).promise);
    return file;
  }

  timeout(promise) {
    let t;
    return Promise.race([
      promise,
      new Promise((_, rej) => (t = setTimeout(() => rej(new HttpError(503, 'Transcode timeout')), WAIT))),
    ]).finally(() => clearTimeout(t));
  }

  start(s, i) {
    this.stop(s);
    const active = [...this.streams.values()].filter((x) => x.job);
    for (const x of active.sort((a, b) => a.lastReq - b.lastReq).slice(0, Math.max(0, active.length - MAX_JOBS + 1)))
      this.stop(x);

    const runId = ++s.run;
    const args = segmentArgs({ src: s.src, p: s.p, r: s.r, segs: s.segs, n: i, run: runId });
    const proc = spawn(this.ctx.ff.ffmpeg, args, { cwd: s.dir, windowsHide: true });
    const job = { proc, start: i, head: i - 1 };
    s.job = job;
    let err = '';
    proc.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    proc.on('error', (e) => (err += String(e)));
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      const m = /^([a-z0-9]+)-(\d+)\.m4s$/.exec(line.trim());
      if (!m || s.job !== job) return;
      const k = Number(m[2]);
      job.head = Math.max(job.head, k);
      s.done.add(k);
      if (!s.init) {
        s.init = path.join(s.dir, `${s.r.q}-init-${runId}.mp4`);
        s.initWait.res(s.init);
      }
      s.waiters.get(k)?.res();
      s.waiters.delete(k);
      if (k - s.lastN > AHEAD) this.stop(s);
    });
    proc.on('close', (code) => {
      if (code && s.job === job) console.warn(`vod ${s.key}: ffmpeg exited ${code}: ${err.trim()}`);
      if (s.job !== job) return;
      s.job = null;
      // The muxer prints the final segment only in the closing playlist write; trust the exit code
      if (code === 0) {
        for (let k = job.head + 1; k < s.segs.length; k++) s.done.add(k);
        s.init ??= path.join(s.dir, `${s.r.q}-init-${s.run}.mp4`);
        s.initWait.res(s.init);
      }
      for (const [k, w] of s.waiters) {
        if (s.done.has(k)) w.res();
        else w.rej(new HttpError(500, 'Transcode failed'));
      }
      s.waiters.clear();
    });
  }

  stop(s) {
    const j = s.job;
    if (!j) return;
    s.job = null;
    j.proc.kill();
    for (const w of s.waiters.values()) w.rej(new HttpError(503, 'Transcode restarted'));
    s.waiters.clear();
  }

  tick() {
    const now = Date.now();
    for (const s of this.streams.values()) {
      if (s.job && now - s.lastReq > IDLE_KILL) this.stop(s);
      if (!s.job && now - s.lastReq > IDLE_EVICT) {
        this.streams.delete(s.key);
        fs.rm(s.dir, { recursive: true, force: true }, () => {});
      }
    }
  }

  /* ---------------- storyboard ---------------- */

  /** go-vod storyboard plan: <=150 thumbs every >=5s, 10x10 sprites of ~160x90 tiles. */
  static plan(p) {
    const secs = p.duration > 0 ? p.duration : 5;
    const interval = Math.max(5, secs / 150);
    const count = Math.max(1, Math.ceil(secs / interval - 1e-9));
    const rows = Math.min(10, Math.ceil(count / 10));
    const aspect = p.w / p.h || 16 / 9;
    const tw = even(Math.sqrt(160 * 90 * aspect));
    const th = even(Math.sqrt((160 * 90) / aspect));
    return { secs, interval, count, rows, per: 10 * rows, sprites: Math.ceil(count / (10 * rows)), tw, th };
  }

  static vtt(pl, query) {
    const ts = (s) => new Date(Math.round(Math.max(0, s) * 1000)).toISOString().slice(11, 23);
    let out = 'WEBVTT\n';
    for (let i = 0; i < pl.count; i++) {
      const start = i * pl.interval;
      const end = i === pl.count - 1 ? pl.secs : Math.min(start + pl.interval, pl.secs);
      const tile = i % pl.per;
      const x = (tile % 10) * pl.tw;
      const y = Math.floor(tile / 10) * pl.th;
      out += `\n${ts(start)} --> ${ts(end)}\nstoryboard-${Math.floor(i / pl.per)}.jpg${query}#xywh=${x},${y},${pl.tw},${pl.th}\n`;
    }
    return out;
  }

  async storyboard(n, file, query) {
    const p = await this.probe(n);
    const pl = Vod.plan(p);
    if (file === 'storyboard.vtt') return { vtt: Vod.vtt(pl, query) };
    const k = /^storyboard-(\d+)\.jpg$/.exec(file)?.[1];
    if (k == null || +k >= pl.sprites) throw notFound();
    const dir = path.join(this.dir, `${n.id}-${n.etag}`, 'sb');
    const key = `${n.id}-${n.etag}`;
    if (!this.boards.has(key)) {
      fs.mkdirSync(dir, { recursive: true });
      const vf = `fps=1/${pl.interval.toFixed(6)}:eof_action=pass,scale=${pl.tw}:${pl.th},format=yuv420p,tile=10x${pl.rows}`;
      const job = run(this.ctx.ff.ffmpeg, [
        '-v',
        'error',
        '-y',
        '-skip_frame',
        'nokey',
        '-i',
        this.ctx.abs(n.path),
        '-an',
        '-vf',
        vf,
        '-start_number',
        '0',
        '-frames:v',
        String(pl.sprites),
        '-q:v',
        '4',
        path.join(dir, 'storyboard-%d.jpg'),
      ]);
      this.boards.set(key, job);
    }
    const r = await this.boards.get(key);
    const out = path.join(dir, `storyboard-${k}.jpg`);
    if (r.code !== 0 || !fs.existsSync(out)) {
      this.boards.delete(key); // retry on the next request instead of caching the failure
      throw notFound('Storyboard not available');
    }
    return { file: out };
  }
}
