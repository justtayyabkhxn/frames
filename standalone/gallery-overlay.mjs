// Frames' changes on top of Gallery's web app, applied by sync-gallery.mjs after every copy:
// Frames branding, and no upload / multi-user entry points (Frames is one offline library folder).
// Each edit is an exact find/replace and fails loudly when Gallery's code moved, so nothing is silently skipped.
import fs from 'node:fs';
import path from 'node:path';

const SETTINGS_LIST = 'web/src/routes/(user)/user-settings/UserSettingsList.svelte';
const EDITS = [
  // Upload: header button, drag-and-drop overlay, upload panel, empty-state click, command palette, album action
  [
    'web/src/lib/components/layouts/UserPageLayout.svelte',
    '<NavigationBar onUploadClick={() => openFileUploadDialog()} ',
    '<NavigationBar ',
  ],
  ['web/src/routes/(user)/+layout.svelte', '<UploadCover />', ''],
  ['web/src/routes/+layout.svelte', '<UploadPanel />', ''],
  ['web/src/routes/(user)/photos/[[assetId=id]]/+page.svelte', ` onClick={() => openFileUploadDialog()}`, ''],
  [
    'web/src/routes/(user)/recently-added/[[photos=photos]]/[[assetId=id]]/+page.svelte',
    ` onClick={() => openFileUploadDialog()}`,
    '',
  ],
  [
    'web/src/lib/managers/command-items.ts',
    `  {
    id: 'cmd:upload',
    labelKey: 'upload',
    descriptionKey: 'cmdk_cmd_upload_description',
    icon: mdiCloudUploadOutline,
    handler: () => openFileUploadDialog(),
  },
`,
    '',
  ],
  [
    'web/src/lib/services/album.service.ts',
    `    icon: mdiUpload,\n    onAction:`,
    `    icon: mdiUpload,\n    $if: () => false,\n    onAction:`,
  ],
  // Safety net: no code path can open a file picker or send files
  [
    'web/src/lib/utils/file-uploader.ts',
    'export const openFileUploadDialog = async (options: FileUploadParam = {}) => {\n',
    'export const openFileUploadDialog = async (options: FileUploadParam = {}): Promise<string[]> => {\n  return [];\n',
  ],
  // Single user: no spaces, sharing or import
  ['web/src/lib/components/shared-components/side-bar/UserSidebar.svelte', '  <SpacesNavItem />\n', ''],
  [
    'web/src/lib/components/shared-components/side-bar/UserSidebar.svelte',
    `  <NavbarItem
    title={$t('sharing')}
    href={Route.sharing()}
    icon={mdiAccountMultipleOutline}
    activeIcon={mdiAccountMultiple}
  />
`,
    '',
  ],
  [
    'web/src/lib/components/shared-components/side-bar/UserSidebar.svelte',
    `  <NavbarItem title={$t('import')} href={Route.import()} icon={mdiDatabaseImportOutline} />\n`,
    '',
  ],
  // Single local app: no server status, purchase box or realtime socket; no workflows
  ['web/src/lib/components/shared-components/side-bar/BottomInfo.svelte', '<PurchaseInfo />\n', ''],
  [
    'web/src/lib/components/shared-components/side-bar/BottomInfo.svelte',
    '<div class="mt-2 mb-6">\n  <ServerStatus />\n</div>',
    '<div class="mb-6"></div>',
  ],
  [
    'web/src/lib/stores/websocket.ts',
    'export const openWebsocketConnection = () => {\n',
    'export const openWebsocketConnection = () => {\n  return;\n',
  ],
  [
    'web/src/routes/(user)/utilities/UtilitiesMenu.svelte',
    "    { href: Route.workflows(), icon: mdiStateMachine, label: $t('workflows') },\n",
    '',
  ],
  // Admin pages that need several users, external libraries, backups or a database server
  [
    'web/src/lib/components/layouts/AdminPageLayout.svelte',
    `      {#if featureFlagsManager.value.backups}
        <ImmichBackupsAdminNavButton href={Route.backups()} />
      {/if}

      <NavbarItem title={$t('users')} href={Route.users()} icon={mdiAccountMultipleOutline} />
      <NavbarItem title={$t('external_libraries')} href={Route.libraries()} icon={mdiBookshelf} />
`,
    '',
  ],
  [
    'web/src/lib/components/layouts/AdminPageLayout.svelte',
    `      <NavbarItem title={$t('admin.maintenance_settings')} href={Route.systemMaintenance()} icon={mdiWrench} />
      <NavbarItem title="Storage Migration" href={Route.storageMigration()} icon={mdiCloudSyncOutline} />
`,
    '',
  ],
  // Settings: Frames backup (export/import); no account, device, notification, sharing or purchase sections
  [
    SETTINGS_LIST,
    "  import UserUsageStatistic from './UserUsageStatistic.svelte';\n",
    "  import UserUsageStatistic from './UserUsageStatistic.svelte';\n  import FramesBackupSettings from '#lib/frames/FramesBackupSettings.svelte';\n  import { mdiBackupRestore } from '@mdi/js';\n",
  ],
  [
    SETTINGS_LIST,
    '<SettingAccordion icon={mdiApi} key="api-keys"',
    '{#if false}\n<SettingAccordion icon={mdiApi} key="api-keys"',
  ],
  [SETTINGS_LIST, '  <DeviceList />\n</SettingAccordion>\n', '  <DeviceList />\n</SettingAccordion>\n{/if}\n'],
  [
    SETTINGS_LIST,
    '  <DownloadSettings />\n</SettingAccordion>\n',
    '  <DownloadSettings />\n</SettingAccordion>\n\n<SettingAccordion icon={mdiBackupRestore} key="frames-backup" title="Backup and restore" subtitle="Export everything Frames knows about your photos, and import it again">\n  <FramesBackupSettings />\n</SettingAccordion>\n',
  ],
  [
    SETTINGS_LIST,
    '<SettingAccordion\n  icon={mdiBellOutline}',
    '{#if false}\n<SettingAccordion\n  icon={mdiBellOutline}',
  ],
  [SETTINGS_LIST, '  <SharingSettings />\n</SettingAccordion>', '  <SharingSettings />\n</SettingAccordion>\n{/if}'],
  // No locked folder (Frames has no PIN-protected area)
  [
    'web/src/lib/components/shared-components/side-bar/UserSidebar.svelte',
    "  <NavbarItem title={$t('locked_folder')} href={Route.locked()} icon={mdiLockOutline} activeIcon={mdiLock} />\n",
    '',
  ],
  // Font: Parkinsans everywhere (bundled in gallery-files, never fetched from Google)
  [
    'web/src/app.css',
    `@layer utilities {
  @font-face {
    font-family: 'GoogleSans';`,
    `@layer utilities {
  @font-face {
    font-family: 'Parkinsans';
    src: url('./lib/assets/fonts/Parkinsans/Parkinsans.ttf') format('truetype-variations');
    font-weight: 300 800;
    font-style: normal;
  }

  @font-face {
    font-family: 'GoogleSans';`,
  ],
  ['web/src/app.css', "--font-sans: 'GoogleSans', sans-serif;", "--font-sans: 'Parkinsans', 'GoogleSans', sans-serif;"],
  [
    'web/src/hooks.server.ts',
    "import GoogleSans from '#lib/assets/fonts/GoogleSans/GoogleSans.ttf?url';",
    "import GoogleSans from '#lib/assets/fonts/Parkinsans/Parkinsans.ttf?url';",
  ],
  // Branding
  ['web/src/routes/+layout.svelte', `|| 'Web'} - Immich</title>`, `|| 'Photos'} - Frames</title>`],
  ['web/src/app.html', 'To use Immich,', 'To use Frames,'],
  ['web/src/lib/components/layouts/AuthPageLayout.svelte', 'alt="Gallery logo"', 'alt="Frames logo"'],
  ['web/src/lib/components/shared-components/Logo.svelte', 'alt="Gallery logo"', 'alt="Frames logo"'],
  ['web/src/lib/utils/handle-error.ts', '(Immich Server Error)', '(Frames error)'],
];

