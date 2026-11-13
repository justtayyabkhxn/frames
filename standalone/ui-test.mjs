// Self-check for the installer's live output: node standalone/ui-test.mjs
import assert from 'node:assert/strict';
import { runLive } from './lib/ui.mjs';

const lines = [];
const log = console.log;
console.log = (s = '') => lines.push(String(s));
const child = (code, body) => runLive(process.execPath, ['-e', `${body}; process.exit(${code})`]);
try {
  // pip-style download progress ends in a "done" line naming the file and its size
  await child(
    0,
    `console.log('Downloading torch-2.9.whl (2.0 MB)'); for (const n of [0, 1048576, 2097152]) console.log('Progress ' + n + ' of 2097152')`,
  );
  assert.ok(
    lines.some((l) => l.includes('√') && l.includes('torch-2.9.whl') && l.includes('2.0 MB')),
    lines.join('\n'),
  );
  // A failing step rejects and shows its last output
  lines.length = 0;
  await assert.rejects(child(3, `console.error('boom: no network')`), /exited with code 3/);
  assert.ok(lines.some((l) => l.includes('boom: no network')));
} finally {
  console.log = log;
}
console.log('ok');
