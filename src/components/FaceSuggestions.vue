<template>
  <div v-if="showBanner" class="sugg-banner">
    <img class="avatar" :src="personThumb" alt="" />
    <div class="text">
      <div class="title">{{ t('memories', 'Faces found that could be {name}', { name: data!.name }) }}</div>
      <div class="sub">{{ n('memories', '{n} face found', '{n} faces found', data!.total, { n: data!.total }) }}</div>
    </div>
    <div class="crops">
      <img v-for="f of data!.items.slice(0, 5)" :key="f.faceid" :src="crop(f)" alt="" loading="lazy" />
    </div>
    <NcButton variant="primary" @click="openReview">{{ t('memories', 'Review') }}</NcButton>
    <NcButton variant="tertiary" @click="notNow">{{ t('memories', 'Not now') }}</NcButton>
  </div>

  <Teleport to="body">
    <div v-if="reviewing" class="sugg-modal" role="dialog" aria-modal="true" tabindex="-1" ref="modal" @keydown="onKey">
      <div class="panel">
        <header>
          <h2>{{ t('memories', 'Is this {name}?', { name: data!.name }) }}</h2>
          <span v-if="current" class="count">{{ t('memories', '{i} of {n}', { i: pos + 1, n: queue.length }) }}</span>
          <button type="button" class="icon-btn" :aria-label="t('memories', 'Close')" @click="close">
            <CloseIcon :size="20" />
          </button>
        </header>

        <div v-if="!current" class="done">
          <CheckIcon :size="40" />
          <p>{{ t('memories', 'All suggestions reviewed') }}</p>
          <NcButton variant="primary" @click="close">{{ t('memories', 'Done') }}</NcButton>
        </div>

        <template v-else>
          <div class="body">
            <div class="photo" :style="{ aspectRatio: `${current.iw || 4} / ${current.ih || 3}` }">
              <img :src="photoUrl(current)" alt="" />
              <div
                class="box"
                :style="{
                  left: `${current.x * 100}%`,
                  top: `${current.y * 100}%`,
                  width: `${current.w * 100}%`,
                  height: `${current.h * 100}%`,
                }"
              ></div>
              <span v-if="decided.has(current.faceid)" class="reviewed">{{ t('memories', 'Reviewed') }}</span>
            </div>
            <aside class="compare">
              <figure>
                <img :src="personThumb" alt="" />
                <figcaption>{{ t('memories', 'Known photo') }}</figcaption>
              </figure>
              <figure>
                <img :src="crop(current)" alt="" />
                <figcaption>{{ t('memories', 'Suggested face') }}</figcaption>
              </figure>
              <button type="button" class="link" @click="openPhoto">{{ t('memories', 'Open photo') }}</button>
            </aside>
          </div>

          <footer>
            <button
              type="button"
              class="icon-btn"
              :disabled="pos === 0"
              :aria-label="t('memories', 'Previous')"
              @click="pos--"
            >
              <ChevronLeftIcon :size="24" />
            </button>
            <NcButton variant="secondary" :disabled="busy" @click="act('reject')">
              {{ t('memories', 'Different person') }} <kbd>D</kbd>
            </NcButton>
            <NcButton variant="tertiary" :disabled="busy" @click="act('ignore')">
              {{ t('memories', 'Ignore face') }} <kbd>I</kbd>
            </NcButton>
            <NcButton variant="primary" :disabled="busy" @click="act('confirm')">
              {{ t('memories', 'Same person') }} <kbd>S</kbd>
            </NcButton>
            <button
              type="button"
              class="icon-btn"
              :disabled="pos >= queue.length - 1"
              :aria-label="t('memories', 'Next')"
              @click="pos++"
            >
              <ChevronRightIcon :size="24" />
            </button>
          </footer>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch, useTemplateRef } from 'vue';
import { useRoute } from 'vue-router';
import axios from '@nextcloud/axios';
import { generateUrl } from '@nextcloud/router';
import NcButton from '@nextcloud/vue/components/NcButton';

import { API } from '@services/API';
import { t, n } from '@services/l10n';
import * as utils from '@services/utils/common';

import CheckIcon from 'vue-material-design-icons/CheckCircleOutline.vue';
import CloseIcon from 'vue-material-design-icons/Close.vue';
import ChevronLeftIcon from 'vue-material-design-icons/ChevronLeft.vue';
import ChevronRightIcon from 'vue-material-design-icons/ChevronRight.vue';

import type { IPhoto } from '@typings';

type Face = {
  faceid: number;
  fileid: number;
  x: number;
  y: number;
  w: number;
  h: number;
  iw: number;
  ih: number;
  dayid: number;
  etag: string;
  basename: string;
  mimetype: string;
};
type Data = { name: string; total: number; items: Face[] };

const emit = defineEmits<{ load: [] }>();
const route = useRoute();
const modal = useTemplateRef<HTMLElement>('modal');

const person = computed(() => String(route.params.name ?? ''));
const data = ref<Data | null>(null);
const reviewing = ref(false);
const queue = ref<Face[]>([]);
const pos = ref(0);
const busy = ref(false);
const decided = ref(new Set<number>());
const snoozed = ref(false);

const url = (p: string) => generateUrl(`/apps/memories/api/people/${encodeURIComponent(person.value)}/suggestions${p}`);
const snoozeKey = () => `frames.suggest.${person.value}`;
const current = computed(() => queue.value[pos.value] ?? null);
const showBanner = computed(() => !!data.value?.name && data.value.total > 0 && !snoozed.value);
const personThumb = computed(() => API.CLUSTER_PREVIEW('recognize', person.value, 0, ''));

