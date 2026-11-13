# Frames

**A private, offline photo library for your PC.**

Point Frames at a folder of photos and videos. It indexes every file once, then lets you browse the whole library in your browser, Google Photos–style: by date, folder, place, person and album, with search by description. Nothing leaves your computer: no account, no cloud, no server to maintain.

> Frames is a fork of [Memories](https://github.com/pulsejet/memories) by Varun Patil and contributors (AGPL-3.0). It keeps the Memories web interface and replaces the Nextcloud/PHP backend with a small local Node.js server.

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Using Frames](#using-frames)
- [Privacy and data](#privacy-and-data)
- [How it works](#how-it-works)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [License and credits](#license-and-credits)

## Features

**Browse**

- Timeline sorted by date taken, with a date scrubber and "On this day"
- Folders, Favorites, Videos, Albums and Tags
- Map and Places, with offline reverse geocoding from OpenStreetMap boundaries
- Light and dark themes that follow Windows

**Find** (AI runs locally on your CPU)

- People: faces grouped automatically; name and merge them
- Explore and smart search: describe what you want, like "dog on the beach"

**View**

- Photos, panoramas, live and motion photos
- Video with direct playback, and on-the-fly HLS transcoding for formats the browser cannot play

**Organize and edit**

- Photo editor: adjustments, filters, crop, rotate
- Edit dates, locations, tags and other metadata
- Move, archive, delete and restore from Trash
- Rescan for new, changed or deleted files; download a selection as ZIP

Sharing links and multi-user features are not included: Frames is single-user and local by design.

## Quick start

Requirements: Windows 10 or 11 (x64) and an internet connection during the first run only. Plan for about 1 GB of disk for tools and dependencies, plus about 4.5 GB for the AI features. Nothing else needs to be installed first, not even Node.js.

1. Get Frames: `git clone https://github.com/justtayyabkhxn/frames.git`, or download the ZIP from GitHub and unpack it.
2. Double-click `frames.cmd` (or run `.\frames.cmd` in a terminal).

That is all. On the first run `frames.cmd` sets up everything by itself, with live progress for each download:

1. **Node.js runtime:** a portable, checksum-verified Node 24.
2. **Portable tools:** exiftool, ffmpeg and offline place names.
3. **Web interface:** installs the UI libraries and builds the app.
4. **AI engine and models:** Python, CPU-only PyTorch, and the face and search models.
5. **Your photo folder:** it asks which folder to use; you can drag the folder into the window.

Then Frames opens in your browser. Later starts skip all of this and open straight away.

- Everything is kept inside the Frames folder (`tools\`, `data\`); nothing is installed system-wide.
- Finished steps are not repeated: if setup stops, for example because the internet dropped, run `frames.cmd` again to continue.
- If only the AI step fails, Frames starts anyway and retries it on the next start.
- The full setup log is in `tools\install.log`.

Want to run the steps by hand, or on Linux/macOS? See **[SETUP.md](SETUP.md)**.

## Using Frames

Start Frames with `frames.cmd` every time. To use a different photo folder:

```powershell
.\frames.cmd --dir "D:\Photos"
```

Frames opens at `http://localhost:7310`. The first run indexes your library in the background; the status pill at the top shows progress, and you can browse while it works. Press Ctrl+C in the terminal to stop.

| Option | Effect |
|---|---|
| `--dir <folder>` | Photo folder to use, remembered for next time. Switching folders starts a fresh index. |
| `--no-open` | Do not open the browser. |
| `PORT` | Environment variable: use a port other than 7310. |
| `FRAMES_DATA` | Environment variable: keep the data folder somewhere other than `data\`. |

To run Frames on another PC without installing anything there, build a portable copy:

```powershell
node standalone\package.mjs --zip              # -> dist\Frames and dist\Frames.zip
```

## Privacy and data

- The server listens on `127.0.0.1` only and accepts requests from its own page.
- Everything Frames creates (index, thumbnails, AI index, settings) lives in the `data\` folder. Delete it to start over; your photos are not affected.
- Your photos change only when you edit, move, archive or delete them in Frames.
  - Archived files go to `<photo folder>\.archive`.
  - Deleted files go to `<photo folder>\.frames-trash` until you empty the trash.
- Internet is used only during setup (tools, models, place data) and, when available, for OpenStreetMap map tiles. A built-in offline basemap is used otherwise.

## How it works

```
Browser (Memories Vue 3 UI)
        │  HTTP on 127.0.0.1:7310
Node.js server (standalone/)
        ├─ SQLite index (node:sqlite)      data\frames.db
        ├─ exiftool                        metadata read/write
        ├─ ffmpeg                          thumbnails, HLS video, editor
        ├─ OpenStreetMap boundaries        offline place names
        └─ lens/ (Python, optional)        faces and image search on CPU
```

| Path | What |
|---|---|
| `standalone/` | Local backend: HTTP server, indexer, Memories API, WebDAV subset, previews, map and places, video, AI bridge |
| `src/`, `l10n/`, `img/` | Memories web interface (Vue 3) and translations, built into `js/` |
| `lens/` | Python AI service (faces, image search), run locally by Frames |
| `frames.cmd` | Windows launcher |
| `tools/`, `data/`, `js/` | Created by setup and first run; not in git |

## Development

Use the portable Node in `tools\node` (Node 24).

```powershell
npm run build                                  # rebuild the UI -> js\
npx vue-tsc --noEmit                           # typecheck
npx prettier --write src standalone            # format

node standalone\test.mjs                       # self-checks; each prints ok
node standalone\map-test.mjs
node standalone\media-test.mjs
node standalone\ai-test.mjs
```

The server loads its code at start, so restart it after backend or theme changes. See [AGENTS.md](AGENTS.md) for architecture notes and conventions, and [PRODUCT.md](PRODUCT.md) for product context.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Setup stopped or a download failed | Check your internet connection and run `frames.cmd` again; it continues where it stopped. Details are in `tools\install.log`. |
| `Port 7310 is busy` | Frames is already running: open http://localhost:7310, or set a different `PORT`. |
| No thumbnails, or videos don't play | `tools\ffmpeg` is missing: run `frames.cmd` again while online to fetch it. |
| People and search missing from the menu | The AI setup did not finish: restart `frames.cmd` while online and it retries. |
| Places stay empty | The place data is missing: run `frames.cmd` again while online to fetch it. |

More in [SETUP.md](SETUP.md#troubleshooting).

## License and credits

Frames is licensed under AGPL-3.0; see [COPYING](COPYING).

- Based on [Memories](https://github.com/pulsejet/memories) by Varun Patil and contributors.
- `lens/` is derived from Memories Lens (Apache-2.0; see [lens/LICENSE](lens/LICENSE)).
- Uses [exiftool](https://exiftool.org), [ffmpeg](https://ffmpeg.org) and place data from [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
