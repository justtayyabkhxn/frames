import fs from 'node:fs';

const THEME = fs.readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

/** HTML page standing in for Nextcloud's page template: globals, theme variables, user and translations. */

const LIGHT = `
  --color-main-background: #ffffff; --color-main-background-rgb: 255, 255, 255;
  --color-main-background-translucent: rgba(255, 255, 255, .97); --color-main-background-blur: rgba(255, 255, 255, .86);
  --color-background-hover: #f1f3f4; --color-background-dark: #eceef0; --color-background-darker: #dfe2e5;
  --color-placeholder-light: #e9ebee; --color-placeholder-dark: #d5d8dc;
  --color-main-text: #1c1d1f; --color-text-maxcontrast: #5d6167; --color-text-maxcontrast-default: #5d6167;
  --color-text-maxcontrast-background-blur: #54585e; --color-text-light: #1c1d1f; --color-text-lighter: #5d6167;
  --color-error: #c5221f; --color-error-rgb: 197, 34, 31; --color-error-hover: #d33b38; --color-error-text: #b31d1a;
  --color-warning: #8a5a00; --color-warning-rgb: 138, 90, 0; --color-warning-hover: #774e00; --color-warning-text: #7a5000;
  --color-success: #1e7e3e; --color-success-rgb: 30, 126, 62; --color-success-hover: #2b8a4a; --color-success-text: #1b7038;
  --color-info: #2f5bd3; --color-info-rgb: 47, 91, 211; --color-info-hover: #2a51bd; --color-info-text: #2449b0;
  --color-favorite: #c98a00; --color-loading-light: #d5d8dc; --color-loading-dark: #5d6167;
  --color-box-shadow-rgb: 30, 33, 38; --color-border: #e7e9ec; --color-border-dark: #d5d8dc; --color-border-maxcontrast: #80858c;
  --color-primary: #2f5bd3; --color-primary-text: #ffffff; --color-primary-hover: #2a51bd;
  --color-primary-light: #e8eefc; --color-primary-light-text: #183a91; --color-primary-light-hover: #dce5fa;
  --color-primary-element: #2f5bd3; --color-primary-element-hover: #2a51bd; --color-primary-element-text: #ffffff;
  --color-primary-element-light: #e8eefc; --color-primary-element-light-text: #183a91; --color-primary-element-light-hover: #dce5fa;
  --color-primary-element-text-dark: #f5f7fd; --color-primary-element-extra-light: #f3f6fe; --color-primary-element-extra-light-hover: #e9effc;
  --background-invert-if-dark: no; --background-invert-if-bright: invert(100%);
  --primary-invert-if-bright: no; --primary-invert-if-dark: invert(100%);
  --color-background-plain: #ffffff; --color-background-plain-text: #1c1d1f;
  --frames-logo-dark: none; --frames-logo-light: inline;
  color-scheme: light;`;

const DARK = `
  --color-main-background: #121314; --color-main-background-rgb: 18, 19, 20;
  --color-main-background-translucent: rgba(18, 19, 20, .97); --color-main-background-blur: rgba(18, 19, 20, .86);
  --color-background-hover: #212225; --color-background-dark: #1b1c1e; --color-background-darker: #2b2d30;
  --color-placeholder-light: #26282b; --color-placeholder-dark: #303236;
  --color-main-text: #e6e7e9; --color-text-maxcontrast: #a2a6ab; --color-text-maxcontrast-default: #a2a6ab;
  --color-text-maxcontrast-background-blur: #aeb2b6; --color-text-light: #e6e7e9; --color-text-lighter: #a2a6ab;
  --color-error: #f28b82; --color-error-rgb: 242, 139, 130; --color-error-hover: #f6a39c; --color-error-text: #f28b82;
  --color-warning: #fdd663; --color-warning-rgb: 253, 214, 99; --color-warning-hover: #fee28a; --color-warning-text: #fdd663;
  --color-success: #81c995; --color-success-rgb: 129, 201, 149; --color-success-hover: #9ad5aa; --color-success-text: #81c995;
  --color-info: #a8c1ff; --color-info-rgb: 168, 193, 255; --color-info-hover: #bccffd; --color-info-text: #a8c1ff;
  --color-favorite: #fdd663; --color-loading-light: #5f6368; --color-loading-dark: #c4c7cb;
  --color-box-shadow-rgb: 0, 0, 0; --color-border: #2b2d30; --color-border-dark: #3a3c40; --color-border-maxcontrast: #7d8187;
  --color-primary: #a8c1ff; --color-primary-text: #0a1a3d; --color-primary-hover: #bccffd;
  --color-primary-light: #1f2c48; --color-primary-light-text: #d5e1ff; --color-primary-light-hover: #283858;
  --color-primary-element: #a8c1ff; --color-primary-element-hover: #bccffd; --color-primary-element-text: #0a1a3d;
  --color-primary-element-light: #1f2c48; --color-primary-element-light-text: #d5e1ff; --color-primary-element-light-hover: #283858;
  --color-primary-element-text-dark: #0a1a3d; --color-primary-element-extra-light: #182238; --color-primary-element-extra-light-hover: #1d2943;
  --background-invert-if-dark: invert(100%); --background-invert-if-bright: no;
  --primary-invert-if-bright: invert(100%); --primary-invert-if-dark: no;
  --color-background-plain: #121314; --color-background-plain-text: #e6e7e9;
  --frames-logo-dark: inline; --frames-logo-light: none;
  color-scheme: dark;`;

