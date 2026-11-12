import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { APP_ROOT, TOOLS } from './tools.mjs';

export const LENS_DIR = path.join(APP_ROOT, 'lens');
export const PYTHON_DIR = path.join(TOOLS, 'python');
export const PYTHON = path.join(PYTHON_DIR, process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python3'));
export const MODELS_DIR = path.join(TOOLS, 'models');
/** Written by setup-ai.mjs once Python, packages and models are all in place. */
export const READY_MARKER = path.join(PYTHON_DIR, '.frames-ai-ready');

/** Pinned checkpoints (see lens/README.md); shared by setup and runtime. */
export const PINS = {
  EMBEDDING_MODEL_ID: 'google/siglip2-base-patch16-256',
  EMBEDDING_MODEL_REVISION: '3f9f96cb90da5dbc758b01813f2f6f1aee24c1ab',
  SENTENCE_MODEL_ID: 'intfloat/multilingual-e5-small',
  SENTENCE_MODEL_REVISION: '614241f622f53c4eeff9890bdc4f31cfecc418b3',
  SCHEMA_MODEL_ID: 'fastino/gliner2.5-multi-v1',
  SCHEMA_MODEL_REVISION: 'a221b77a8baf4a613b8f8652661d41fa10a5641e',
  FACE_DET_URL:
    'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2026may.onnx',
  FACE_DET_SHA: 'ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0',
  FACE_REC_URL: 'https://huggingface.co/opencv/face_recognition_sface/resolve/main/face_recognition_sface_2021dec.onnx',
  FACE_REC_SHA: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
};

/** Environment for the lens daemon (and for the model fetch during setup). */
export function lensEnv({ url, token, qdrantPath, offline = true }) {
  return {
    ...process.env,
    ...PINS,
    LENS_LOCAL: '1',
    NEXTCLOUD_URL: url,
    NC_USER: 'frames',
    NC_TOKEN: token,
    QDRANT_PATH: qdrantPath,
    MODEL_CACHE_DIR: MODELS_DIR,
    SCAN_INTERVAL: '600',
    PYTHONNOUSERSITE: '1',
    PYTHONUTF8: '1',
    ...(offline && { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }),
  };
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

/** The lens daemon as a child process; it exits on its own when our stdin pipe closes. */
export class LensDaemon {
  state = 'stopped';
  error = '';

  constructor({ appUrl, token, dataDir, log = console.log }) {
    Object.assign(this, { appUrl, token, dataDir, log });
  }

  static available() {
    return fs.existsSync(READY_MARKER) && fs.existsSync(PYTHON);
  }

  async start() {
    this.port = await freePort();
    this.base = `http://127.0.0.1:${this.port}`;
    const qdrantPath = path.join(this.dataDir, 'lens', 'qdrant');
    fs.mkdirSync(qdrantPath, { recursive: true });
    const logFile = fs.openSync(path.join(this.dataDir, 'lens', 'lens.log'), 'a');
    this.state = 'starting';
    this.proc = spawn(
      PYTHON,
      [
        '-m',
        'uvicorn',
        'app:app',
        '--app-dir',
        LENS_DIR,
        '--host',
        '127.0.0.1',
        '--port',
        String(this.port),
        '--log-level',
        'warning',
      ],
      {
        cwd: LENS_DIR,
        env: lensEnv({ url: this.appUrl, token: this.token, qdrantPath }),
        stdio: ['pipe', logFile, logFile],
        windowsHide: true,
      },
    );
    this.proc.on('exit', (code) => {
      if (this.state !== 'stopped') {
        this.state = 'error';
        this.error = `AI engine exited (code ${code}); see ${path.join(this.dataDir, 'lens', 'lens.log')}`;
        this.log(this.error);
      }
    });
    process.once('exit', () => this.stop());
    for (let i = 0; i < 600 && this.state === 'starting'; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const h = await this.get('/v1/health').catch(() => null);
      if (h?.status === 'ok') this.state = 'ready';
    }
    if (this.state === 'starting') ((this.state = 'error'), (this.error = 'AI engine did not start'));
    return this.state === 'ready';
  }

  stop() {
    this.state = 'stopped';
    this.proc?.kill();
  }

  async req(method, p, body) {
    const res = await fetch(this.base + p, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`lens ${method} ${p}: ${res.status} ${await res.text()}`);
    return res.json();
  }
  get = (p) => this.req('GET', p);
  post = (p, body) => this.req('POST', p, body);
}
