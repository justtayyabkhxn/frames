<template>
  <div class="filter-bar">
    <button type="button" class="chip toggle" :class="{ active: chips.length }" @click="open = !open">
      <FilterIcon :size="18" />
      {{ t('memories', 'Filters') }}
      <span v-if="chips.length" class="count">{{ chips.length }}</span>
    </button>
    <button
      v-for="chip of chips"
      :key="chip.key"
      type="button"
      class="chip"
      :aria-label="t('memories', 'Remove filter {name}', { name: chip.label })"
      @click="set(chip.key, null)"
    >
      {{ chip.label }}
      <CloseIcon :size="16" />
    </button>
    <button v-if="chips.length > 1" type="button" class="chip clear" @click="clearAll">
      {{ t('memories', 'Clear all') }}
    </button>
  </div>

  <Teleport to="body">
    <Transition name="filter-drawer">
      <aside
        v-if="open"
        ref="drawer"
        class="filter-drawer"
        tabindex="-1"
        :aria-label="t('memories', 'Filters')"
        @keydown.esc="open = false"
      >
        <header>
          <h2>{{ t('memories', 'Filters') }}</h2>
          <button v-if="chips.length" type="button" class="link" @click="clearAll">
            {{ t('memories', 'Clear all') }}
          </button>
          <button type="button" class="icon-btn" :aria-label="t('memories', 'Close')" @click="open = false">
            <CloseIcon :size="20" />
          </button>
        </header>

        <section v-if="facets.people.length || active.fperson">
          <h3>{{ t('memories', 'People') }}</h3>
          <input
            v-if="facets.people.length > PEOPLE_SHOWN"
            v-model="personQuery"
            class="search"
            type="search"
            :placeholder="t('memories', 'Search people …')"
          />
          <button
            v-for="p of shownPeople"
            :key="p.value"
            type="button"
            class="row"
            :class="{ selected: String(p.value) === active.fperson }"
            @click="toggle('fperson', String(p.value))"
          >
            <img class="face" :src="facePreview(p.value)" alt="" loading="lazy" />
            <span class="name">{{ p.name || t('memories', 'Unnamed person') }}</span>
            <span class="n">{{ p.count }}</span>
          </button>
          <button v-if="morePeople > 0" type="button" class="link" @click="allPeople = true">
            {{ t('memories', 'Show {count} more', { count: morePeople }) }}
          </button>
        </section>

        <section v-if="facets.places.length || active.fplace">
          <h3>{{ t('memories', 'Location') }}</h3>
          <button
            v-for="p of facets.places.slice(0, allPlaces ? undefined : LIST_SHOWN)"
            :key="p.value"
            type="button"
            class="row"
            :class="{ selected: String(p.value) === active.fplace }"
            @click="toggle('fplace', String(p.value))"
          >
            <MapMarkerIcon :size="18" />
            <span class="name">{{ p.name }}</span>
            <span class="n">{{ p.count }}</span>
          </button>
          <button
            v-if="!allPlaces && facets.places.length > LIST_SHOWN"
            type="button"
            class="link"
            @click="allPlaces = true"
          >
            {{ t('memories', 'Show {count} more', { count: facets.places.length - LIST_SHOWN }) }}
          </button>
        </section>

        <section v-if="facets.cameras.length || active.fcamera">
          <h3>{{ t('memories', 'Camera') }}</h3>
          <button
            v-for="c of facets.cameras.slice(0, allCameras ? undefined : LIST_SHOWN)"
            :key="c.value"
            type="button"
            class="row"
            :class="{ selected: c.value === active.fcamera }"
            @click="toggle('fcamera', c.value)"
          >
            <CameraIcon :size="18" />
            <span class="name">{{ c.value }}</span>
            <span class="n">{{ c.count }}</span>
          </button>
          <button
            v-if="!allCameras && facets.cameras.length > LIST_SHOWN"
            type="button"
            class="link"
            @click="allCameras = true"
          >
            {{ t('memories', 'Show {count} more', { count: facets.cameras.length - LIST_SHOWN }) }}
          </button>
        </section>

        <section>
          <h3>{{ t('memories', 'Star rating') }}</h3>
          <StarRating
            :value="Number(active.frating) || 0"
            :size="26"
            @change="(r) => set('frating', r ? String(r) : null)"
          />
          <p class="hint">
            {{
              active.frating
                ? t('memories', 'At least {n} stars', { n: active.frating })
                : t('memories', 'Pick the lowest rating to show')
            }}
          </p>
        </section>

        <section>
          <h3>{{ t('memories', 'Media type') }}</h3>
          <div class="segmented" role="radiogroup">
            <button
              v-for="opt of typeOptions"
              :key="opt.value"
              type="button"
              role="radio"
              :aria-checked="(active.ftype ?? '') === opt.value"
              :class="{ selected: (active.ftype ?? '') === opt.value }"
              @click="set('ftype', opt.value || null)"
            >
              {{ opt.label }}
            </button>
          </div>
        </section>
      </aside>
    </Transition>
  </Teleport>
