// Terminal look of Frames' launcher and installer: gradient banner, step headers, live progress.
// Child processes report downloads as "Progress <done> of <total>" lines (pip's --progress-bar raw format);
// runLive() turns those into bars, so every download looks the same whoever does it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const tty = process.stdout.isTTY;
const esc = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = {
  dim: esc('2'),
  bold: esc('1'),
  green: esc('38;2;80;250;123'),
  cyan: esc('38;2;0;229;255'),
  pink: esc('38;2;255;92;205'),
  yellow: esc('38;2;255;214;102'),
  red: esc('38;2;255;85;85'),
};
const rgb = ([r, g, b], s) => (tty ? `\x1b[38;2;${r};${g};${b}m${s}` : s);
const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
const GRADIENT = [
  [0, 229, 255],
  [124, 92, 255],
  [255, 92, 205],
];
const shade = (t) => (t < 0.5 ? mix(GRADIENT[0], GRADIENT[1], t * 2) : mix(GRADIENT[1], GRADIENT[2], t * 2 - 1));
const gradient = (line, width) =>
  [...line].map((ch, i) => (ch === ' ' ? ch : rgb(shade(i / width), ch))).join('') + (tty ? '\x1b[0m' : '');

export const BANNER = fs.readFileSync(path.join(import.meta.dirname, '..', 'banner.txt'), 'utf8').replace(/\s+$/, '');

export function banner() {
  if (process.env.FRAMES_BANNER_SHOWN) return;
  const lines = BANNER.split(/\r?\n/);
  const width = Math.max(...lines.map((l) => l.length));
  console.log(`\n${lines.map((l) => `  ${gradient(l, width)}`).join('\n')}\n`);
  console.log(`  ${c.green(c.bold('Photos  -  People  -  Places'))}`);
  console.log(`  ${c.dim('your whole library, offline on this PC')}\n`);
}

export const step = (n, total, title) =>
  console.log(
    `\n ${c.pink('━━')} ${c.cyan(`[${n}/${total}]`)} ${c.bold(title)} ${c.pink('━'.repeat(Math.max(4, 46 - title.length)))}`,
  );
export const ok = (msg) => console.log(`   ${c.green('√')} ${msg}`);
export const info = (msg) => console.log(`   ${c.dim('·')} ${c.dim(msg)}`);
export const warn = (msg) => console.log(`   ${c.yellow('!')} ${msg}`);

const MB = 1024 * 1024;
export const size = (n) => (n >= 1024 * MB ? `${(n / 1024 / MB).toFixed(2)} GB` : `${(n / MB).toFixed(1)} MB`);
export const elapsed = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};
// Only glyphs that both Cascadia (Windows Terminal) and Consolas (classic console) have
const SPIN = ['●··', '·●·', '··●', '·●·'];
const fit = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);

export function bar(pct, width = 26) {
  const full = Math.round(pct * width);
  return (
    [...Array(width)]
      .map((_, i) => (i < full ? rgb(shade(i / width), '█') : tty ? '\x1b[38;2;70;70;90m░' : '░'))
      .join('') + (tty ? '\x1b[0m' : '')
  );
}

/** One live status line: spinner + label, or a progress bar while a download reports "Progress a of b". */
export class Live {
  constructor() {
    this.label = '';
    this.prog = null;
    this.t0 = Date.now();
    this.frame = 0;
    if (tty) this.timer = setInterval(() => this.draw(), 100);
  }
  text(line) {
    const m = /^Progress (\d+) of (\d+)/.exec(line);
    if (m) return this.progress(+m[1], +m[2]);
    const pct = /(\d{1,3})%\|/.exec(line); // tqdm (Hugging Face model downloads)
    if (pct) {
      this.prog = { pct: +pct[1] / 100, info: line.split('|').at(-1).trim() };
      return;
    }
    this.label = line.trim();
    this.prog = null;
  }
  progress(done, total) {
    const now = Date.now();
    const p = this.prog?.total === total ? this.prog : { total, start: now, startDone: done };
    const rate = (done - p.startDone) / Math.max(0.001, (now - p.start) / 1000);
    const eta = rate > 0 ? elapsed(((total - done) / rate) * 1000) : '…';
    this.prog = {
      ...p,
      pct: total ? done / total : 0,
      info: `${size(done)} / ${size(total)}  ${size(rate)}/s  ETA ${eta}`,
    };
    if (done >= total && total) {
      this.clear();
      ok(`${fit(this.label.replace(/^\s*Downloading\s+/, ''), 60)} ${c.dim(size(total))}`);
      this.prog = null;
    }
  }
  draw() {
    if (!tty) return;
    const cols = process.stdout.columns || 100;
    const spin = c.cyan(SPIN[this.frame++ % SPIN.length]);
    const time = c.dim(elapsed(Date.now() - this.t0));
    const name = fit(this.label.replace(/^\s*Downloading\s+/, '').replace(/\s+\(.*\)$/, ''), 18).padEnd(18);
    const line = this.prog
      ? `   ${spin} ${name} ${bar(this.prog.pct, 20)} ${c.bold(`${String(Math.round(this.prog.pct * 100)).padStart(3)}%`)} ${c.dim(fit(this.prog.info ?? '', cols - 56))}`
      : `   ${spin} ${time} ${c.dim(fit(this.label, cols - 16))}`;
    process.stdout.write(`\r\x1b[2K${line}`);
  }
  clear() {
    if (tty) process.stdout.write('\r\x1b[2K');
  }
  stop() {
    clearInterval(this.timer);
    this.clear();
  }
}

