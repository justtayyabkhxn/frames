<template>
  <div class="dup-outer" tabindex="-1" ref="outer" @keydown="onKey">
    <header class="dup-head">
      <h1>
        {{ t('memories', 'Duplicates') }}
        <span v-if="groups.length" class="n">({{ groups.length }})</span>
      </h1>
      <div class="actions">
        <label class="sens">
          {{ t('memories', 'Match') }}
          <select v-model="sensitivity" @change="load(false)" :disabled="loading">
            <option value="strict">{{ t('memories', 'Near-identical') }}</option>
            <option value="normal">{{ t('memories', 'Very similar') }}</option>
            <option value="loose">{{ t('memories', 'Similar') }}</option>
          </select>
        </label>
        <NcButton variant="tertiary" :disabled="loading" @click="load(true)">{{ t('memories', 'Re-scan') }}</NcButton>
        <NcButton variant="secondary" :disabled="loading || !groups.length" @click="keepAll">
          {{ t('memories', 'Keep all') }}
        </NcButton>
        <NcButton variant="primary" :disabled="loading || !groups.length" @click="dedupeAll">
          {{ t('memories', 'Deduplicate all') }}
        </NcButton>
      </div>
    </header>

    <div v-if="loading" class="state">
      <XLoadingIcon />
      <p>{{ t('memories', 'Comparing your photos. Large libraries can take a couple of minutes.') }}</p>
    </div>
    <div v-else-if="error" class="state">
      <p>{{ error }}</p>
    </div>
    <div v-else-if="!group" class="state">
      <CheckIcon :size="40" />
      <p>{{ t('memories', 'No duplicates were found.') }}</p>
    </div>

    <template v-else>
      <p class="lede">
        {{ t('memories', 'Resolve each group by choosing which copies to keep. Trashed photos can be restored.') }}
      </p>

      <section class="group" :aria-label="t('memories', 'Group {i} of {n}', { i: index + 1, n: groups.length })">
        <div class="group-bar">
          <div class="pills">
            <button type="button" class="pill" @click="markAll(true)">{{ t('memories', 'Select keep all') }}</button>
            <button type="button" class="pill" @click="markAll(false)">
              {{ t('memories', 'Select trash all') }}
            </button>
          </div>
          <NcButton :variant="trashCount ? 'error' : 'secondary'" :disabled="busy" @click="resolve">
            {{
              !trashCount
                ? t('memories', 'Keep all')
                : trashCount === group.files.length
                  ? t('memories', 'Trash all')
                  : t('memories', 'Trash {count}', { count: trashCount })
            }}
          </NcButton>
        </div>

        <div class="tiles">
          <div v-for="f of group.files" :key="f.fileid" class="tile" :class="{ trash: !keep.has(f.fileid) }">
            <button
              type="button"
              class="thumb"
              :aria-pressed="keep.has(f.fileid)"
              :aria-label="f.basename"
              @click="toggle(f.fileid)"
            >
              <img :src="thumb(f)" alt="" loading="lazy" />
              <span class="badge">{{ keep.has(f.fileid) ? t('memories', 'Keep') : t('memories', 'To trash') }}</span>
              <HeartIcon v-if="f.favorite" class="fav" :size="18" />
            </button>
            <button type="button" class="zoom" :aria-label="t('memories', 'View')" @click="view(f)">
              <MagnifyIcon :size="18" />
            </button>
            <dl>
              <template v-for="row of rows" :key="row.label">
                <dt>{{ row.label }}</dt>
                <dd :title="row.get(f)">{{ row.get(f) }}</dd>
              </template>
            </dl>
          </div>
        </div>
      </section>

      <nav class="pager" :aria-label="t('memories', 'Groups')">
        <button type="button" class="pill" :disabled="index === 0" @click="go(0)">{{ t('memories', 'First') }}</button>
        <button type="button" class="pill" :disabled="index === 0" @click="go(index - 1)">
          {{ t('memories', 'Previous') }}
        </button>
        <span>{{ index + 1 }} / {{ groups.length }}</span>
        <button type="button" class="pill" :disabled="index >= groups.length - 1" @click="go(index + 1)">
          {{ t('memories', 'Next') }}
        </button>
        <button type="button" class="pill" :disabled="index >= groups.length - 1" @click="go(groups.length - 1)">
          {{ t('memories', 'Last') }}
        </button>
      </nav>
      <p class="keys">
        {{ t('memories', 'Keys: ← → groups · A keep all · D suggested · S view · Shift+C apply') }}
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useTemplateRef } from 'vue';
import axios from '@nextcloud/axios';
import { generateUrl } from '@nextcloud/router';
import NcButton from '@nextcloud/vue/components/NcButton';

