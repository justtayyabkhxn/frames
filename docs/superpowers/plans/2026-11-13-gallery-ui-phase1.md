# Gallery UI, Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve Gallery's real web app at `/` on Frames' backend with auto-login, a working timeline, thumbnails/originals/video, asset info and favorite/archive/delete.

**Architecture:** Gallery's `web/`, `packages/sdk/`, `i18n/` are vendored under `gallery/` and built with pnpm (corepack, portable Node 24) to `gallery/web/build`. `standalone/lib/immich/*.mjs` register Immich `/api/*` routes on the existing `Router`, reading Frames' SQLite index and reusing `previewFile`, `lib.trash`, archive and favorite logic.

**Tech Stack:** Node 24 (`node:sqlite`), SvelteKit static build, pnpm via corepack.

**Spec:** `docs/superpowers/specs/2026-11-13-gallery-ui-design.md`

## Global Constraints
- Offline and portable: no Postgres/Redis/Docker; built UI ships as static files.
- No uploads, no multi-user/sharing; single auto-signed-in admin.
- Never install new npm deps into Frames' own `package.json`; Gallery's lockfile governs `gallery/`.
- Existing host check and same-origin check in `server.mjs` stay.
- Vue UI stays reachable at `/apps/memories/` until phase 5.

## Review Focus
- Photos without EXIF date / with only mtime: must still land in a bucket (use `media.datetaken`).
- RAW/HEIC originals: `/original` must fall back to the JPEG preview when the browser cannot decode the file.
- Video Range requests (seek): `sendFile` already handles Range; test a `Range: bytes=0-1` request returns 206.
- Archived files must not appear in the main timeline (`visibility=timeline`), only with `visibility=archive`.
- Unknown/garbage asset ids: `/api/assets/not-a-uuid` returns 400, not a 500.

---

### Task 1: Vendor and build Gallery web

**Files:**
- Create: `standalone/sync-gallery.mjs`, `gallery/` (vendored copy), `.gitignore` entries `gallery/**/node_modules/`, `gallery/web/build/`, `gallery/packages/sdk/build/`, `gallery/i18n/gallery/merged/`
- Modify: `standalone/setup.mjs` (append a "build Gallery UI" step), `SETUP.md` step 4

**Interfaces:**
- Produces: `GALLERY_BUILD = path.join(APP_ROOT, 'gallery', 'web', 'build')` exported from `standalone/lib/tools.mjs`.

- [ ] **Step 1:** `sync-gallery.mjs <galleryRepo>` copies `web/` (minus `node_modules`, `build`, `.svelte-kit`), `packages/sdk/`, `i18n/`, `pnpm-workspace.yaml` (rewritten to list only `web` and `packages/sdk`), `pnpm-lock.yaml`, root `package.json` (keep `packageManager`), `.npmrc` into `gallery/`.
- [ ] **Step 2:** Run `node standalone/sync-gallery.mjs C:\other-projects\gallery`; expect `gallery/web/src` present.
- [ ] **Step 3:** Build: `cd gallery; corepack pnpm --filter @immich/sdk install --frozen-lockfile; corepack pnpm --filter @immich/sdk build; corepack pnpm install --filter immich-web --frozen-lockfile; corepack pnpm --filter immich-web build`. Expected: `gallery/web/build/index.html` exists. If the lockfile rejects the trimmed workspace, drop `--frozen-lockfile` and note it.
- [ ] **Step 4:** Commit vendored sources (not build output): `chore(gallery): vendor Gallery web app`.

### Task 2: Static serving and auto-login bootstrap

**Files:**
- Create: `standalone/lib/immich/ids.mjs`, `standalone/lib/immich/server.mjs`, `standalone/immich-test.mjs`
- Modify: `standalone/server.mjs` (register immich routes; serve `GALLERY_BUILD` with SPA fallback for `GET` paths outside `/api` and `/apps/memories`; set cookie `immich_is_authenticated=true; Path=/; SameSite=Lax` on `index.html`)

**Interfaces:**
- Produces (`ids.mjs`): `toUuid(kind: 'asset'|'person'|'album'|'tag'|'memory'|'face'|'user', id: number): string`, `fromUuid(uuid: string, kind): number` (throws `badRequest` on mismatch). Format: `${kindHex}0000000-0000-4000-8000-${id.toString(16).padStart(12,'0')}` with kindHex a/b/c/d/e/f/1 respectively; ids above 2^48 use the third group too.
- Produces (`server.mjs`): `registerImmich(router, ctx)` that calls each area's `register*(router, ctx, helpers)`; `ctx.immich = { user, toUuid, fromUuid, assetDto(row), bucketKey(datetaken) }`.