/** For setup scripts: a failure ends in one "Error: ..." line (which runLive reports), not a stack trace. */
export function cli() {
  process.on('uncaughtException', (e) => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
}

/**
 * Run a command with its output shown as one live line (and kept in `log`).
 * Resolves when it exits 0; otherwise rejects with its "Error: ..." line, or prints its last lines.
 */
export function runLive(cmd, args, { env, cwd, log, shell } = {}) {
  return new Promise((resolve, reject) => {
    const live = new Live();
    const out = log ? fs.createWriteStream(log, { flags: 'a' }) : null;
    const tail = [];
    const p = spawn(cmd, args, { env, cwd, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const s of [p.stdout, p.stderr]) {
      let rest = '';
      s.on('data', (d) => {
        out?.write(d);
        const parts = (rest + d).split(/[\r\n]+/);
        rest = parts.pop();
        // eslint-disable-next-line no-control-regex
        for (const l of parts.map((x) => x.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).filter((x) => x.trim())) {
          if (l.trim().startsWith('√')) {
            // A finished item of the step stays on screen
            live.clear();
            console.log(`   ${c.green('√')}${l.trim().slice(1)}`);
            continue;
          }
          live.text(l);
          if (l.startsWith('Progress ')) continue;
          tail.push(l);
          if (tail.length > 8) tail.shift();
          if (!tty) console.log(`   ${l}`);
        }
      });
    }
    p.on('error', (e) => (live.stop(), out?.end(), reject(e)));
    p.on('close', (code) => {
      live.stop();
      out?.end();
      if (code === 0) return resolve();
      let error = tail.findLast((l) => l.startsWith('Error: '))?.slice(7);
      // A tool (pip, pnpm) failed: its own last lines say why
      if (!error || error.startsWith('Command failed')) {
        console.log(
          c.dim(
            tail
              .filter((l) => !l.startsWith('Error: '))
              .map((l) => `     ${l}`)
              .join('\n'),
          ),
        );
        error = 'a setup command failed (see above)';
      }
      reject(new Error(`${error}${log ? `\n  Full log: ${log}` : ''}`));
    });
  });
}

const why = (e) =>
  ({
    UND_ERR_CONNECT_TIMEOUT: 'the server did not answer',
    ENOTFOUND: 'no internet connection?',
    ECONNRESET: 'the connection dropped',
    ECONNREFUSED: 'the server refused the connection',
    UND_ERR_SOCKET: 'the connection dropped',
  })[e.cause?.code] ?? e.message;

const PARTS = 8;
const PARALLEL_FROM = 16 * MB;

/** One byte range of a parallel download, retried on its own; `add` gets the byte count (negative to undo). */
async function fetchPart(url, start, end, add) {
  for (let attempt = 1; ; attempt++) {
    let got = 0;
    try {
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: AbortSignal.timeout(30 * 60_000),
      });
      if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
      const chunks = [];
      for await (const chunk of res.body) (chunks.push(chunk), (got += chunk.length), add(chunk.length));
      if (got !== end - start + 1) throw new Error('the connection dropped');
      return Buffer.concat(chunks);
    } catch (e) {
      add(-got);
      if (attempt === 4) throw e;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

/**
 * Download into memory with retries (flaky mirrors and dropped connections are common), reporting
 * "Progress a of b" lines: drawn as a bar on a terminal, parsed by runLive otherwise. `quiet` skips the progress.
 */
export async function download(url, label = path.basename(new URL(url).pathname), { quiet = false } = {}) {
  const TRIES = 4;
  for (let attempt = 1; ; attempt++) {
    const live = tty && !quiet ? new Live() : null;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      const report = (done) => (live ? live.progress(done, total) : console.log(`Progress ${done} of ${total}`));
      if (live) live.label = `Downloading ${label}`;
      else if (!quiet) console.log(`Downloading ${label}`);
      let done = 0;
      let last = 0;
      const add = (n) => {
        done += n;
        if (!quiet && total && Date.now() - last > 150) (report(done), (last = Date.now()));
      };
      let buf;
      if (res.headers.get('accept-ranges') === 'bytes' && total > PARALLEL_FROM) {
        // CDNs (GitHub's included) cap each connection: fetch the parts side by side from the final (redirected) URL
        void res.body.cancel();
        const size = Math.ceil(total / PARTS);
        const ranges = [...Array(PARTS)].map((_, i) => [i * size, Math.min(total, (i + 1) * size) - 1]);
        buf = Buffer.concat(await Promise.all(ranges.map(([s, e]) => fetchPart(res.url, s, e, add))));
      } else {
        const chunks = [];
        for await (const chunk of res.body) (chunks.push(chunk), add(chunk.length));
        buf = Buffer.concat(chunks);
      }
      if (total && buf.length !== total) throw new Error('the connection dropped');
      if (!quiet && total) report(total);
      return buf;
    } catch (e) {
      if (attempt === TRIES) throw new Error(`Could not download ${label}: ${why(e)}`);
      const wait = 5 * attempt;
      console.log(`${label}: ${why(e)}; retrying in ${wait}s (try ${attempt + 1} of ${TRIES})`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    } finally {
      live?.stop();
    }
  }
}
