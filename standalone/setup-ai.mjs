/**
 * One-time setup for People, Explore and smart search (idempotent, needs internet once):
 * portable Python 3.12 in tools/python, lens packages (CPU torch), pinned models in tools/models.
 * Afterwards everything runs offline.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LENS_DIR, lensEnv, MODELS_DIR, PYTHON, PYTHON_DIR, READY_MARKER } from './lib/ai-lens.mjs';
import { cacheEnv, TOOLS } from './lib/tools.mjs';
import { cli, download, ok } from './lib/ui.mjs';

cli();

// python-build-standalone (astral-sh), relocatable CPython
const PY_REL = '20261026';
const PY_FILE = 'cpython-3.12.16+20261026-x86_64-pc-windows-msvc-install_only.tar.gz';
const PY_SHA256 = '590dfcbe3a34c07301e6332e13e2188b98655cd072b08afa45a7998dc4c22bc5';
const TORCH_INDEX = 'https://download.pytorch.org/whl/cpu';

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('setup-ai currently supports Windows x64 only.');
  process.exit(1);
}

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', windowsHide: true, ...opts });
const py = (args, opts = {}) =>
  sh(PYTHON, args, { env: { ...process.env, ...cacheEnv(), PYTHONNOUSERSITE: '1' }, ...opts });

/** Download any pinned model not yet on disk (all SHA-checked; complete ones are skipped). */
function fetchModels() {
  console.log('Downloading AI models (pinned revisions)');
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  py(
    [
      '-c',
      'from routes.context import embedding_model as e, sentence_model as s, schema_model as c, face_model as f\n' +
        'for m in (e, s, c, f): m.ensure_snapshot()',
    ],
    {
      cwd: LENS_DIR,
      env: lensEnv({ url: 'http://127.0.0.1', token: 'setup', qdrantPath: 'unused', offline: false }),
    },
  );
}

// Already set up: only fetch models whose pins changed since (e.g. a new face model)
if (fs.existsSync(READY_MARKER)) {
  fetchModels();
  console.log('AI features are set up. Restart Frames if models were updated.');
  process.exit(0);
}

if (!fs.existsSync(PYTHON)) {
  const buf = await download(
    `https://github.com/astral-sh/python-build-standalone/releases/download/${PY_REL}/${encodeURIComponent(PY_FILE)}`,
    'Python 3.12',
  );
  if (createHash('sha256').update(buf).digest('hex') !== PY_SHA256)
    throw new Error('Python download failed (checksum mismatch)');
  // The archive's root folder is "python/", so it unpacks straight into tools/python
  const tgz = path.join(TOOLS, 'python.tar.gz');
  fs.rmSync(PYTHON_DIR, { recursive: true, force: true });
  fs.writeFileSync(tgz, buf);
  sh(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xzf', tgz, '-C', TOOLS]);
  fs.rmSync(tgz, { force: true });
  ok('Python ready');
}

console.log('Installing AI packages (CPU-only PyTorch; this is a large one-time download)');
const pip = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-warn-script-location'];
// Under the installer: "Progress a of b" lines, which it draws as bars
if (!process.stdout.isTTY) pip.push('--progress-bar', 'raw');
py([...pip, '--index-url', TORCH_INDEX, 'torch>=2.14,<3']);
const deps = execFileSync(PYTHON, [
  '-c',
  "import sys, tomllib; print('\\n'.join(tomllib.load(open(sys.argv[1], 'rb'))['project']['dependencies']))",
  path.join(LENS_DIR, 'pyproject.toml'),
])
  .toString()
  .split(/\r?\n/)
  .filter(Boolean);
py([...pip, '--extra-index-url', TORCH_INDEX, ...deps]);
ok('AI packages installed');

fetchModels();
ok('AI models downloaded');

fs.writeFileSync(READY_MARKER, new Date().toISOString());
console.log('AI features are ready. Restart Frames to start indexing People and smart search.');
