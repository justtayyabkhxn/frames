const EXIF_DATE = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/;

/** Local wall-clock "YYYY-MM-DDTHH:MM:SS" from EXIF, else from file mtime. */
export function takenFrom(meta, mtimeMs) {
  for (const k of ['DateTimeOriginal', 'CreateDate', 'MediaCreateDate']) {
    const m = EXIF_DATE.exec(String(meta[k] ?? ''));
    if (m && +m[1] > 1900 && m[2] !== '00' && m[3] !== '00') return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  }
  const off = new Date(mtimeMs).getTimezoneOffset() * 60000;
  return new Date(mtimeMs - off).toISOString().slice(0, 19);
}

/** Display dimensions, swapped for rotated photos/videos. */
export function dims(meta) {
  let w = meta.ImageWidth | 0;
  let h = meta.ImageHeight | 0;
  if ([5, 6, 7, 8].includes(meta.Orientation) || [90, 270].includes(Math.abs(meta.Rotation))) [w, h] = [h, w];
  return [w || 1, h || 1];
}

/** null = whole file, false = unsatisfiable, else {start, end} inclusive. */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!m || (!m[1] && !m[2])) return null;
  const start = m[1] ? +m[1] : Math.max(0, size - +m[2]);
  const end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
  return start > end || start >= size ? false : { start, end };
}
