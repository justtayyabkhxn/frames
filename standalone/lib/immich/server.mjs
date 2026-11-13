import fs from 'node:fs';
import path from 'node:path';
import { json, readJson } from '../http.mjs';
import { APP_ROOT } from '../tools.mjs';
import { toUuid } from './ids.mjs';
import { registerTimeline } from './timeline.mjs';
import { registerAssets } from './assets.mjs';
import { registerPeople } from './people.mjs';
import { registerBrowse } from './browse.mjs';
import { registerMemories } from './memories.mjs';
import { registerAdmin } from './admin.mjs';
import { registerAlbums } from './albums.mjs';
import { registerUtilities } from './utilities.mjs';
import { registerSearch } from './search.mjs';

const require = (f) => JSON.parse(fs.readFileSync(new URL(f, import.meta.url), 'utf8'));
const DEFAULTS = require('./config-defaults.json');
// Offline: the map uses Frames' own basemap tiles (rendered locally from the place data), not an online style
Object.assign(DEFAULTS.map, {
  lightStyle: '/api/frames/map-style/light.json',
  darkStyle: '/api/frames/map-style/dark.json',
});
const VIEWS = require('./config-views.json');
const MEMORY_TYPES = [
  'on_this_day',
  'recent_trip',
  'month_recap',
  'favorites_throwback',
  'on_this_day_place',
  'season_recap',
  'people_together',
  'video_moments',
  'trip_anniversary',
  'themed',
  'person_throwback',
];
/** Gallery's getDefaultPreferences(), except Frames shows People and Folders in the sidebar and has ratings on, like its old UI. */
const PREFERENCES = {
  albums: { defaultAssetOrder: 'desc' },
  folders: { enabled: true, sidebarWeb: true },
  memories: {
    enabled: true,
    duration: 5,
    types: Object.fromEntries(MEMORY_TYPES.map((k) => [k, true])),
    sidebarWeb: true,
  },
  people: { enabled: true, sidebarWeb: true, minimumFaces: 3, updateStrategy: 'everyone' },
  sharedLinks: { enabled: false, sidebarWeb: false },
  ratings: { enabled: true },
  tags: { enabled: false, sidebarWeb: false },
  emailNotifications: { enabled: false, albumInvite: false, albumUpdate: false },
  download: { archiveSize: 4 * 1024 ** 3, includeEmbeddedVideos: false },
  purchase: { showSupportBadge: false, hideBuyButtonUntil: '2100-01-01T00:00:00.000Z' },
  cast: { gCastEnabled: false },
  recentlyAdded: { sidebarWeb: false },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
export const deepMerge = (base, over) =>
  isObj(base) && isObj(over)
    ? Object.fromEntries(
        [...new Set([...Object.keys(base), ...Object.keys(over)])].map((k) => [k, deepMerge(base[k], over[k])]),
      )
    : (over ?? base);
/** Keep only the keys present in a view tree (user/public config). */
export const project = (obj, tree) =>
  Object.fromEntries(
    Object.entries(tree)
      .filter(([k]) => obj?.[k] !== undefined)
      .map(([k, sub]) => [k, sub === true ? obj[k] : project(obj[k], sub)]),
  );

const human = (n) => {
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) ((n /= 1024), i++);
  return `${n.toFixed(1)} ${u[i]}`;
};

