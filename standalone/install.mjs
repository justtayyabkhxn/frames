// First-run installer, run by server.mjs before Frames starts: whatever is missing gets set up, in order,
// with live progress. Each step is a standalone script (also runnable by hand) and is skipped once done.
import fs from 'node:fs';
import path from 'node:path';
import { READY_MARKER } from './lib/ai-lens.mjs';
import { PLANET_ZIP } from './lib/places-data.mjs';
import { GALLERY_BUILD, TOOLS } from './lib/tools.mjs';
import { c, elapsed, info, ok, runLive, step, warn } from './lib/ui.mjs';

const has = (...p) => fs.existsSync(path.join(...p));
const STEPS = [
  {
    title: 'Portable tools',
    note: 'exiftool, ffmpeg and offline place names (about 250 MB)',
    done: () => has(TOOLS, 'exiftool', 'exiftool.exe') && has(TOOLS, 'ffmpeg', 'bin', 'ffmpeg.exe') && has(PLANET_ZIP),
    script: 'setup.mjs',
  },
  {
    title: 'Web interface',
    note: 'installs the UI libraries and builds the app (a few minutes)',
    done: () => has(GALLERY_BUILD, 'index.html'),
    script: 'build-gallery.mjs',
  },
  {
    title: 'AI engine and models',
    note: 'Python, PyTorch (CPU), face and search models (about 4.5 GB)',
    done: () => has(READY_MARKER),
    script: 'setup-ai.mjs',
    optional: 'People and smart search will be set up the next time you start Frames.',
  },
];

/** Run the missing steps; `folderStep` adds the photo-folder question as the last numbered step. */
export async function install({ folderStep = false } = {}) {
  const todo = process.platform === 'win32' ? STEPS.filter((s) => !s.done()) : [];
  const total = todo.length + (folderStep ? 1 : 0);
  if (todo.length) {
    console.log(`  ${c.bold('First-time setup.')} ${c.dim('Everything is kept inside this Frames folder.')}`);
    console.log(`  ${c.dim('Needs internet now; Frames works fully offline afterwards.')}`);
  }
  const log = path.join(TOOLS, 'install.log');
  fs.mkdirSync(TOOLS, { recursive: true });
  const t0 = Date.now();
  for (const [i, s] of todo.entries()) {
    step(i + 1, total, s.title);
    info(s.note);
    const t = Date.now();
    try {
      await runLive(process.execPath, ['--no-warnings', path.join(import.meta.dirname, s.script)], { log });
      ok(`${c.bold(s.title)} ready ${c.dim(`in ${elapsed(Date.now() - t)}`)}`);
    } catch (e) {
      if (!s.optional) throw e;
      warn(`${e.message}\n     ${s.optional}`);
    }
  }
  if (todo.length)
    console.log(`\n  ${c.green('√')} ${c.bold('Setup finished')} ${c.dim(`in ${elapsed(Date.now() - t0)}`)}`);
  if (folderStep) step(total, total, 'Your photo folder');
}
