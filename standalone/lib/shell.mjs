/** HTML page standing in for Nextcloud's page template: globals, theme variables, user and translations. */

const LIGHT = `
  --color-main-background: #ffffff; --color-main-background-rgb: 255, 255, 255;
  --color-main-background-translucent: rgba(255, 255, 255, .97); --color-main-background-blur: rgba(255, 255, 255, .8);
  --color-background-hover: #f3f3f3; --color-background-dark: #ededed; --color-background-darker: #dbdbdb;
  --color-placeholder-light: #e6e6e6; --color-placeholder-dark: #cccccc;
  --color-main-text: #222222; --color-text-maxcontrast: #6b6b6b; --color-text-maxcontrast-default: #6b6b6b;
  --color-text-maxcontrast-background-blur: #595959; --color-text-light: #222222; --color-text-lighter: #6b6b6b;
  --color-error: #db0606; --color-error-rgb: 219, 6, 6; --color-error-hover: #df2525; --color-error-text: #c20505;
  --color-warning: #a37200; --color-warning-rgb: 163, 114, 0; --color-warning-hover: #8a6000; --color-warning-text: #7f5900;
  --color-success: #2d7b41; --color-success-rgb: 45, 123, 65; --color-success-hover: #428854; --color-success-text: #286c39;
  --color-info: #0071ad; --color-info-rgb: 0, 113, 173; --color-info-hover: #197fb5; --color-info-text: #0066a0;
  --color-favorite: #a37200; --color-loading-light: #cccccc; --color-loading-dark: #444444;
  --color-box-shadow-rgb: 77, 77, 77; --color-border: #ededed; --color-border-dark: #dbdbdb; --color-border-maxcontrast: #7d7d7d;
  --color-primary: #00679e; --color-primary-text: #ffffff; --color-primary-hover: #3285b1;
  --color-primary-light: #e5eff5; --color-primary-light-text: #00293f; --color-primary-light-hover: #dbe4e9;
  --color-primary-element: #00679e; --color-primary-element-hover: #1a76a7; --color-primary-element-text: #ffffff;
  --color-primary-element-light: #e5eff5; --color-primary-element-light-text: #00293f; --color-primary-element-light-hover: #dbe4e9;
  --color-primary-element-text-dark: #f0f0f0; --color-primary-element-extra-light: #f2f7fa; --color-primary-element-extra-light-hover: #e8f0f5;
  --background-invert-if-dark: no; --background-invert-if-bright: invert(100%);
  --primary-invert-if-bright: no; --primary-invert-if-dark: invert(100%);
  color-scheme: light;`;

const DARK = `
  --color-main-background: #171717; --color-main-background-rgb: 23, 23, 23;
  --color-main-background-translucent: rgba(23, 23, 23, .97); --color-main-background-blur: rgba(23, 23, 23, .85);
  --color-background-hover: #292929; --color-background-dark: #212121; --color-background-darker: #333333;
  --color-placeholder-light: #393939; --color-placeholder-dark: #424242;
  --color-main-text: #ebebeb; --color-text-maxcontrast: #999999; --color-text-maxcontrast-default: #999999;
  --color-text-maxcontrast-background-blur: #a3a3a3; --color-text-light: #ebebeb; --color-text-lighter: #999999;
  --color-error: #ff5252; --color-error-rgb: 255, 82, 82; --color-error-hover: #ff7070; --color-error-text: #ff5252;
  --color-warning: #ffcc00; --color-warning-rgb: 255, 204, 0; --color-warning-hover: #ffde5c; --color-warning-text: #ffcc00;
  --color-success: #50bb50; --color-success-rgb: 80, 187, 80; --color-success-hover: #6fc96f; --color-success-text: #50bb50;
  --color-info: #00aeff; --color-info-rgb: 0, 174, 255; --color-info-hover: #33beff; --color-info-text: #00aeff;
  --color-favorite: #ffcc00; --color-loading-light: #777777; --color-loading-dark: #cccccc;
  --color-box-shadow-rgb: 0, 0, 0; --color-border: #333333; --color-border-dark: #474747; --color-border-maxcontrast: #8c8c8c;
  --color-primary: #1f7fc4; --color-primary-text: #ffffff; --color-primary-hover: #3a8fcc;
  --color-primary-light: #12364e; --color-primary-light-text: #d6ecfb; --color-primary-light-hover: #18445f;
  --color-primary-element: #3a9be0; --color-primary-element-hover: #57aae5; --color-primary-element-text: #00141f;
  --color-primary-element-light: #12364e; --color-primary-element-light-text: #d6ecfb; --color-primary-element-light-hover: #18445f;
  --color-primary-element-text-dark: #0a2233; --color-primary-element-extra-light: #0d2536; --color-primary-element-extra-light-hover: #123048;
  --background-invert-if-dark: invert(100%); --background-invert-if-bright: no;
  --primary-invert-if-bright: invert(100%); --primary-invert-if-dark: no;
  color-scheme: dark;`;

const COMMON = `
  --font-face: system-ui, -apple-system, "Segoe UI", Roboto, Oxygen-Sans, Cantarell, Ubuntu, "Helvetica Neue", "Noto Sans", "Liberation Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
  --default-font-size: 15px; --font-size-small: 13px; --default-line-height: 1.5;
  --font-weight-default: 400; --font-weight-element: 600; --font-weight-heading: 700;
  --animation-quick: 100ms; --animation-slow: 300ms;
  --border-width-input: 1px; --border-width-input-focused: 2px;
  --border-radius: 3px; --border-radius-small: 4px; --border-radius-element: 8px; --border-radius-large: 10px;
  --border-radius-rounded: 28px; --border-radius-container: 12px; --border-radius-container-large: 16px; --border-radius-pill: 100px;
  --default-clickable-area: 34px; --clickable-area-large: 48px; --clickable-area-small: 24px; --default-grid-baseline: 4px;
  --header-height: 0px; --header-menu-item-height: 44px; --navigation-width: 300px;
  --sidebar-min-width: 300px; --sidebar-max-width: 500px;
  --body-container-radius: 0px; --body-container-margin: 0px;
  --body-height: calc(100% - env(safe-area-inset-bottom));
  --breakpoint-mobile: 1024px;
  --color-box-shadow: rgba(var(--color-box-shadow-rgb), .5);
  --color-scrollbar: var(--color-border-maxcontrast) transparent;
  --gradient-primary-background: linear-gradient(40deg, var(--color-primary) 0%, var(--color-primary-hover) 100%);
  --color-background-plain: var(--color-main-background); --color-background-plain-text: var(--color-main-text);
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
  #content, #content-vue { display: flex; position: fixed; inset: 0; height: 100%; width: 100%; overflow: hidden; }
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
<meta name="theme-color" content="#171717">
<title>Frames</title>
<link rel="icon" href="/apps/memories/img/app.svg">
<style>${BASE_CSS}</style>
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
<main id="content" class="app-memories"></main>
</body>
</html>`;
}
