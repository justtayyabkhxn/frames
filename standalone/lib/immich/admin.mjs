import { readJson } from '../http.mjs';
/** Admin pages for one local user: queues mapped to Frames' indexer and AI engine, server stats, and the rest stubbed. */
const QUEUES = {
  library: 'index',
  metadataExtraction: 'index',
  thumbnailGeneration: 'none',
  smartSearch: 'ai',
  faceDetection: 'ai',
  facialRecognition: 'ai',
  duplicateDetection: 'none',
};
const ALL_QUEUES = [
  ...'thumbnailGeneration metadataExtraction videoConversion faceDetection facialRecognition smartSearch duplicateDetection backgroundTask peopleBackfill storageTemplateMigration migration search sidecar library notifications backupDatabase ocr petDetection petRecognition workflow integrityCheck editor storageBackendMigration classification qualityAnalysis spatialScene'.split(
    ' ',
  ),
];
const zero = { active: 0, completed: 0, delayed: 0, failed: 0, paused: 0, waiting: 0 };

export function registerAdmin(router, ctx, A) {
  const { db } = ctx;

  const stats = (kind) => {
    const s = ctx.indexer.status ?? {};
    if (kind === 'index') {
      const busy = s.phase && s.phase !== 'idle';
      return {
        ...zero,
        active: busy ? 1 : 0,
        waiting: Math.max(0, (s.total ?? 0) - (s.done ?? 0)),
        completed: s.count ?? 0,
      };
    }
    if (kind === 'ai') {
      const ai = s.ai ?? {};
      return {
        ...zero,
        active: ai.state === 'indexing' ? 1 : 0,
        waiting: ai.queued ?? 0,
        completed: ai.indexed ?? 0,
        failed: ai.failed ?? 0,
      };
    }
    return zero;
  };
  const queue = (name) => ({ name, isPaused: false, statistics: stats(QUEUES[name]) });
  const start = () => void ctx.indexer.scan?.();

  A.get('/queues', () => Object.keys(QUEUES).map(queue));
  A.get('/queues/:name', (req, { name }) => queue(name));
  A.put('/queues/:name', (req, { name }) => queue(name));
  A.get('/queues/:name/jobs', () => []);
  A.del('/queues/:name/jobs', () => null);
  // Legacy job endpoints: "start" rescans the library, which also feeds the AI engine
  // Gallery's admin pages read every queue by name, so list them all (unknown ones idle)
  A.get('/jobs', () =>
    Object.fromEntries(
      ALL_QUEUES.map((n) => [
        n,
        { jobCounts: stats(QUEUES[n]), queueStatus: { isActive: !!stats(QUEUES[n]).active, isPaused: false } },
      ]),
    ),
  );
  A.put('/jobs/:name', async (req, { name }) => {
    if ((await readJson(req)).command === 'start') start();
    return { jobCounts: stats(QUEUES[name]), queueStatus: { isActive: true, isPaused: false } };
  });
  A.post('/jobs', () => (start(), null));

  A.get('/server/statistics', () => {
    const r = db
      .q(
        `SELECT sum(m.isvideo = 0) AS photos, sum(m.isvideo = 1) AS videos,
           coalesce(sum(CASE WHEN m.isvideo = 0 THEN n.size END), 0) AS up, coalesce(sum(CASE WHEN m.isvideo = 1 THEN n.size END), 0) AS uv
         FROM media m JOIN nodes n ON n.id = m.id WHERE m.livevideo = 0`,
      )
      .get();
    const user = ctx.immichUser();
    const usage = {
      photos: r.photos ?? 0,
      videos: r.videos ?? 0,
      usage: r.up + r.uv,
      usagePhotos: r.up,
      usageVideos: r.uv,
    };
    return { ...usage, usageByUser: [{ ...usage, userId: user.id, userName: user.name, quotaSizeInBytes: null }] };
  });

  A.get('/admin/users', () => [ctx.immichUser()]);
  A.get('/admin/users/:id', () => ctx.immichUser());
  A.get('/admin/users/:id/preferences', () => ctx.immichPrefs());
  A.get('/admin/users/:id/statistics', () => {
    const r = db
      .q('SELECT sum(isvideo = 0) AS images, sum(isvideo = 1) AS videos FROM media WHERE livevideo = 0')
      .get();
    return { images: r.images ?? 0, videos: r.videos ?? 0, total: (r.images ?? 0) + (r.videos ?? 0) };
  });
  A.get('/system-config/storage-template-options', () => ({
    yearOptions: ['y', 'yy'],
    monthOptions: ['M', 'MM', 'MMM', 'MMMM'],
    weekOptions: ['W', 'WW'],
    dayOptions: ['d', 'dd'],
    hourOptions: ['h', 'hh', 'H', 'HH'],
    minuteOptions: ['m', 'mm'],
    secondOptions: ['s', 'ss', 'SSS'],
    presetOptions: ['{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}'],
  }));

  // Hidden in Frames' UI; valid empty answers if a page is opened directly
  for (const p of [
    '/libraries',
    '/plugins',
    '/plugins/methods',
    '/plugins/templates',
    '/workflows',
    '/workflows/triggers',
  ])
    A.get(p, () => []);
  A.get('/admin/integrity/summary', () => ({ checksum_mismatch: 0, missing_file: 0, untracked_file: 0 }));
  A.get('/storage-migration/status', () => ({ isRunning: false }));
  A.get('/storage-migration/estimate', () => ({ fileCount: 0, totalSize: 0 }));
}
