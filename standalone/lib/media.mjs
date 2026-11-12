import fs from 'node:fs';
import path from 'node:path';
import { badRequest, contentDisposition, HttpError, json, notFound, readJson, sendFile } from './http.mjs';
import { editImage } from './media-edit.mjs';
import { Vod } from './media-vod.mjs';
import { run } from './tools.mjs';

const API = '/apps/memories/api';
const MP4_ATOMS = ['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'];

/** Embedded motion-photo video: offset of an MP4 appended after the image (Google MVIMG / Pixel, Samsung). */
export function trailerOffset(buf, imageEnd = 0) {
  for (let i = buf.indexOf('ftyp', Math.max(8, imageEnd)); i >= 4; i = buf.indexOf('ftyp', i + 4)) {
    const size = buf.readUInt32BE(i - 4);
    if (size >= 8 && size < 256 && MP4_ATOMS.includes(buf.toString('latin1', i - 4 + size + 4, i - 4 + size + 8)))
      return i - 4;
  }
  return -1;
}

export function registerMedia(router, ctx) {
  const { db, lib } = ctx;
  const vod = ctx.ff ? new Vod(ctx) : null;
  const liveDir = path.join(ctx.dataDir, 'live');
  fs.rmSync(liveDir, { recursive: true, force: true });

  const videoNode = (id) => {
    const n = lib.mustNode(id);
    if (!n.mime?.startsWith('video/')) throw badRequest('Not a video');
    if (!vod) throw new HttpError(503, 'ffmpeg not available');
    return n;
  };
  const codecsOf = (p) => (p.get('codecs') ?? '').split(',').filter(Boolean);
  const passQuery = (p) => (p.get('codecs') ? `?${new URLSearchParams({ codecs: p.get('codecs') })}` : '');

  /* ---------------- HLS ---------------- */
  router.add('GET', `${API}/video/transcode/:client/:fileid/:file`, async (req, res, { fileid, file }, url) => {
    const n = videoNode(fileid);
    const p = url.searchParams;
    const codecs = codecsOf(p);
    if (file.endsWith('.m3u8')) {
      const body = await vod.playlist(n, codecs, file, passQuery(p));
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    let m;
    if ((m = /^([a-z0-9]+)-init\.mp4$/.exec(file)))
      return sendFile(req, res, await vod.init(n, codecs, m[1]), { type: 'video/mp4', cache: 'no-store' });
    if ((m = /^([a-z0-9]+)-(\d+)\.m4s$/.exec(file)))
      return sendFile(req, res, await vod.segment(n, codecs, m[1], Number(m[2])), {
        type: 'video/iso.segment',
        cache: 'no-store',
      });
    throw notFound();
  });

  router.add('GET', `${API}/video/storyboard/:client/:fileid/:file`, async (req, res, { fileid, file }, url) => {
    const r = await vod.storyboard(videoNode(fileid), file, passQuery(url.searchParams));
    if (r.vtt) {
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(r.vtt);
    }
    sendFile(req, res, r.file, { type: 'image/jpeg' });
  });

  /* ---------------- live photos ---------------- */
  /** Paired Apple MOV: same ContentIdentifier, same folder (prefer same stem). */
  const pairedVideo = (n, liveid) => {
    const stem = n.name.replace(/\.[^.]+$/, '').toLowerCase();
    const vids = db
      .q('SELECT n.* FROM media m JOIN nodes n ON n.id = m.id WHERE m.liveid = ? AND m.isvideo = 1 AND n.parent IS ?')
      .all(liveid, n.parent);
    return vids.find((v) => v.name.replace(/\.[^.]+$/, '').toLowerCase() === stem) ?? vids[0] ?? null;
  };

  const pending = new Map();
  const once = (file, fn) => {
    if (fs.existsSync(file)) return file;
    if (!pending.has(file)) {
      fs.mkdirSync(liveDir, { recursive: true });
      pending.set(
        file,
        fn().finally(() => pending.delete(file)),
      );
    }
    return pending.get(file);
  };

  /** Extract the video embedded in a motion photo into the cache. */
  const extract = (n) =>
    once(path.join(liveDir, `${n.id}-${n.etag}.mp4`), async () => {
      const src = lib.abs(n.path);
      const out = path.join(liveDir, `${n.id}-${n.etag}.mp4`);
      for (const tag of ['MotionPhotoVideo', 'EmbeddedVideoFile']) {
        const r = await run(ctx.et, ['-b', `-${tag}`, '-charset', 'filename=utf8', src]);
        if (r.out.length > 1024) return (fs.writeFileSync(out, r.out), out);
      }
      // ponytail: reads the whole photo into memory; motion photos are a few MB
      const buf = fs.readFileSync(src);
      const at = trailerOffset(buf, n.mime === 'image/jpeg' ? buf.indexOf(Buffer.from([0xff, 0xd9])) : 0);
      if (at < 0) throw notFound('No embedded video');
      fs.writeFileSync(out, buf.subarray(at));
      return out;
    });

  /** H.264/AAC MP4 version of a short clip for browsers that can't play its codec. */
  const toH264 = (key, src) =>
    once(path.join(liveDir, `${key}-h264.mp4`), async () => {
      const out = path.join(liveDir, `${key}-h264.mp4`);
      const tmp = `${out}.tmp.mp4`;
      const r = await run(ctx.ff.ffmpeg, [
        ...['-v', 'error', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264'],
        ...['-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'],
        ...['-c:a', 'aac', '-ac', '2', '-movflags', '+faststart', tmp],
      ]);
      if (r.code !== 0) throw new HttpError(500, `ffmpeg: ${r.err.trim().slice(-300)}`);
      fs.renameSync(tmp, out);
      return out;
    });

  router.add('GET', `${API}/video/livephoto/:fileid`, async (req, res, { fileid }, url) => {
    const p = url.searchParams;
    const n = lib.mustNode(fileid);
    const liveid = p.get('liveid') || db.q('SELECT liveid FROM media WHERE id = ?').get(n.id)?.liveid;
    if (!liveid) throw badRequest('Not a live photo');

    let file;
    let key;
    let name;
    if (liveid.startsWith('self__')) {
      if (p.get('format') === 'json') throw badRequest('Invalid format');
      file = await extract(n);
      key = `${n.id}-${n.etag}`;
      name = `${n.name}.mp4`;
    } else {
      const v = pairedVideo(n, liveid);
      if (!v) throw notFound('Live video not found');
      if (p.get('format') === 'json')
        return json(res, { fileid: v.id, etag: v.etag, basename: v.name, mimetype: v.mime });
      file = lib.abs(v.path);
      key = `${v.id}-${v.etag}`;
      name = v.name;
    }

    // Playback: transcode when the browser can't decode this codec
    if (p.has('transcode') && vod) {
      const codecs = codecsOf(p);
      const probe = await vod.probe({ id: key, etag: 'live', path: '' }, false, file).catch(() => null);
      if (probe && !(codecs.length ? codecs : ['h264']).includes(probe.codec)) file = await toH264(key, file);
      return sendFile(req, res, file, { type: 'video/mp4', cache: 'private, max-age=86400' });
    }
    sendFile(req, res, file, {
      type: name.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4',
      headers: { 'Content-Disposition': contentDisposition(name, true) },
    });
  });

  /* ---------------- photo editor ---------------- */
  router.add('PUT', `${API}/image/edit/:id`, async (req, res, { id }) => {
    if (!ctx.ff) throw new HttpError(503, 'ffmpeg not available');
    const newId = await editImage(ctx, lib.mustNode(id), await readJson(req));
    if (!newId) throw new HttpError(500, 'Saved file could not be indexed');
    json(res, ctx.info(newId, new URLSearchParams('basic=1')));
  });
}