</template>

<script lang="ts">
/** Route query keys of the filter panel; the timeline passes them to the API as-is. */
export const FILTER_KEYS = ['fperson', 'fplace', 'fcamera', 'frating', 'ftype'] as const;
</script>

<script setup lang="ts">
import { computed, nextTick, ref, watch, useTemplateRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import axios from '@nextcloud/axios';

import { API } from '@services/API';
import { useRouteIs } from '@services/route-is';
import { t } from '@services/l10n';
import StarRating from '@components/StarRating.vue';

import FilterIcon from 'vue-material-design-icons/FilterVariant.vue';
import CloseIcon from 'vue-material-design-icons/Close.vue';
import MapMarkerIcon from 'vue-material-design-icons/MapMarker.vue';
import CameraIcon from 'vue-material-design-icons/Camera.vue';

type Key = (typeof FILTER_KEYS)[number];
type Facet = { value: number; name?: string; count: number };
type Facets = {
  people: Facet[];
  places: Facet[];
  cameras: { value: string; count: number }[];
  ratings: { value: number; count: number }[];
  types: { value: string; count: number }[];
};

const PEOPLE_SHOWN = 6;
const LIST_SHOWN = 8;

const route = useRoute();
const router = useRouter();
const routeIs = useRouteIs();
const drawer = useTemplateRef<HTMLElement>('drawer');

const open = ref(false);
const personQuery = ref('');
const allPeople = ref(false);
const allPlaces = ref(false);
const allCameras = ref(false);
const facets = ref<Facets>({ people: [], places: [], cameras: [], ratings: [], types: [] });

const active = computed(() => {
  const out: Partial<Record<Key, string>> = {};
  for (const key of FILTER_KEYS) if (route.query[key]) out[key] = String(route.query[key]);
  return out;
});

const chips = computed(() => {
  const a = active.value;
  const name = (list: Facet[], v?: string) => list.find((x) => String(x.value) === v)?.name;
  const chips: { key: Key; label: string }[] = [];
  if (a.fperson) chips.push({ key: 'fperson', label: name(facets.value.people, a.fperson) || t('memories', 'Person') });
  if (a.fplace) chips.push({ key: 'fplace', label: name(facets.value.places, a.fplace) || t('memories', 'Place') });
  if (a.fcamera) chips.push({ key: 'fcamera', label: a.fcamera });
  if (a.frating) chips.push({ key: 'frating', label: t('memories', '{n}+ stars', { n: a.frating }) });
  if (a.ftype)
    chips.push({ key: 'ftype', label: a.ftype === 'video' ? t('memories', 'Videos') : t('memories', 'Photos') });
  return chips;
});

const filteredPeople = computed(() => {
  const q = personQuery.value.trim().toLowerCase();
  return q ? facets.value.people.filter((p) => p.name?.toLowerCase().includes(q)) : facets.value.people;
});
const shownPeople = computed(() =>
  allPeople.value || personQuery.value ? filteredPeople.value : filteredPeople.value.slice(0, PEOPLE_SHOWN),
);
const morePeople = computed(() => filteredPeople.value.length - shownPeople.value.length);

const typeOptions = computed(() => {
  const n = (v: string) => facets.value.types.find((x) => x.value === v)?.count ?? 0;
  return [
    { value: '', label: t('memories', 'All') },
    { value: 'photo', label: `${t('memories', 'Photos')} · ${n('photo')}` },
    { value: 'video', label: `${t('memories', 'Videos')} · ${n('video')}` },
  ];
});

const facePreview = (id: number) => API.CLUSTER_PREVIEW('recognize', id, 0, '');

function set(key: Key, value: string | null) {
  router.replace({ query: { ...route.query, [key]: value ?? undefined } });
}

function toggle(key: Key, value: string) {
  set(key, active.value[key] === value ? null : value);
}

function clearAll() {
  const query = { ...route.query };
  for (const key of FILTER_KEYS) delete query[key];
  router.replace({ query });
}

// Facets narrow to what the other active filters leave; the newest request wins
let controller: AbortController | null = null;
async function loadFacets() {
  if (!open.value && !active.value.fperson && !active.value.fplace) return;
  controller?.abort();
  controller = new AbortController();
  const params: Record<string, string> = { ...active.value };
  if (routeIs.Favorites) params.fav = '1';
  if (routeIs.Videos) params.vid = '1';
  try {
    const res = await axios.get<Facets>(API.Q(API.FILTERS(), params), { signal: controller.signal });
    facets.value = res.data;
  } catch {
    // aborted or offline: keep the last facets
  }
}

watch([open, active], loadFacets, { immediate: true });
watch(open, async (isOpen) => {
  if (isOpen) {
    await nextTick();
    drawer.value?.focus();
  }
});
</script>

<style lang="scss" scoped>
.filter-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 12px 4px;
  overflow-x: auto;
  scrollbar-width: none;
}

