<template>
  <div class="fc-outer">
    <header class="fc-head">
      <h1>{{ t('memories', 'Clean up people') }}</h1>
      <NcButton variant="secondary" :disabled="loading" @click="scan">{{ t('memories', 'Re-scan') }}</NcButton>
    </header>
    <p class="lede">
      {{
        t(
          'memories',
          'These faces look more like someone else. Move them to the person they match, or keep them where they are so they are not flagged again.',
        )
      }}
    </p>

    <div v-if="loading" class="state">
      <XLoadingIcon />
      <p>{{ t('memories', 'Checking every person for faces that look out of place …') }}</p>
    </div>
    <div v-else-if="error" class="state">
      <p>{{ error }}</p>
    </div>
    <div v-else-if="!people.length" class="state">
      <CheckIcon :size="40" />
      <p>{{ t('memories', 'Nothing to clean up') }}</p>
    </div>

    <div v-else class="fc-body">
      <nav class="people" :aria-label="t('memories', 'People with flagged faces')">
        <button
          v-for="p of people"
          :key="p.cluster"
          type="button"
          class="person"
          :class="{ selected: p.cluster === selected?.cluster }"
          @click="select(p)"
        >
          <img :src="personThumb(p.cluster)" alt="" />
          <span class="label">
            <span class="name">{{ p.name || t('memories', 'Unnamed person') }}</span>
            <span class="sub">{{
              t('memories', '{n} of {total} faces flagged', { n: p.faces.length, total: p.total })
            }}</span>
          </span>
          <span v-if="p.overCap" class="flag">{{ t('memories', 'Needs your review') }}</span>
        </button>
      </nav>

      <section v-if="selected" class="review">
        <div class="review-head">
          <h2>{{ t('memories', 'Reviewing: {name}', { name: selected.name || t('memories', 'Unnamed person') }) }}</h2>
          <p v-if="selected.overCap" class="warn">
            {{
              t('memories', 'Most of this person’s faces look like someone else. Check carefully before moving them.')
            }}
          </p>
        </div>

        <div class="bulk">
          <span>{{ n('memories', '{n} selected', '{n} selected', picked.size, { n: picked.size }) }}</span>
          <button type="button" class="pill" @click="pickAll">{{ t('memories', 'Select all') }}</button>
          <button type="button" class="pill" :disabled="!picked.size" @click="picked = new Set()">
            {{ t('memories', 'Clear') }}
          </button>
          <span class="spacer"></span>
          <NcButton variant="tertiary" :disabled="!picked.size || busy" @click="apply('stay')">
            {{ t('memories', 'Keep here') }}
          </NcButton>
          <NcButton variant="primary" :disabled="!picked.size || busy" @click="apply('move')">
            {{ t('memories', 'Move to suggested person') }}
          </NcButton>
        </div>

        <div class="grid">
          <button
            v-for="(f, i) of selected.faces"
            :key="f.faceid"
            type="button"
            class="tile"
            :class="{ picked: picked.has(f.faceid) }"
            :aria-pressed="picked.has(f.faceid)"
            @click="pick(i, $event)"
          >
            <img :src="crop(f.faceid)" alt="" loading="lazy" />
            <span class="to">
              <img :src="personThumb(f.suspected)" alt="" />
              {{ f.suspectedName || t('memories', 'Unnamed person') }}
            </span>
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import axios from '@nextcloud/axios';
import { generateUrl } from '@nextcloud/router';
import NcButton from '@nextcloud/vue/components/NcButton';

import { API } from '@services/API';
import { t, n } from '@services/l10n';
import * as utils from '@services/utils/common';
import XLoadingIcon from '@components/XLoadingIcon.vue';

import CheckIcon from 'vue-material-design-icons/CheckCircleOutline.vue';

type Face = { faceid: number; fileid: number; suspected: number; suspectedName: string };
type Person = { cluster: number; name: string; total: number; overCap: boolean; faces: Face[] };

const people = ref<Person[]>([]);
const selected = ref<Person | null>(null);
const picked = ref(new Set<number>());
const lastPick = ref(-1);
const loading = ref(false);
const busy = ref(false);
const error = ref('');

const crop = (id: number) => generateUrl(`/apps/memories/api/faces/${id}/crop`);
const personThumb = (cluster: number) => API.CLUSTER_PREVIEW('recognize', cluster, 0, '');

function select(p: Person | null) {
  selected.value = p;
  picked.value = new Set();
  lastPick.value = -1;
}

