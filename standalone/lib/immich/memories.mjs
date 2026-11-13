import { notFound } from '../http.mjs';
import { fromUuid, toUuid } from './ids.mjs';
import { ASSET_SELECT } from './timeline.mjs';

const DAY = 86400;
const MAX_ASSETS = 100;
const notArchived = 'n.archived = 0';

/**
 * "On this day" memories for `today`: one per earlier year with photos within Frames' day range
 * of today's date. Memory ids encode the year and the day, so they are stable for that day.
 */
export function memoriesFor(ctx, today = new Date()) {
  const prefs = ctx.immichPrefs();
  if (!prefs.memories.enabled || prefs.memories.types?.on_this_day === false) return [];
  const range = Number(ctx.db.getKv('user.onthisdayDayRange', 3)) || 0;
  const y = today.getUTCFullYear();
  const owner = ctx.immichUser().id;
  const showAt = new Date(Date.UTC(y, today.getUTCMonth(), today.getUTCDate())).toISOString();
  const hideAt = new Date(Date.parse(showAt) + DAY * 1000).toISOString();
  const out = [];
  const oldest = ctx.db.q('SELECT min(datetaken) AS t FROM media').get().t;
  if (oldest == null) return out;
  for (let year = y - 1; year >= new Date(oldest * 1000).getUTCFullYear(); year--) {
    const mid = Date.UTC(year, today.getUTCMonth(), today.getUTCDate()) / 1000;
    const rows = ctx.db
      .q(
        `SELECT ${ASSET_SELECT} FROM media m JOIN nodes n ON n.id = m.id
         WHERE m.livevideo = 0 AND ${notArchived} AND m.datetaken >= ? AND m.datetaken < ?
         ORDER BY m.datetaken LIMIT ${MAX_ASSETS}`,
      )
      .all(mid - range * DAY, mid + (range + 1) * DAY);
    if (!rows.length) continue;
    const memoryAt = new Date(mid * 1000).toISOString();
    out.push({
      id: toUuid('memory', year * 1000 + Math.floor((mid - Date.UTC(year, 0, 1) / 1000) / DAY)),
      type: 'on_this_day',
      data: { year },
      memoryAt,
      showAt,
      hideAt,
      createdAt: showAt,
      updatedAt: showAt,
      ownerId: owner,
      isSaved: false,
      assets: rows.map((r) => ctx.assetDtoFromRow(r)),
    });
  }
  return out;
}

export function registerMemories(router, ctx, A) {
  /** The browser's own day (?for=), so evenings west of UTC don't show tomorrow's memories. */
  const day = (q) => {
    const d = new Date(q?.get('for') ?? '');
    return Number.isNaN(d.getTime()) ? new Date(Date.now() - new Date().getTimezoneOffset() * 60000) : d;
  };
  const list = (q) => {
    let all = memoriesFor(ctx, day(q));
    if (q.get('id')) all = all.filter((m) => m.id === q.get('id'));
    if (q.get('order') === 'asc') all.reverse();
    const size = Number(q.get('size')) || all.length || 1;
    const page = Math.max(1, Number(q.get('page')) || 1);
    return all.slice((page - 1) * size, page * size);
  };
  A.get('/memories', (req, _, q) => list(q));
  A.get('/memories/statistics', (req, _, q) => ({ total: memoriesFor(ctx, day(q)).length }));
  A.get('/memories/:id', (req, { id }) => {
    fromUuid(id, 'memory');
    return memoriesFor(ctx).find((m) => m.id === id) ?? fail(notFound('Memory not found'));
  });
  // Memories are generated from the library each day; seen/saved state is not kept
  A.put('/memories/:id', (req, { id }) => memoriesFor(ctx).find((m) => m.id === id) ?? fail(notFound()));
  A.del('/memories/:id', () => null);
  A.del('/memories/:id/assets', () => []);
}

const fail = (e) => {
  throw e;
};
