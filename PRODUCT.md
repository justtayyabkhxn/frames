# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One person browsing and organizing their own photo library on their own Windows PC, with mouse and keyboard on a desktop monitor or laptop. Libraries are typically 10,000–100,000 photos and videos built up over years from phones and cameras.

## Product Purpose

Frames turns a folder of photos on the user's disk into a private, Google Photos–style library: on first run it indexes metadata for every file (taking as long as it needs), then lets the user browse by date, folder, place, person and album, search by description, and view, edit and organize photos. Success is the user finding and enjoying their photos without any cloud account, server or internet.

## Positioning

Fully offline and local. Everything (index, thumbnails, place names, face grouping, natural-language search, video transcoding) runs on the user's own machine from a self-contained folder; photos never leave the disk. It is a fork of Nextcloud Memories (https://github.com/pulsejet/memories.git, AGPL-3.0) re-hosted on a local Node backend instead of Nextcloud.

## Operating Context

- Started by double-clicking `frames.cmd`; opens in the user's browser at `http://localhost:7310`, single user, no login.
- First run asks for the photo folder, then indexes in the background with progress in the top bar; the user browses while it works.
- Distributed as a portable folder (`dist/Frames`) copied to the user's personal PC; no installs, no internet after packaging (map tiles from OpenStreetMap only when online).

## Capabilities and Constraints

- Views: Timeline, Explore, Folders, Favorites, Albums, People, Archive, On this day, Places, Map, Tags, Trash, Videos, search.
- Actions: view (photos, videos, live/motion photos, panoramas), edit (photo editor, dates, location, tags), favorite, archive, delete/restore, move, upload, download/zip, albums, people naming/merging.
- Not available: share links and multi-user features (no public server).
- Frontend is the Memories Vue 3 app (`src/`) using `@nextcloud/vue` components; the page shell and theme tokens are served by `standalone/lib/shell.mjs`. Product name is "Frames"; internal ids remain `memories`.
- Translations exist for many languages (`l10n/`); UI strings go through `t('memories', …)`.

## Brand Commitments

- Name: Frames. Must credit the fork of Memories (README).
- The user asked for a look in the spirit of Google Photos: the photos are the content, the chrome stays out of the way.

## Evidence on Hand

No real user photos, testimonials or metrics are in the repo; test libraries are generated or public-domain samples. Do not fabricate content or claims.

## Product Principles

1. Photos first: the interface frames the library and never competes with it.
2. Private by construction: nothing implies accounts, cloud, sync or sharing that does not exist.
3. Fast at scale: tens of thousands of items must stay smooth to scroll, jump and search.
4. Calm and familiar: patterns people already know from mainstream photo apps over novelty.
5. Honest progress: long first-run work is visible and never blocks browsing.

## Accessibility & Inclusion

Desktop mouse-and-keyboard use; keep keyboard navigation and visible focus working, and readable contrast in both light and dark themes.