- [ ] **Step 1: Failing test** in `immich-test.mjs` (same harness style as `ai-test.mjs`: `openDb(':memory:')`, `Router`, fake `res`):
```js
assert.equal(fromUuid(toUuid('asset', 1234), 'asset'), 1234);
assert.throws(() => fromUuid('not-a-uuid', 'asset'));
const cfg = await api('GET', '/api/server/config');
assert.equal(cfg.isInitialized, true); assert.equal(cfg.isOnboarded, true);
const me = await api('GET', '/api/users/me');
assert.equal(me.isAdmin, true); assert.ok(me.license);
assert.equal((await api('GET', '/api/server/features')).ocr, false);
```
- [ ] **Step 2:** Run `node standalone/immich-test.mjs` → FAIL (module missing).
- [ ] **Step 3:** Implement: `/server/config`, `/server/features` (map/trash/search/smartSearch/facialRecognition/duplicateDetection = AI available, ocr/oauth/passwordLogin/email/importFaces=false), `/server/about`, `/server/version`, `/server/storage` (disk stats of library drive), `/public/config` (ffmpeg.realtime.enabled=false), `/config` and `/admin/config` (JSON from kv `immich.adminConfig`, defaulting to the spec's `SystemConfigDto` defaults copied from `gallery/open-api` — keep a trimmed `defaults.json` next to `server.mjs`), `/users/me`, `/users/me/preferences` (kv `immich.prefs`, GET/PUT), `/auth/login`, `/auth/logout`, `/auth/status`, stubs `[]` for `/notifications`, `/shared-spaces`, `/api-keys`, `/sessions`, `/passkeys`, `/albums` (until phase 2).
- [ ] **Step 4:** Test passes; start server with a sample folder and open `/` → Gallery shell renders, lands on `/photos`, no login screen (check console for 404s; stub any extra bootstrap call found).
- [ ] **Step 5:** Commit `feat(immich): serve Gallery UI with auto sign-in`.

### Task 3: Timeline buckets

**Files:**
- Create: `standalone/lib/immich/timeline.mjs`
- Test: `standalone/immich-test.mjs`

**Interfaces:**
- Consumes: `ctx.filter(params)` from `api.mjs` (reuse the WHERE builder; map `visibility=archive` → `archive`, `isFavorite=true` → `fav`, `isTrashed` → empty for now).
- Produces: `GET /api/timeline/buckets` → `[{timeBucket:'YYYY-MM-01', count}]` desc; `GET /api/timeline/bucket?timeBucket=` → columnar `TimeBucketAssetResponseDto`.

- [ ] **Step 1: Failing test:** two media rows in 2024-03 and one archived in 2024-01 →
```js
assert.deepEqual(await api('GET','/api/timeline/buckets?visibility=timeline'), [{ timeBucket:'2024-03-01', count:2 }]);
const b = await api('GET','/api/timeline/bucket?timeBucket=2024-03-01&visibility=timeline');
assert.equal(b.id.length, 2); assert.equal(b.ratio[0], 4/3); assert.equal(b.isImage[0], true);
assert.deepEqual(Object.keys(b).sort(), [...COLUMNS].sort());
```
- [ ] **Step 2:** FAIL. **Step 3:** Implement; `fileCreatedAt`/`localOffsetHours` from `datetaken`/`epoch`, `thumbhash: null`, `duration` as `HH:MM:SS.mmm` or null, `livePhotoVideoId` via `liveid` companion, `stack: null`, `visibility`, order by datetaken desc. **Step 4:** PASS. **Step 5:** Commit `feat(immich): timeline buckets`.

### Task 4: Media endpoints

**Files:**
- Create: `standalone/lib/immich/assets.mjs`
- Modify: `standalone/lib/api.mjs` (export `previewFile` via `ctx.previewFile`)

**Interfaces:**
- Produces: `GET /api/assets/:id/thumbnail?size=thumbnail|preview|fullsize` (thumbnail → `previewFile(id, 250, 250, false)`, preview → 1440, fullsize → 4096), `GET /api/assets/:id/original` (file bytes for `DIRECT_MIMES`, otherwise the 4096 preview), `GET /api/assets/:id/video/playback` (file with Range).

- [ ] **Step 1: Failing test:** thumbnail returns `image/jpeg`; `/original` with header `Range: bytes=0-1` returns 206; bad id returns 400.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5:** Commit `feat(immich): thumbnails, originals and video`.

### Task 5: Asset info and actions

**Files:**
- Modify: `standalone/lib/immich/assets.mjs`

**Interfaces:**
- Produces: `GET /api/assets/:id` → `AssetResponseDto` with `exifInfo` mapped from `media.exif` (Make, Model, LensModel, FNumber, ISO, ExposureTime, FocalLength, GPS, Description, Rating, FileSize, dims) and places (city/state/country from Frames places); `PUT /api/assets` `{ids, isFavorite?, visibility?, rating?, description?}`; `PUT /api/assets/:id` same for one; `DELETE /api/assets` `{ids, force}` → `lib.trash`; stubs `GET /api/faces?id=` `[]`, `GET /api/assets/:id/ocr` `[]`, `POST /api/assets/spaces` `[]`, `GET /api/timeline/bucket-covers` `[]`.

- [ ] **Step 1: Failing test:** favorite toggles `nodes.favorite`; `visibility:'archive'` moves into archive (assert file now under `.archive` via `ctx.lib`), `DELETE` puts the node in `trash` table; `GET /api/assets/:id` has `exifInfo.make`.
- [ ] **Step 2–4:** FAIL, implement (reuse the archive route logic from `api.mjs` by extracting it into `ctx.archive(id, on)`), PASS.
- [ ] **Step 5:** Manual check in the browser: scroll timeline, open viewer, info panel, favorite, archive, delete, play a video.
- [ ] **Step 6:** Commit `feat(immich): asset info, favorite, archive and delete`.
