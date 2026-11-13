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

/**
 * Run a command with its output shown as one live line (and kept in `log`).
 * Resolves when it exits 0; otherwise prints the last lines of output and rejects.
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
          live.text(l);
          tail.push(l);
          if (tail.length > 25) tail.shift();
          if (!tty && !l.startsWith('Progress ')) console.log(`   ${l}`);
        }
      });
    }
    p.on('error', (e) => (live.stop(), out?.end(), reject(e)));
    p.on('close', (code) => {
      live.stop();
      out?.end();
      if (code === 0) return resolve();
      console.log(c.dim(tail.map((l) => `     ${l}`).join('\n')));
      reject(new Error(`${path.basename(cmd)} exited with code ${code}${log ? ` (full log: ${log})` : ''}`));
    });
  });
}

/** Download into memory, reporting "Progress a of b" lines (drawn as a bar on a terminal, parsed by runLive otherwise). */
export async function download(url, label = path.basename(new URL(url).pathname)) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const live = tty ? new Live() : null;
  const report = (done) => (live ? live.progress(done, total) : console.log(`Progress ${done} of ${total}`));
  if (live) live.label = `Downloading ${label}`;
  else console.log(`Downloading ${label}`);
  const chunks = [];
  let done = 0;
  let last = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    done += chunk.length;
    if (total && Date.now() - last > 150) (report(done), (last = Date.now()));
  }
  if (total) report(total);
  live?.stop();
  return Buffer.concat(chunks);
}