.chip {
  all: unset;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: 16px;
  border: 1px solid var(--color-border);
  font-size: 0.9em;
  cursor: pointer;
  background: var(--color-main-background);

  &:hover {
    background: var(--color-background-hover);
  }
  &:focus-visible {
    outline: 2px solid var(--color-primary-element);
  }
  &.toggle.active {
    border-color: var(--color-primary-element);
    color: var(--color-primary-element);
  }
  &.clear {
    border-color: transparent;
    color: var(--color-text-maxcontrast);
  }
  .count {
    min-width: 18px;
    height: 18px;
    border-radius: 9px;
    padding: 0 4px;
    box-sizing: border-box;
    text-align: center;
    line-height: 18px;
    font-size: 0.8em;
    background: var(--color-primary-element);
    color: var(--color-primary-element-text);
  }
}

.filter-drawer {
  position: fixed;
  top: var(--header-height, 50px);
  right: 0;
  bottom: 0;
  width: min(340px, 100vw);
  z-index: 2000;
  overflow-y: auto;
  background: var(--color-main-background);
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.18);
  outline: none;

  header {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 12px 12px 20px;
    background: var(--color-main-background);
    border-bottom: 1px solid var(--color-border);
    h2 {
      flex: 1;
      margin: 0;
      font-size: 1.15em;
    }
  }

  section {
    padding: 14px 20px 10px;
    h3 {
      margin: 0 0 8px;
      font-size: 0.85em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--color-text-maxcontrast);
    }
  }

  .search {
    width: 100%;
    margin: 0 0 6px;
  }

  .row {
    all: unset;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 6px 8px;
    border-radius: 8px;
    cursor: pointer;
    color: var(--color-main-text);

    &:hover {
      background: var(--color-background-hover);
    }
    &:focus-visible {
      outline: 2px solid var(--color-primary-element);
    }
    &.selected {
      background: var(--color-primary-element-light);
      font-weight: 600;
    }
    .face {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--color-background-dark);
    }
    .name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .n {
      color: var(--color-text-maxcontrast);
      font-size: 0.85em;
    }
  }

  .hint {
    margin: 4px 0 0;
    font-size: 0.85em;
    color: var(--color-text-maxcontrast);
  }

  .segmented {
    display: flex;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    overflow: hidden;
    button {
      all: unset;
      flex: 1;
      text-align: center;
      padding: 7px 4px;
      font-size: 0.9em;
      cursor: pointer;
      &.selected {
        background: var(--color-primary-element);
        color: var(--color-primary-element-text);
      }
      &:focus-visible {
        outline: 2px solid var(--color-primary-element);
        outline-offset: -2px;
      }
    }
  }
}

.link {
  all: unset;
  cursor: pointer;
  font-size: 0.9em;
  color: var(--color-primary-element);
  padding: 4px 8px;
  &:focus-visible {
    outline: 2px solid var(--color-primary-element);
  }
}

.icon-btn {
  all: unset;
  display: inline-flex;
  padding: 6px;
  border-radius: 50%;
  cursor: pointer;
  &:hover {
    background: var(--color-background-hover);
  }
}

.filter-drawer-enter-active,
.filter-drawer-leave-active {
  transition: transform 0.2s ease;
}
.filter-drawer-enter-from,
.filter-drawer-leave-to {
  transform: translateX(100%);
}
</style>