const COMMON = `
  --font-face: "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji";
  --default-font-size: 15px; --font-size-small: 13px; --default-line-height: 1.5;
  --font-weight-default: 400; --font-weight-element: 600; --font-weight-heading: 700;
  --animation-quick: 100ms; --animation-slow: 300ms;
  --border-width-input: 1px; --border-width-input-focused: 2px;
  --border-radius: 3px; --border-radius-small: 4px; --border-radius-element: 8px; --border-radius-large: 10px;
  --border-radius-rounded: 28px; --border-radius-container: 12px; --border-radius-container-large: 16px; --border-radius-pill: 100px;
  --default-clickable-area: 34px; --clickable-area-large: 48px; --clickable-area-small: 24px; --default-grid-baseline: 4px;
  --header-height: 64px; --frames-nav-w: 250px; --header-menu-item-height: 44px; --navigation-width: 300px;
  --sidebar-min-width: 300px; --sidebar-max-width: 500px;
  --body-container-radius: 0px; --body-container-margin: 0px;
  --body-height: calc(100% - env(safe-area-inset-bottom));
  --breakpoint-mobile: 1024px;
  --color-box-shadow: rgba(var(--color-box-shadow-rgb), .5);
  --color-scrollbar: var(--color-border-maxcontrast) transparent;
  --gradient-primary-background: linear-gradient(40deg, var(--color-primary) 0%, var(--color-primary-hover) 100%);
  --filter-background-blur: blur(25px);`;

const BASE_CSS = `
  :root { ${COMMON} ${DARK} }
  @media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { ${LIGHT} } }
  :root[data-theme="light"] { ${LIGHT} }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--color-main-background); color: var(--color-main-text);
    font-family: var(--font-face); font-size: var(--default-font-size); line-height: var(--default-line-height);
    overflow: hidden; -webkit-font-smoothing: antialiased;
  }
  *, *::before, *::after { box-sizing: border-box; }
  button, input, select, textarea { font: inherit; color: inherit; }
  a { color: inherit; text-decoration: none; }
  #content, #content-vue { display: flex; position: fixed; inset: var(--header-height) 0 0 0; height: auto; width: 100%; overflow: hidden; }
  .hidden-visually { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64');

export function renderShell(ctx) {
  const lang = ctx.language;
  const capabilities = { core: { 'webdav-root': 'remote.php/webdav' }, theming: { name: 'Frames' }, files: {} };
  return `<!doctype html>
<html lang="${esc(lang.replace('_', '-'))}" data-locale="${esc(ctx.locale)}">
<head data-user="${esc(ctx.uid)}" data-user-displayname="${esc(ctx.displayName)}" data-requesttoken="${esc(ctx.token)}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, minimum-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#121314" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<title>Frames</title>
<link rel="icon" href="/apps/memories/img/app.svg">
<style>${BASE_CSS}
${THEME}</style>
<script>
  window._oc_webroot = '';
  window._oc_appswebroots = { memories: '/apps/memories' };
  window._oc_isadmin = true;
  window._oc_capabilities = ${JSON.stringify(capabilities)};
  window.OC = {
    webroot: '', appswebroots: window._oc_appswebroots, coreApps: ['core'],
    config: { modRewriteWorking: true, version: '34.0.0.0', versionstring: '34.0.0', session_lifetime: 31536000, session_keepalive: false },
    isUserAdmin: () => true, getCurrentUser: () => ({ uid: ${JSON.stringify(ctx.uid)}, displayName: ${JSON.stringify(ctx.displayName)} }),
    theme: { name: 'Frames', productName: 'Frames' }, MimeType: { getIconUrl: () => '' }, dialogs: {}, Util: {},
    getLocale: () => ${JSON.stringify(ctx.locale)}, getLanguage: () => ${JSON.stringify(lang)},
  };
  window.OCA = {}; window.OCP = {};
