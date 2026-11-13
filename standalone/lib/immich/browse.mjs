import path from 'node:path';
import { ASSET_SELECT } from './timeline.mjs';

const MAX_PLACES = 50;
const hidden = (rel) => rel.split('/').some((p) => p.startsWith('.'));

/** Explore (places) and Folders for Gallery's UI. */
export function registerBrowse(router, ctx, A) {
  const { db } = ctx;
  // Gallery's folder tree uses the library folder's own name as the top level
  const top = () => path.basename(ctx.root) || 'Library';
  const toRel = (p) => {
    const parts = String(p ?? '')
      .split('/')
      .filter(Boolean);
    return parts[0] === top() ? parts.slice(1).join('/') : parts.join('/');
  };

  A.get('/view/folder/unique-paths', () => {
    const dirs = db
      .q(
        'SELECT DISTINCT p.path FROM nodes p JOIN nodes n ON n.parent = p.id JOIN media m ON m.id = n.id WHERE m.livevideo = 0',
      )
      .all()
      .map((r) => r.path)
      .filter((rel) => !hidden(rel));
    return dirs.map((rel) => (rel ? `${top()}/${rel}` : top()));
  });

  A.get('/view/folder', (req, _, q) => {
    const rel = toRel(q.get('path'));
    const dir = rel
      ? db.q('SELECT id FROM nodes WHERE path = ? AND dir = 1').get(rel)
      : db.q("SELECT id FROM nodes WHERE path = '' AND dir = 1").get();
    if (!dir) return [];
    return db
      .q(
        `SELECT ${ASSET_SELECT} FROM media m JOIN nodes n ON n.id = m.id WHERE n.parent = ? AND m.livevideo = 0 ORDER BY m.datetaken DESC`,
      )
      .all(dir.id)
      .map((r) => ctx.assetDtoFromRow(r));
  });

  /** One card per city (the most specific place name), newest photo as its cover. */
  A.get('/search/explore', () => {
    const cities = new Map();
    const rows = db
      .q(
        `SELECT ${ASSET_SELECT} FROM media m JOIN nodes n ON n.id = m.id
          WHERE m.livevideo = 0 AND m.lat IS NOT NULL ORDER BY m.datetaken DESC`,
      )
      .iterate();
    for (const r of rows) {
      const city = ctx.addressOf?.(r.id)?.[0];
      if (city && !cities.has(city)) cities.set(city, r);
      if (cities.size >= MAX_PLACES) break;
    }
    return [
      {
        fieldName: 'exifInfo.city',
        items: [...cities].map(([value, r]) => ({ value, data: ctx.assetDtoFromRow(r) })),
      },
    ];
  });
}