const crop = (f: Face) => generateUrl(`/apps/memories/api/faces/${f.faceid}/crop`);
const toPhoto = (f: Face): IPhoto => ({
  fileid: f.fileid,
  etag: f.etag,
  basename: f.basename,
  mimetype: f.mimetype,
  dayid: f.dayid,
  w: f.iw,
  h: f.ih,
  flag: 0,
});
const photoUrl = (f: Face) => utils.getPreviewUrl({ photo: toPhoto(f), msize: 1024 });

async function load() {
  data.value = null;
  if (!person.value || /^\d+$/.test(person.value)) return; // named people only
  try {
    const snooze = JSON.parse(localStorage.getItem(snoozeKey()) ?? 'null');
    const res = await axios.get<Data>(url(''));
    data.value = res.data;
    snoozed.value = !!snooze && snooze.until > Date.now() && res.data.total <= snooze.count;
  } catch {
    data.value = null; // AI engine off: no banner
  }
  await nextTick();
  emit('load');
}

function notNow() {
  localStorage.setItem(snoozeKey(), JSON.stringify({ until: Date.now() + 30 * 86400_000, count: data.value!.total }));
  snoozed.value = true;
  nextTick(() => emit('load'));
}

async function openReview() {
  queue.value = [...data.value!.items];
  pos.value = 0;
  decided.value = new Set();
  reviewing.value = true;
  await nextTick();
  modal.value?.focus();
}

function close() {
  reviewing.value = false;
  load();
}

async function act(action: 'confirm' | 'reject' | 'ignore') {
  const face = current.value;
  if (!face || busy.value) return;
  busy.value = true;
  try {
    await axios.post(url(`/${face.faceid}`), { action });
    decided.value.add(face.faceid);
    if (action === 'confirm') utils.showSuccess(t('memories', '1 face added'));
    queue.value.splice(pos.value, 1);
    pos.value = Math.min(pos.value, Math.max(0, queue.value.length - 1));
  } catch (e: any) {
    utils.showError(e?.response?.data?.message ?? String(e));
  } finally {
    busy.value = false;
  }
}

function openPhoto() {
  const p = toPhoto(current.value!);
  _m.viewer.openStatic(p, [p], 512);
}

function onKey(e: KeyboardEvent) {
  const k = e.key.toLowerCase();
  if (k === 'escape') close();
  else if (!current.value) return;
  else if (k === 's') act('confirm');
  else if (k === 'd') act('reject');
  else if (k === 'i') act('ignore');
  else if (k === 'o') openPhoto();
  else if (k === 'arrowleft') pos.value = Math.max(0, pos.value - 1);
  else if (k === 'arrowright') pos.value = Math.min(queue.value.length - 1, pos.value + 1);
  else return;
  e.preventDefault();
}

watch(person, load, { immediate: true });
</script>

<style lang="scss" scoped>
.sugg-banner {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin: 8px 12px;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid var(--color-border);
  background: var(--color-background-hover);

  .avatar {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    object-fit: cover;
  }
  .text {
    flex: 1;
    min-width: 180px;
    .title {
      font-weight: 600;
    }
    .sub {
      font-size: 0.9em;
      color: var(--color-text-maxcontrast);
    }
  }
  .crops {
    display: flex;
    gap: 6px;
    img {
      width: 56px;
      height: 56px;
      border-radius: 8px;
      object-fit: cover;
      background: var(--color-background-dark);
    }
  }
}

.sugg-modal {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
  outline: none;

  .panel {
    width: min(1100px, 96vw);
    max-height: 94vh;
    overflow: auto;
    border-radius: 14px;
    background: var(--color-main-background);
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px 10px 20px;
    h2 {
      flex: 1;
      margin: 0;
      font-size: 1.2em;
    }
    .count {
      color: var(--color-text-maxcontrast);
    }
  }
  .body {
    display: flex;
    gap: 20px;
    padding: 0 20px;
    flex-wrap: wrap;
  }
  .photo {
    position: relative;
    flex: 1 1 520px;
    max-height: 62vh;
    max-width: 100%;
    overflow: hidden;
    border-radius: 10px;
    background: #000;
    img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
    .box {
      position: absolute;
      border: 2px solid #fff;
      border-radius: 6px;
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.55);
    }
    .reviewed {
      position: absolute;
      top: 10px;
      left: 10px;
      padding: 2px 10px;
      border-radius: 12px;
      background: var(--color-primary-element);
      color: var(--color-primary-element-text);
      font-size: 0.8em;
    }
  }
  .compare {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    flex: 0 0 160px;
    figure {
      margin: 0;
      text-align: center;
    }
    img {
      width: 140px;
      height: 140px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--color-background-dark);
    }
    figcaption {
      margin-top: 6px;
      font-size: 0.85em;
      color: var(--color-text-maxcontrast);
    }
  }
  footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 16px 20px 20px;
    kbd {
      margin-left: 6px;
      font-size: 0.75em;
      opacity: 0.7;
    }
  }
  .done {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 60px 20px;
  }
}

.icon-btn {
  all: unset;
  display: inline-flex;
  padding: 8px;
  border-radius: 50%;
  cursor: pointer;
  &:hover:not(:disabled) {
    background: var(--color-background-hover);
  }
  &:disabled {
    opacity: 0.35;
    cursor: default;
  }
  &:focus-visible {
    outline: 2px solid var(--color-primary-element);
  }
}

.link {
  all: unset;
  cursor: pointer;
  color: var(--color-primary-element);
  font-size: 0.9em;
  &:focus-visible {
    outline: 2px solid var(--color-primary-element);
  }
}
</style>