</script>
<input type="hidden" id="initial-state-core-capabilities" value="${b64(capabilities)}">
<script src="/apps/memories/js/memories-l10n.js"></script>
<script>
  (function () {
    var all = globalThis.__packed_l10n || {};
    var b = all[${JSON.stringify(lang)}] || all[${JSON.stringify(lang.split('_')[0])}];
    window._oc_l10n_registry_translations = { memories: (b && (b.translations || b)) || {} };
    window._oc_l10n_registry_plural_functions = { memories: function (n) { return n === 1 ? 0 : 1; } };
    if (b && b.pluralForm) try {
      var m = /plural=(.*?);?$/.exec(b.pluralForm);
      if (m) window._oc_l10n_registry_plural_functions.memories = new Function('n', 'var r = (' + m[1] + '); return r === true ? 1 : r ? r : 0;');
    } catch (e) {}
  })();
</script>
<script defer src="/apps/memories/js/memories-main.js?v=${esc(ctx.buildId)}"></script>
</head>
<body id="body-user" class="theme--default">
<div id="skip-actions"></div>
<header id="header">
  <div class="header-start">
    <a class="frames-logo" href="/apps/memories/" aria-label="Frames home">
      <img src="/apps/memories/img/app.svg" alt="" style="display: var(--frames-logo-dark)">
      <img src="/apps/memories/img/app-dark.svg" alt="" style="display: var(--frames-logo-light)">
      <span>Frames</span>
    </a>
  </div>
  <div class="header-end">
    <div id="frames-status" role="status" aria-live="polite" hidden><span class="bar"></span><span class="dot"></span><span class="label"></span></div>
    <button id="frames-rescan" class="frames-icon-btn" type="button" title="Rescan photo folder" aria-label="Rescan photo folder">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
    </button>
  </div>
</header>
<main id="content" class="app-memories"></main>
<script>
  // Header: scan/index/AI progress chip, rescan button, timeline refresh as photos become ready
  (function () {
    var box = document.getElementById('frames-status');
    var label = box.querySelector('.label');
    var bar = box.querySelector('.bar');
    var rescan = document.getElementById('frames-rescan');
    var token = document.head.dataset.requesttoken;
    var wasBusy = false;
    var lastRefresh = 0;
    var timer = 0;
    var n = function (v) { return Number(v || 0).toLocaleString(); };
    var refresh = function () {
      lastRefresh = Date.now();
      try { window._nc_event_bus && window._nc_event_bus.emit('memories:timeline:soft-refresh', null); } catch (e) {}
    };
    function render(s) {
      var ai = s.ai || {};
      var aiBusy = s.phase === 'idle' && ai.queued > 0;
      var busy = s.phase !== 'idle';
      var text = '';
      var frac = 0;
      if (s.phase === 'scanning') text = 'Looking for photos \u00b7 ' + n(s.found) + ' found';
      else if (s.phase === 'indexing') {
        frac = s.total ? s.done / s.total : 0;
        text = 'Preparing photos \u00b7 ' + n(s.done) + ' of ' + n(s.total);
      } else if (aiBusy) text = 'Finding people and things \u00b7 ' + n(ai.queued) + ' left';
      else if (s.error) text = 'Indexing stopped: ' + s.error;
      box.hidden = !text;
      label.textContent = text;
      box.title = text;
      bar.style.transform = 'scaleX(' + frac + ')';
      rescan.disabled = busy;
      rescan.classList.toggle('busy', busy);
      rescan.title = busy ? 'Scanning\u2026' : 'Rescan photo folder' + (s.dir ? ' (' + s.dir + ')' : '');
      if (s.phase === 'indexing' && Date.now() - lastRefresh > 20000) refresh();
      if (wasBusy && !busy) refresh();
      wasBusy = busy;
      return busy || aiBusy;
    }
    function poll() {
      clearTimeout(timer);
      fetch('/apps/memories/api/frames/status').then(function (r) { return r.json(); }).then(function (s) {
        timer = setTimeout(poll, render(s) ? 1500 : 10000);
      }).catch(function () { timer = setTimeout(poll, 10000); });
    }
    rescan.addEventListener('click', function () {
      rescan.disabled = true;
      rescan.classList.add('busy');
      fetch('/apps/memories/api/frames/rescan', { method: 'POST', headers: { requesttoken: token } })
        .then(function () { setTimeout(poll, 300); }, function () { rescan.disabled = false; rescan.classList.remove('busy'); });
    });
    poll();
  })();
</script>
</body>
</html>`;
}