export function registerServer(router, ctx, A) {
  const { db } = ctx;
  const version = require(pathToUrl(path.join(APP_ROOT, 'gallery', 'web', 'package.json'))).version ?? '0.0.0';
  const [major, minor, patch] = version.split('.').map(Number);
  const now = new Date(0).toISOString();

  const config = () => deepMerge(DEFAULTS, JSON.parse(db.getKv('immich.config', '{}')));
  const prefs = () => deepMerge(PREFERENCES, JSON.parse(db.getKv('immich.prefs', '{}')));
  ctx.immichConfig = config;
  ctx.immichPrefs = prefs;
  const ai = () => !!ctx.lens;
  const places = () => (ctx.placesGis?.() ?? -1) > 0;

  const user = () => ({
    id: toUuid('user', 1),
    email: 'you@frames.local',
    name: ctx.displayName || 'You',
    avatarColor: 'primary',
    clusterGroupId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    isAdmin: true,
    license: { activatedAt: now, activationKey: 'frames', licenseKey: 'frames' },
    oauthId: '',
    profileChangedAt: now,
    profileImagePath: '',
    quotaSizeInBytes: null,
    quotaUsageInBytes: 0,
    shouldChangePassword: false,
    status: 'active',
    storageLabel: null,
    isOnboarded: true,
  });
  ctx.immichUser = user;

  A.get('/server/config', () => {
    const c = config();
    return {
      availableMemoryTypes: MEMORY_TYPES,
      externalDomain: '',
      isInitialized: true,
      isOnboarded: true,
      loginPageMessage: '',
      maintenanceMode: false,
      mapDarkStyleUrl: c.map.darkStyle,
      mapLightStyleUrl: c.map.lightStyle,
      minFaces: c.machineLearning.facialRecognition.minFaces,
      oauthButtonText: '',
      publicUsers: false,
      trashDays: c.trash.days,
      userDeleteDelay: c.user.deleteDelay,
    };
  });
  A.get('/server/features', () => ({
    backups: false,
    configFile: false,
    dataSaverVideo: false,
    duplicateDetection: ai(),
    email: false,
    facialRecognition: ai(),
    importFaces: false,
    localTakenRange: true,
    map: true,
    oauth: false,
    oauthAutoLaunch: false,
    ocr: false,
    passwordLogin: false,
    peopleStatistics: true,
    realtimeTranscoding: false,
    reverseGeocoding: places(),
    s3Storage: false,
    search: true,
    searchOptions: true,
    sidecar: false,
    smartSearch: ai(),
    smartSearchHasCutoff: false,
    spatialScene: false,
    trash: true,
  }));
  /** MapLibre style over Frames' local raster tiles; dark inverts them. */
  A.get('/frames/map-style/:theme', (req, { theme }) => ({
    version: 8,
    sources: {
      frames: {
        type: 'raster',
        tiles: [`http://${req.headers.host}/apps/memories/api/map/tiles/{z}/{x}/{y}.png`],
        tileSize: 256,
        maxzoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      },
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': theme.startsWith('dark') ? '#151515' : '#f2efe9' },
      },
      {
        id: 'frames',
        type: 'raster',
        source: 'frames',
        paint: theme.startsWith('dark')
          ? { 'raster-brightness-min': 1, 'raster-brightness-max': 0.15, 'raster-saturation': -0.6 }
          : {},
      },
    ],
  }));
  A.get('/server/version', () => ({ major, minor, patch, prerelease: 0, featureLevel: 0 }));
  A.get('/server/version-history', () => []);
  A.get('/server/about', () => ({ version: `v${version}`, versionUrl: '', licensed: true, nodejs: process.version }));
  A.get('/server/ping', () => ({ res: 'pong' }));
  A.get('/server/storage', async () => {
    const s = await fs.promises.statfs(ctx.root);
    const size = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return {
      diskAvailable: human(free),
      diskAvailableRaw: free,
      diskSize: human(size),
      diskSizeRaw: size,
      diskUse: human(size - free),
      diskUseRaw: size - free,
      diskUsagePercentage: Math.round(((size - free) / size) * 10000) / 100,
    };
  });
  A.get('/server/media-types', () => ({
    image: [
      '.jpg',
      '.jpeg',
      '.png',
      '.heic',
      '.heif',
      '.webp',
      '.gif',
      '.tif',
      '.tiff',
      '.dng',
      '.cr2',
      '.nef',
      '.arw',
    ],
    video: ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.3gp', '.mts', '.m2ts'],
    sidecar: ['.xmp'],
  }));
  A.get('/server/license', () => user().license);
  A.get('/config', () => project(config(), VIEWS.user));
  A.get('/public/config', () => project(config(), VIEWS.public));
  A.get('/admin/config', () => config());
  A.get('/admin/config/defaults', () => DEFAULTS);
  A.put('/admin/config', async (req) => {
    db.setKv('immich.config', JSON.stringify(await readJson(req)));
    return config();
  });

  A.get('/users/me', user);
  A.put('/users/me', async (req) => {
    const { name } = await readJson(req);
    if (name) ctx.displayName = name;
    return user();
  });
  A.get('/users/me/preferences', prefs);
  A.put('/users/me/preferences', async (req) => {
    db.setKv(
      'immich.prefs',
      JSON.stringify(deepMerge(JSON.parse(db.getKv('immich.prefs', '{}')), await readJson(req))),
    );
    return prefs();
  });
  A.get('/users/me/license', () => user().license);
  A.put('/users/me/onboarding', () => ({ isOnboarded: true }));
  A.get('/users/:id', user);
  A.get('/users', () => [user()]);

  const login = () => ({
    accessToken: 'frames',
    isAdmin: true,
    isOnboarded: true,
    name: user().name,
    profileImagePath: '',
    shouldChangePassword: false,
    userEmail: user().email,
    userId: user().id,
  });
  A.post('/auth/login', login);
  A.post('/auth/validateToken', () => ({ authStatus: true }));
  A.post('/auth/logout', () => ({ redirectUri: '/photos', successful: true }));
  A.get('/auth/status', () => ({ isElevated: true, password: false, pinCode: false }));

  // Multi-user, sharing and account features Frames does not have
  for (const p of [
    '/notifications',
    '/shared-spaces',
    '/api-keys',
    '/sessions',
    '/passkeys',
    '/partners',
    '/shared-links',
  ])
    A.get(p, () => []);
}

const pathToUrl = (p) => new URL(`file:///${p.replace(/\\/g, '/')}`);

/** Small helper so area modules return data instead of writing responses. */
export function apiRouter(router) {
  const add = (method) => (p, fn) =>
    router.add(method, `/api${p}`, async (req, res, params, url) => {
      const out = await fn(req, params, url.searchParams, res);
      if (out !== undefined && !res.headersSent) json(res, out);
    });
  return { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), del: add('DELETE') };
}

export function registerImmich(router, ctx) {
  const A = apiRouter(router);
  registerServer(router, ctx, A);
  registerTimeline(router, ctx, A);
  registerAssets(router, ctx, A);
  registerPeople(router, ctx, A);
  registerBrowse(router, ctx, A);
  registerMemories(router, ctx, A);
  registerAdmin(router, ctx, A);
  registerAlbums(router, ctx, A);
  registerUtilities(router, ctx, A);
  registerSearch(router, ctx, A);
  return A;
}