/** Click toggles one face; Shift-click selects the range from the last click. */
function pick(i: number, e: MouseEvent) {
  const faces = selected.value!.faces;
  const next = new Set(picked.value);
  if (e.shiftKey && lastPick.value >= 0) {
    const [a, b] = [lastPick.value, i].sort((x, y) => x - y);
    for (let k = a; k <= b; k++) next.add(faces[k].faceid);
  } else if (next.has(faces[i].faceid)) next.delete(faces[i].faceid);
  else next.add(faces[i].faceid);
  picked.value = next;
  lastPick.value = i;
}

function pickAll() {
  picked.value = new Set(selected.value!.faces.map((f) => f.faceid));
}

async function scan() {
  loading.value = true;
  error.value = '';
  try {
    const res = await axios.get<{ people: Person[] }>(generateUrl('/apps/memories/api/faces/cleanup'));
    people.value = res.data.people;
    select(people.value.find((p) => p.cluster === selected.value?.cluster) ?? people.value[0] ?? null);
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? t('memories', 'Could not check faces. Is the AI engine running?');
  } finally {
    loading.value = false;
  }
}

async function apply(kind: 'move' | 'stay') {
  const p = selected.value!;
  const faces = p.faces.filter((f) => picked.value.has(f.faceid));
  busy.value = true;
  try {
    const body =
      kind === 'move'
        ? { move: faces.map((f) => ({ faceid: f.faceid, to: f.suspected })) }
        : { stay: faces.map((f) => f.faceid) };
    await axios.post(generateUrl('/apps/memories/api/faces/cleanup/apply'), body);
    p.faces = p.faces.filter((f) => !picked.value.has(f.faceid));
    if (!p.faces.length) {
      people.value = people.value.filter((x) => x !== p);
      select(people.value[0] ?? null);
    } else picked.value = new Set();
    utils.showSuccess(
      kind === 'move'
        ? n('memories', 'Moved {n} face', 'Moved {n} faces', faces.length, { n: faces.length })
        : n('memories', 'Kept {n} face', 'Kept {n} faces', faces.length, { n: faces.length }),
    );
  } catch (e: any) {
    utils.showError(e?.response?.data?.message ?? String(e));
  } finally {
    busy.value = false;
  }
}

onMounted(scan);
</script>

<style lang="scss" scoped>
.fc-outer {
  height: 100%;
  overflow-y: auto;
  padding: 8px 16px 32px;
}

.fc-head {
  display: flex;
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
  }
}

.lede {
  margin: 12px 0 16px;
  color: var(--color-text-maxcontrast);
  max-width: 70ch;
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

.fc-body {
  display: flex;
  gap: 20px;
  align-items: flex-start;
  @media (max-width: 800px) {
    flex-direction: column;
  }
}

.people {
  flex: 0 0 280px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  @media (max-width: 800px) {
    flex-basis: auto;
    width: 100%;
  }

  .person {
    all: unset;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px;
    border-radius: 10px;
    cursor: pointer;
    &:hover {
      background: var(--color-background-hover);
    }
    &.selected {
      background: var(--color-primary-element-light);
    }
    &:focus-visible {
      outline: 2px solid var(--color-primary-element);
    }
    img {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--color-background-dark);
    }
    .label {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .name {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sub {
      font-size: 0.85em;
      color: var(--color-text-maxcontrast);
    }
    .flag {
      font-size: 0.75em;
      padding: 2px 8px;
      border-radius: 10px;
      color: var(--color-warning-text, #8a5a00);
      background: var(--color-warning-hover, #fff1d6);
    }
  }
}

.review {
  flex: 1;
  min-width: 0;
  h2 {
    margin: 0;
    font-size: 1.1em;
  }
  .warn {
    margin: 6px 0 0;
    color: var(--color-warning-text, #8a5a00);
  }
}

.bulk {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
  padding: 8px 0;
  background: var(--color-main-background);
  .spacer {
    flex: 1;
  }
}

.pill {
  all: unset;
  padding: 6px 12px;
  border-radius: 16px;
  border: 1px solid var(--color-border);
  font-size: 0.9em;
  cursor: pointer;
  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
  &:focus-visible {
    outline: 2px solid var(--color-primary-element);
  }
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
}

.tile {
  all: unset;
  display: flex;
  flex-direction: column;
  gap: 6px;
  cursor: pointer;
  border-radius: 12px;
  padding: 4px;

  > img {
    width: 100%;
    aspect-ratio: 1;
    border-radius: 10px;
    object-fit: cover;
    background: var(--color-background-dark);
  }
  &.picked {
    background: var(--color-primary-element-light);
    > img {
      outline: 3px solid var(--color-primary-element);
      outline-offset: -3px;
    }
  }
  &:focus-visible {
    outline: 2px solid var(--color-primary-element);
  }
  .to {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.85em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    img {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      object-fit: cover;
      flex: none;
    }
  }
}
</style>
