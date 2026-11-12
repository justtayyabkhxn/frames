# Frames setup

Step-by-step instructions to get Frames running from a fresh clone. They are written for a coding agent working in a terminal, but a person can follow them too. Run every command from the repository root unless a step says otherwise.

## What you end up with

- `tools\` holds downloaded, portable tools: Node.js 24, exiftool, ffmpeg, place data, and optionally Python with the AI models.
- `js\` holds the built web interface.
- `data\` is created on the first run. It holds the index, thumbnails, AI index and settings.
- Frames is served at `http://localhost:7310` and opens in the browser.

None of these folders are in git, so a fresh clone only contains source code.

## Requirements

- **System:** Windows 10 or 11, x64. These steps use PowerShell. For other systems, see "Linux / macOS" at the end.
- **Git**, to clone the repository.
- **Internet, during setup only.** Frames runs offline afterwards; when online it also shows OpenStreetMap map tiles.
- **Disk space:**

  | Part | Size |
  |---|---|
  | Tools and place data | about 400 MB |
  | `node_modules` | about 600 MB |
  | AI models and Python (optional) | about 4.5 GB |

  `data\` then grows with the library, roughly 100–200 KB per photo for thumbnails, plus the place index.

## 1. Clone

```powershell
git clone <repository-url> frames
cd frames
```

## 2. Get a Node.js to run the setup script

The setup script needs Node.js 22 or newer to run. Check what is installed:

```powershell
node -v
```

If this prints `v22.x` or higher, go to step 3.

Otherwise, download a portable Node 24 into `tools\node` and verify it against the official checksum:

```powershell
$v = (Invoke-RestMethod https://nodejs.org/dist/index.json | Where-Object { $_.version -like 'v24.*' -and $_.lts } | Select-Object -First 1).version
$zip = "node-$v-win-x64.zip"
New-Item -ItemType Directory -Force tools | Out-Null
Invoke-WebRequest "https://nodejs.org/dist/$v/$zip" -OutFile "tools\$zip"
$expected = ((Invoke-WebRequest "https://nodejs.org/dist/$v/SHASUMS256.txt").Content -split "`n" | Where-Object { $_ -like "*$zip" }).Split(' ')[0]
if ((Get-FileHash "tools\$zip" -Algorithm SHA256).Hash -ne $expected.ToUpper()) { throw 'Node checksum mismatch' }
Expand-Archive "tools\$zip" tools; Rename-Item "tools\node-$v-win-x64" node; Remove-Item "tools\$zip"
$env:PATH = "$PWD\tools\node;$env:PATH"
node -v
```

## 3. Download the portable tools

```powershell
node standalone\setup.mjs
```

This downloads the following into `tools\`. It verifies each download against its publisher's checksum and skips anything already present:

- `tools\node`: portable Node.js 24 LTS. Frames and the build use this one.
- `tools\exiftool`: exiftool 13.63, which reads and writes photo metadata.
- `tools\ffmpeg`: the gyan.dev "essentials" build, used for thumbnails, video and the photo editor.
- `tools\places\planet_postgres.zip`: OpenStreetMap place boundaries, about 108 MB, used for place names.

The last line printed should be `Tools ready in ...\tools`.

From now on, use the portable Node for everything. Put it first on `PATH` in this terminal:

```powershell
$env:PATH = "$PWD\tools\node;$env:PATH"
node -v   # must print v24.x
```

## 4. Build the web interface

```powershell
npm ci
npm run build
```

- `npm ci` installs the exact dependency versions from `package-lock.json`. Expect warnings, but there should be no errors.
- `npm run build` writes the interface to `js\`. It takes about 1–2 minutes and must end with `webpack ... compiled successfully`.

Check the result:

```powershell
Test-Path js\memories-main.js   # True
```

## 5. Optional: people, explore and smart search

```powershell
node standalone\setup-ai.mjs
```

This step is safe to re-run; it skips what is already installed. It sets up three things:

- **Python:** a portable Python 3.12 in `tools\python`.
- **AI packages:** CPU-only PyTorch and the packages listed in `lens\pyproject.toml`.
- **Models:** the pinned models in `tools\models`.

It downloads several GB and can take 10–30 minutes. When it finishes, it writes `tools\python\.frames-ai-ready` and prints `AI features are ready`.

Without this step, Frames works normally, but People, Explore and description search are unavailable.

## 6. Verify

Run the self-checks. Each must print `ok`:

```powershell
node standalone\test.mjs
node standalone\map-test.mjs
node standalone\media-test.mjs
node standalone\ai-test.mjs
```

## 7. Run Frames

```powershell
.\frames.cmd --dir "D:\Photos"
```

- **`--dir`:** the photo folder. Frames remembers it in `data\config.json`. If you leave it out on the first run, Frames asks for it.
- **First start:** Frames prints `Photo folder: ...` and `Open http://localhost:7310/apps/memories/`, then opens the browser.
- **Indexing:** it runs in the background, and the status pill at the top of the page shows its progress. You can browse while it runs.
- **Stopping:** press Ctrl+C in the terminal.

For an agent or a headless check, start without opening a browser, then poll the status endpoint until `phase` is `idle`:

```powershell
Start-Process -NoNewWindow tools\node\node.exe -ArgumentList 'standalone\server.mjs','--no-open','--dir','D:\Photos'
Invoke-RestMethod http://localhost:7310/apps/memories/api/frames/status
```

The status response has these fields:

- `phase`: `scanning`, `indexing` or `idle`
- `found`, `done`, `total`: progress counts
- `count`: number of indexed items
- `ai`: AI progress (`state`, `queued`, `people`, …)

### Options

| Option | Effect |
|---|---|
| `--dir <folder>` | Photo folder to use, saved for next time. Switching folders starts a fresh index. |
| `--no-open` | Do not open the browser. |
| `PORT` environment variable | Use a port other than 7310. |
| `FRAMES_DATA` environment variable | Keep the data folder somewhere other than `data\`. |

## Where things are stored

| Location | Contents |
|---|---|
| `data\frames.db` | SQLite index: files, metadata, albums, tags, favorites, places, people, settings |
| `data\previews\` | Thumbnails and previews |
| `data\lens\` | AI search and face index |
| `data\vod\`, `data\live\` | Video transcoding and live-photo cache (temporary) |
| `data\config.json` | The chosen photo folder |
| `<photo folder>\.archive\` | Archived photos (moved there by Archive) |
| `<photo folder>\.frames-trash\` | Deleted photos until the trash is emptied (kept on the same drive as the photos) |

To start over, stop Frames and delete `data\`. Your photos are not affected.

## Package for another PC (optional)

After steps 3–5:

```powershell
node standalone\package.mjs --zip
```

This writes a self-contained `dist\Frames` folder and `dist\Frames.zip`. Copy it to the other PC and double-click `frames.cmd`; nothing needs to be installed there.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `The web interface is not built yet` | Run step 4. |
| `Port 7310 is busy` | Frames is already running: open http://localhost:7310. To run a second copy, set a different `PORT`. |
| No thumbnails, or videos don't play | `tools\ffmpeg` is missing. Re-run step 3. |
| People and search missing from the menu | The AI setup is incomplete. Re-run step 5, then restart Frames. |
| Places stay empty | The place data could not be downloaded. Re-run step 3 while online. |
| The page looks outdated after an update | Restart Frames: the server loads code when it starts. |

## Linux / macOS (not packaged)

1. Install Node.js 24, exiftool and ffmpeg with your package manager.
2. Run steps 4 and 6.
3. Start Frames with `node standalone/server.mjs --dir ~/Pictures`.

`setup.mjs` and `setup-ai.mjs` only handle Windows.
