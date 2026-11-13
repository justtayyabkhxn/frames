// Copy Gallery's web app (SvelteKit), its SDK and i18n into gallery/ so Frames serves the same UI.
// Usage: node standalone/sync-gallery.mjs <path to Gallery repo>
import fs from 'node:fs';
import path from 'node:path';
import { applyFramesOverlay } from './gallery-overlay.mjs';
import { APP_ROOT } from './lib/tools.mjs';

const src = path.resolve(process.argv[2] ?? '');
if (!fs.existsSync(path.join(src, 'web', 'vite.config.ts'))) {
  console.error('Usage: node standalone/sync-gallery.mjs <path to Gallery repo>');
  process.exit(1);
}
const dest = path.join(APP_ROOT, 'gallery');
const SKIP = new Set([
  'node_modules',
  'build',
  '.svelte-kit',
  'coverage',
  'merged',
  'test-results',
  'playwright-report',
]);

const copy = (rel) =>
  fs.cpSync(path.join(src, rel), path.join(dest, rel), {
    recursive: true,
    filter: (p) => !SKIP.has(path.basename(p)),
  });

// Replace sources but keep installed node_modules and build output, so a re-sync needs no reinstall
for (const rel of ['web', 'packages/sdk', 'i18n', 'patches']) {
  const dir = path.join(dest, rel);
  if (fs.existsSync(dir))
    for (const e of fs.readdirSync(dir))
      if (!SKIP.has(e)) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
  if (fs.existsSync(path.join(src, rel))) copy(rel);
}
for (const rel of ['package.json', 'pnpm-lock.yaml', '.pnpmfile.cjs', '.npmrc', '.nvmrc'])
  if (fs.existsSync(path.join(src, rel))) copy(rel);

// Only the packages the web app needs; the rest of Gallery's settings (overrides, patches, ...) stay as they are
const ws = fs.readFileSync(path.join(src, 'pnpm-workspace.yaml'), 'utf8');
fs.writeFileSync(
  path.join(dest, 'pnpm-workspace.yaml'),
  `packages:\n  - packages/sdk\n  - i18n\n  - web\n${ws.replace(/^packages:\r?\n(?:[ \t]+- .*\r?\n)+/, '')}`,
);
/** Gallery's admin config defaults, evaluated from its TypeScript source (enums inlined). */
function configDefaults(root) {
  const enums = {};
  const src = fs.readFileSync(root + 'enum.ts', 'utf8');
  for (const [, name, body] of src.matchAll(/export enum (\w+) \{([\s\S]*?)\n\}/g))
    for (const [, k, v] of body.matchAll(/(\w+)\s*=\s*('[^']*'|"[^"]*"|-?\d+)/g)) enums[`${name}.${k}`] = v;
  const cron = {
    EVERY_DAY_AT_2AM: "'0 02 * * *'",
    EVERY_DAY_AT_3AM: "'0 03 * * *'",
    EVERY_DAY_AT_MIDNIGHT: "'0 0 * * *'",
  };
  const fix = (s) =>
    s
      .replace(/\b([A-Z]\w+)\.(\w+)\b/g, (m, a, b) => {
        if (a === 'CronExpression') return cron[b];
        if (a === 'Object') return m;
        if (enums[`${a}.${b}`] === undefined) throw new Error('unknown ' + m);
        return enums[`${a}.${b}`];
      })
      .replace(/ as const/g, '')
      .replace(/process\.env\.(\w+)/g, 'undefined');

  let code = '';
  const dir = root + 'gallery/dtos/';
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.spec.'))) {
    const g = fs.readFileSync(dir + f, 'utf8');
    for (const [, name, body] of g.matchAll(/export const (gallery\w+Defaults)(?::\s*\w+)? = (\{[\s\S]*?\n\});/g))
      code += `const ${name} = ${fix(body)};\n`;
  }
  const csrc = fs.readFileSync(root + 'dtos/config.dto.ts', 'utf8');
  const start = csrc.indexOf('export const defaults = Object.freeze<SystemConfig>(');
  const lit = csrc.slice(start).match(/Object\.freeze<SystemConfig>\((\{[\s\S]*?\n\})\);/)[1];
  code += 'return ' + fix(lit) + ';';
  return new Function(code)();
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + '\n');
  console.log(Object.keys(out).join(' '));
}

/** Key trees of the user/public config views, from the OpenAPI schemas. */
function configViews(spec) {
  const S = spec.components.schemas;
  const tree = (name) =>
    Object.fromEntries(
      Object.entries(S[name].properties ?? {}).map(([k, v]) => {
        const ref = (v.$ref ?? v.allOf?.[0]?.$ref)?.split('/').pop();
        return [k, ref && S[ref]?.properties ? tree(ref) : true];
      }),
    );
  return { user: tree('UserConfigDto'), public: tree('PublicConfigDto') };
}

applyFramesOverlay(dest, path.join(APP_ROOT, 'standalone', 'branding'));

const out = path.join(APP_ROOT, 'standalone', 'lib', 'immich');
fs.mkdirSync(out, { recursive: true });
const spec = JSON.parse(fs.readFileSync(path.join(src, 'open-api', 'immich-openapi-specs.json'), 'utf8'));
const writeJson = (name, data) => fs.writeFileSync(path.join(out, name), `${JSON.stringify(data, null, 2)}\n`);
writeJson('config-defaults.json', configDefaults(`${path.join(src, 'server', 'src')}/`));
writeJson('config-views.json', configViews(spec));
console.log(`Gallery web app copied to ${dest}`);