import { API } from '@services/API';
import { t } from '@services/l10n';
import * as utils from '@services/utils/common';
import XLoadingIcon from '@components/XLoadingIcon.vue';

import CheckIcon from 'vue-material-design-icons/CheckCircleOutline.vue';
import HeartIcon from 'vue-material-design-icons/Heart.vue';
import MagnifyIcon from 'vue-material-design-icons/Magnify.vue';

import type { IPhoto } from '@typings';

type DupFile = {
  fileid: number;
  basename: string;
  path: string;
  size: number;
  etag: string;
  mimetype: string;
  favorite: number;
  w: number;
  h: number;
  datetaken: number;
  dayid: number;
  exifCount: number;
  rating: number;
};
type Group = { key: string; files: DupFile[]; keep: number };

const BASE = '/apps/memories/api/duplicates';
const url = (p = '') => generateUrl(BASE + p);

const outer = useTemplateRef<HTMLElement>('outer');
const groups = ref<Group[]>([]);
const index = ref(0);
const keep = ref(new Set<number>());
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const sensitivity = ref(localStorage.getItem('frames.dup.sensitivity') ?? 'normal');

const group = computed(() => groups.value[index.value] ?? null);
const trashCount = computed(() => (group.value ? group.value.files.length - keep.value.size : 0));

const fmtSize = (b: number) => utils.humanFileSize(b);
const ALL_ROWS = [
  { label: t('memories', 'Size'), get: (f: DupFile) => fmtSize(f.size), always: true },
  { label: t('memories', 'Resolution'), get: (f: DupFile) => `${f.w} × ${f.h}`, always: true },
  { label: t('memories', 'Name'), get: (f: DupFile) => f.basename },
  { label: t('memories', 'Folder'), get: (f: DupFile) => f.path.split('/').slice(0, -1).join('/') || '/' },
  {
    label: t('memories', 'Taken'),
    get: (f: DupFile) => utils.getLongDateStr(new Date(f.datetaken * 1000), false, true),
  },
  { label: t('memories', 'Rating'), get: (f: DupFile) => (f.rating ? '★'.repeat(f.rating) : '—') },
  { label: t('memories', 'Metadata fields'), get: (f: DupFile) => String(f.exifCount) },
];
/** Only the rows that tell the copies apart (plus size and resolution). */
const rows = computed(() =>
  ALL_ROWS.filter((r) => r.always || new Set(group.value?.files.map((f) => r.get(f))).size > 1),
);

const toPhoto = (f: DupFile): IPhoto => ({
  fileid: f.fileid,
  etag: f.etag,
  basename: f.basename,
  mimetype: f.mimetype,
  dayid: f.dayid,
  w: f.w,
  h: f.h,
  flag: 0,
});
const thumb = (f: DupFile) => utils.getPreviewUrl({ photo: toPhoto(f), msize: 512 });

function go(i: number) {
  index.value = Math.max(0, Math.min(groups.value.length - 1, i));
  keep.value = new Set(group.value ? [group.value.keep] : []);
}

function toggle(id: number) {
  const next = new Set(keep.value);
  next.has(id) ? next.delete(id) : next.add(id);
  keep.value = next;
}

function markAll(k: boolean) {
  keep.value = new Set(k ? group.value!.files.map((f) => f.fileid) : []);
}

function view(f: DupFile) {
  const list = group.value!.files.map(toPhoto);
  _m.viewer.openStatic(
    list.find((p) => p.fileid === f.fileid)!,
    list,
    512,
  );
}

async function load(refresh: boolean) {
  localStorage.setItem('frames.dup.sensitivity', sensitivity.value);
  loading.value = true;
  error.value = '';
  try {
    const q = { sensitivity: sensitivity.value, refresh: refresh || undefined };
    const res = await axios.get<{ groups: Group[] }>(API.Q(url(), q));
    groups.value = res.data.groups;
    go(0);
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? t('memories', 'Could not compare photos. Is the AI engine running?');
  } finally {
    loading.value = false;
    outer.value?.focus();
  }
}

/** Drop the current group and stay at the same position. */
function advance() {
  groups.value.splice(index.value, 1);
  go(index.value);
}

async function resolve() {
  const g = group.value;
  if (!g || busy.value) return;
  const trash = g.files.map((f) => f.fileid).filter((id) => !keep.value.has(id));
  busy.value = true;
  try {
    if (!trash.length) await axios.post(url('/dismiss'), { keys: [g.key] });
    else {
      await axios.post(url('/resolve'), { keep: [...keep.value], trash });
      utils.bus.emit('memories:timeline:deleted', g.files.filter((f) => trash.includes(f.fileid)).map(toPhoto));
    }
    advance();
  } catch (e: any) {
    utils.showError(e?.response?.data?.message ?? String(e));
  } finally {
    busy.value = false;
  }
}

