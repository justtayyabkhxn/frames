// Self-check for the installer's live output and downloads: node standalone/ui-test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { download, runLive } from './lib/ui.mjs';

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

  // A failing step rejects with its one-line error; no raw progress lines or stack traces are shown
  lines.length = 0;
  await assert.rejects(
    child(
      1,
      `console.log('Progress 1 of 9'); console.error('Error: Could not download ffmpeg: the server did not answer')`,
    ),
    /^Error: Could not download ffmpeg: the server did not answer$/,
  );
  assert.ok(!lines.some((l) => l.includes('Progress')), lines.join('\n'));

  // A connection that drops mid-file is retried and the file arrives whole
  let hits = 0;
  const body = Buffer.alloc(100_000, 7);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': body.length });
    if (++hits === 1) return res.write(body.subarray(0, 1000), () => req.socket.destroy());
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const got = await download(`http://127.0.0.1:${server.address().port}/f.zip`, 'f.zip');
  server.close();
  assert.equal(hits, 2);
  assert.ok(got.equals(body));
  assert.ok(
    lines.some((l) => /f\.zip: .*retrying in 5s \(try 2 of 4\)/.test(l)),
    lines.join('\n'),
  );

  // Big files come over parallel byte ranges; a part that drops is fetched again, the file arrives whole
  const big = Buffer.alloc(20 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4) big.writeUInt32LE(i, i);
  const ranges = [];
  let dropped = false;
  const rs = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
    if (!m) return res.writeHead(200, { 'Content-Length': big.length, 'Accept-Ranges': 'bytes' }).end(big);
    const part = big.subarray(+m[1], +m[2] + 1);
    ranges.push(m[1]);
    res.writeHead(206, { 'Content-Length': part.length, 'Accept-Ranges': 'bytes' });
    if (+m[1] > 0 && !dropped) return ((dropped = true), res.write(part.subarray(0, 1000), () => req.socket.destroy()));
    res.end(part);
  });
  await new Promise((r) => rs.listen(0, '127.0.0.1', r));
  const gotBig = await download(`http://127.0.0.1:${rs.address().port}/big.zip`, 'big.zip');
  rs.close();
  assert.equal(new Set(ranges).size, 8);
  assert.equal(ranges.length, 9);
  assert.ok(gotBig.equals(big));
} finally {
  console.log = log;
}
console.log('ok');
