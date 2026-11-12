# Project Context

This file should be human-readable - less tokens.
Keep it concise, short bullets, no wrapping.

## What this is
- Frames: offline desktop photo library; fork of Nextcloud Memories (AGPL-3.0).
- Memories Vue UI (`src/`) served by a local Node backend (`standalone/`) instead of Nextcloud.
- Setup steps: `SETUP.md`. Product context: `PRODUCT.md`.

## Development
- Use the portable Node: `tools/node/node.exe` (Node 24); tools come from `node standalone/setup.mjs`.
- Build UI: `npm ci`, `npm run build` (writes `js/`); typecheck: `npx vue-tsc --noEmit`.
- Run: `frames.cmd` or `node standalone/server.mjs --dir <photos> [--no-open]`; `PORT`, `FRAMES_DATA`, `FRAMES_JS` env overrides.
- The server loads code at start: restart it after backend or theme changes.
- Checks: `standalone/test.mjs`, `map-test.mjs`, `media-test.mjs`, `ai-test.mjs`.
- Format: `npx prettier --write src standalone` before committing.
- Never install new deps without explicit user consent.
- Never read built JS in `js/`; exclude it from grep etc.

## Architecture (`standalone/lib/`)
- `shell.mjs` + `theme.css`: fake Nextcloud page (globals, theme tokens, header, status chip, rescan).
- `db.mjs`: SQLite (`node:sqlite`); `indexer.mjs`: scan + exiftool metadata; `previews.mjs`: ffmpeg thumbnails.
- `library.mjs`: move/copy/trash/archive keeping disk and index in sync; trash in `<library>/.frames-trash`.
- `api.mjs` (Memories API), `dav.mjs` (WebDAV subset), `clusters.mjs` (albums, tags), `map.mjs` + `places-data.mjs`, `media*.mjs` (HLS, live photos, editor), `ai*.mjs` (spawns `lens/`).
- exiftool calls go through `tools.mjs` `exiftool()` (UTF-8 argfile; Windows-safe).
- Data in `data/` (db, previews, lens index, config); never in git.

## Code Style
Very important.
- Keep code concise and clean.
- Minimal or zero comments when things are obvious.
- Use `git commit -s`.
  - Message looks like: `<type>(<scope>): <imperative description>`.
  - Types like fix, feat, chore, test, etc.
  - Include few lines of description.

## Git
- Work directly on `master`; linear history only (rebase, never merge commits).
- Never force-push `master`.