async function keepAll() {
  if (
    !(await utils.confirmDestructive({
      title: t('memories', 'Keep all'),
      message: t('memories', 'This will resolve all duplicate groups without deleting anything.'),
    }))
  )
    return;
  await axios.post(url('/dismiss'), { keys: groups.value.map((g) => g.key) });
  groups.value = [];
}

async function dedupeAll() {
  const n = groups.value.reduce((s, g) => s + g.files.length - 1, 0);
  if (
    !(await utils.confirmDestructive({
      title: t('memories', 'Deduplicate all'),
      message: t('memories', 'Keep the suggested copy in every group and move {n} photos to the trash?', { n }),
    }))
  )
    return;
  busy.value = true;
  for (const g of [...groups.value]) {
    const trash = g.files.map((f) => f.fileid).filter((id) => id !== g.keep);
    await axios.post(url('/resolve'), { keep: [g.keep], trash }).catch(() => null);
  }
  busy.value = false;
  groups.value = [];
}

function onKey(e: KeyboardEvent) {
  if (!group.value || (e.target as HTMLElement)?.closest('select')) return;
  const k = e.key;
  if (k === 'ArrowRight') go(index.value + 1);
  else if (k === 'ArrowLeft') go(index.value - 1);
  else if (k === 'a') markAll(true);
  else if (k === 'd') go(index.value);
  else if (k === 's') view(group.value.files[0]);
  else if (k === 'C' && e.shiftKey) resolve();
  else return;
  e.preventDefault();
}

onMounted(() => load(false));
</script>

<style lang="scss" scoped>
.dup-outer {
  height: 100%;
  overflow-y: auto;
  padding: 8px 16px 32px;
  outline: none;
}

.dup-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--color-border-dark);
  padding-bottom: 6px;

  h1 {
    flex: 1;
    margin: 0;
    font-size: 1.3em;
    font-weight: 400;
    line-height: 42px;
    .n {
      color: var(--color-text-maxcontrast);
    }
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .sens {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--color-text-maxcontrast);
    select {
      margin: 0;
    }
  }
}

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 80px 16px;
  color: var(--color-text-maxcontrast);
  text-align: center;
}

.lede {
  margin: 14px 0;
  color: var(--color-text-maxcontrast);
}

.group {
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 12px;
}

.group-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.pills {
  display: flex;
  gap: 8px;
}

.pill {
  all: unset;
  padding: 6px 12px;
  border-radius: 16px;
  border: 1px solid var(--color-border);
  font-size: 0.9em;
  cursor: pointer;
  &:hover:not(:disabled) {
    background: var(--color-background-hover);
  }
  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
  &:focus-visible {
    outline: 2px solid var(--color-primary-element);
  }
}

.tiles {
  display: flex;
  gap: 14px;
  overflow-x: auto;
  padding-bottom: 6px;
}

.tile {
  position: relative;
  flex: none;
  width: 240px;

  .thumb {
    all: unset;
    position: relative;
    display: block;
    width: 240px;
    height: 240px;
    border-radius: 10px;
    overflow: hidden;
    cursor: pointer;
    background: var(--color-background-dark);
    outline: 3px solid #2e9e5b;
    outline-offset: -3px;

    img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    &:focus-visible {
      box-shadow: 0 0 0 3px var(--color-primary-element);
    }
  }
  &.trash .thumb {
    outline-color: var(--color-error);
    img {
      opacity: 0.55;
    }
  }

  .badge {
    position: absolute;
    left: 8px;
    bottom: 8px;
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 0.8em;
    font-weight: 600;
    color: #fff;
    background: #2e9e5b;
  }
  &.trash .badge {
    background: var(--color-error);
  }
  .fav {
    position: absolute;
    right: 8px;
    bottom: 8px;
    color: #fff;
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));
  }
  .zoom {
    all: unset;
    position: absolute;
    top: 8px;
    right: 8px;
    display: inline-flex;
    padding: 6px;
    border-radius: 50%;
    color: #fff;
    background: rgba(0, 0, 0, 0.5);
    cursor: pointer;
    &:focus-visible {
      outline: 2px solid #fff;
    }
  }

  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 10px;
    margin: 10px 2px 0;
    font-size: 0.85em;
    dt {
      color: var(--color-text-maxcontrast);
    }
    dd {
      margin: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
}

.pager {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}

.keys {
  text-align: center;
  font-size: 0.8em;
  color: var(--color-text-maxcontrast);
}
</style>
