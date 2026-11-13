# Frames on Gallery's UI

## Intent
The user wants Frames to look and behave exactly like Gallery (`C:\other-projects\gallery`, an Immich fork): every sidebar page, every settings screen, map, people, utilities. Frames stays what it is underneath: one person, one folder of photos on their own PC, fully offline, portable folder, no uploads.

## Decision
Use Gallery's real web app (SvelteKit, `web/`) as the Frames UI instead of restyling the Vue/Memories UI. Frames' Node backend answers the Immich REST API (`/api/*`) the web app calls, backed by Frames' existing SQLite index, previews, lens (search, faces, duplicates) and library operations. The Vue UI (`src/`, webpack) is removed once Gallery's UI covers its pages.

## Goals
- Pixel- and behaviour-identical UI: Gallery's own components, fonts, i18n, layout, keyboard shortcuts.
- All user-facing pages work against local data: Photos, Explore, Map, People, Places, Tags, Folders, Albums, Favorites, Archive, Locked folder, Trash, Memories, Recently added, Search, Utilities (duplicates, large files, cleanup), filter panel, asset viewer and editor, user settings, admin pages that make sense for one person (system settings, jobs, face cleanup).
- Offline and portable: the built web app ships as static files in the Frames folder; no Postgres, Redis or Docker.

## Non-goals / cut (hidden or stubbed)
- Upload of any kind, mobile backup/sync, external libraries, storage migration.
- Multiple users, partners, sharing, shared links, shared spaces, OAuth, passkeys, API keys, sessions management.
- Backups (S3/pg_dump), workflows/plugins, version announcements, license/buy pages.
- OCR (no OCR model in Frames): feature flag off.

## Anti-goals
- Forking Gallery's UI by hand-editing hundreds of components: changes stay small and isolated (feature flags, hidden nav items) so Gallery updates can be re-synced.
- Settings that silently do nothing: settings without a Frames equivalent are hidden; ones that map (face thresholds, trash days, map style, theme, etc.) are wired.

## Architecture
- `gallery/` in the Frames repo: a vendored copy of Gallery's `web/`, `packages/sdk/` and `i18n/` (synced by `standalone/sync-gallery.mjs` from a Gallery checkout). Build with pnpm via corepack on the portable Node 24; output (`web/build`) is served statically with SPA fallback at `/`.
- `standalone/lib/immich/*.mjs`: Immich API routes on the existing router, one file per area (server/auth, timeline, assets, albums, people, search, map, tags/folders, memories, trash, duplicates/cleanup, admin/jobs). Contract checks in `standalone/immich-test.mjs`.
- IDs: Immich expects UUIDs. Frames ids are encoded reversibly as UUID-shaped strings with a type nibble (asset, person, album, tag, memory, face), e.g. `a0000000-0000-4000-8000-0000000004d2` for file 1234.
- Auth: single built-in admin user, auto-signed-in: the server sets `immich_is_authenticated=true` and accepts every request from localhost (existing host check stays). `isInitialized`/`isOnboarded` true, license set, so no onboarding or buy prompts.
- Media: `/assets/:id/thumbnail?size=thumbnail|preview|fullsize` from Frames' previews, `/assets/:id/original` and `/assets/:id/video/playback` (Range) from the file; realtime HLS off.
- Feature mapping: smart search → lens; facial recognition, face suggestions, face cleanup → Frames faces + lens endpoints built this session; duplicates → lens duplicates; map/places → Frames places data; memories → generated "on this day" from the index (respecting the memories setting); trash/archive/locked → library operations (locked = a PIN-protected visibility kept in the index).
- Settings: user preferences and admin config stored as JSON in `kv`, seeded from the OpenAPI defaults.
- Websocket: socket.io at `/api/socket.io` is optional; phase 1 ships without it (the app polls), added later for live index progress if needed.

## Phases (each committed separately, tests per phase)
1. Vendor + build Gallery web; bootstrap (server config/features, user, prefs, auto-login); timeline buckets; thumbnails/originals/video; asset info; favorite/archive/delete. Serve at `/`.
2. Trash, archive, albums, search (metadata, smart, suggestions, filters), explore, places, map.
3. People and faces (thumbnails, rename, merge, reassign, hide, suggestions), tags, folders, memories, recently added, locked folder.
4. Utilities: duplicates, large files, cleanup queues; face cleanup admin.
5. User settings and admin system settings/jobs; remove the Vue UI, webpack config and dead backend routes; update SETUP.md, AGENTS.md, PRODUCT.md, package.mjs.

## Builder's calls (not decided by the user)
- Vendoring into the repo (portable, reproducible) rather than building from an external path.
- UUID encoding scheme and single auto-signed-in admin user.
- pnpm through corepack (ships with Node), no new global installs.
