# Frames

A private, offline photo library for your PC. Point Frames at a folder of photos and videos; it reads every file's metadata once (taking as long as it needs on the first run), then lets you browse everything Google Photos–style in your browser, with nothing leaving your computer.

> Frames is a fork of [Memories](https://github.com/pulsejet/memories) (https://github.com/pulsejet/memories.git) by Varun Patil, licensed under AGPL-3.0. It keeps the Memories web interface and replaces its Nextcloud/PHP backend with a local Node.js server.

## Features

- **Timeline** sorted by date taken, with "On this day" and a date scrubber
- **Folders, Favorites, Archive, Trash** (with restore)
- **Albums** and **Tags**
- **Map** and **Places**: offline reverse geocoding from OpenStreetMap boundaries
- **People, Explore and smart search** ("dog on the beach"): AI models running on your CPU (optional setup)
- **Video**: direct playback, on-the-fly HLS transcoding for formats the browser cannot play, live and motion photos
- **Editing**: photo editor (adjustments, filters, crop, rotate), dates, locations and other metadata
- **Rescan** button for new, changed or deleted files; download as ZIP
- Light and dark themes following Windows

## Quick start

See **[SETUP.md](SETUP.md)** for the full, step-by-step setup (written so a coding agent can follow it). In short, on Windows:

```powershell
node standalone\setup.mjs                      # portable Node 24, exiftool, ffmpeg, place data -> tools\
$env:PATH = "$PWD\tools\node;$env:PATH"
npm ci; npm run build                          # build the web interface -> js\
node standalone\setup-ai.mjs                   # optional: people + smart search (a few GB)
.\frames.cmd                                   # asks for your photo folder the first time
```

## Privacy and data

- The server listens on `127.0.0.1` only and accepts requests from its own page.
- Everything Frames creates (index, thumbnails, AI index, settings) lives in the `data\` folder of this project. Delete it to start over.
- Your photos are only changed when you edit, move, archive or delete them in Frames. Archived files go to `<photo folder>\.archive`, deleted ones to `<photo folder>\.frames-trash` until you empty the trash.
- Internet is used only during setup (tool, model and place-data downloads) and, when available, for OpenStreetMap map tiles; a built-in offline basemap is used otherwise.

## Project layout

| Path | What |
|---|---|
| `standalone/` | Local backend: HTTP server, indexer, API, WebDAV, previews, map/places, video, AI bridge |
| `src/`, `l10n/`, `img/` | Memories web interface (Vue 3) and translations, built into `js/` |
| `lens/` | Python AI service (faces, image search) run locally by Frames |
| `frames.cmd` | Windows launcher |
| `tools/`, `data/`, `js/` | Created by setup and first run (not in git) |

## License

AGPL-3.0, see [COPYING](COPYING). Based on Memories by Varun Patil and contributors.