/** Product names in translations; Frames is a single offline app, not "Immich" or "(Noodle) Gallery". */
const NAMES = [
  [/\bNoodle Gallery\b/g, 'Frames'],
  [/\bImmich\b/g, 'Frames'],
  [/\bGallery\b/g, 'Frames'],
];
const EN = { no_assets_message: 'No photos yet: copy some into your library folder' };

export function applyFramesOverlay(dest, brandingDir) {
  const crlf = new Map();
  const read = (rel) => {
    const raw = fs.readFileSync(path.join(dest, rel), 'utf8');
    crlf.set(rel, raw.includes('\r\n'));
    return raw.replace(/\r\n/g, '\n');
  };
  const write = (rel, s) => fs.writeFileSync(path.join(dest, rel), crlf.get(rel) ? s.replace(/\n/g, '\r\n') : s);

  // Frames' own UI files (web/src/lib/frames/*) first, so edits can import them
  fs.cpSync(path.join(brandingDir, '..', 'gallery-files'), dest, { recursive: true });

  for (const [rel, find, replace] of EDITS) {
    const s = read(rel);
    if (!s.includes(find)) throw new Error(`Frames overlay: "${find.trim().slice(0, 60)}" not found in ${rel}`);
    write(rel, s.replace(find, replace));
  }

  for (const dir of ['i18n', 'i18n/gallery'])
    for (const f of fs.readdirSync(path.join(dest, dir)).filter((f) => f.endsWith('.json'))) {
      const rel = `${dir}/${f}`;
      const rename = (v) =>
        typeof v === 'string'
          ? NAMES.reduce((s, [re, to]) => s.replace(re, to), v)
          : v && typeof v === 'object'
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rename(x)]))
            : v;
      const data = rename(JSON.parse(read(rel)));
      if (f === 'en.json') for (const [k, v] of Object.entries(EN)) if (k in data) data[k] = v;
      write(rel, `${JSON.stringify(data, null, 2)}\n`);
    }

  const manifest = JSON.parse(read('web/static/manifest.json'));
  Object.assign(manifest, {
    name: 'Frames',
    short_name: 'Frames',
    description: 'Your photo library, offline on your PC.',
  });
  write('web/static/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

  for (const f of fs.readdirSync(brandingDir))
    fs.copyFileSync(path.join(brandingDir, f), path.join(dest, 'web', 'static', f));
}
