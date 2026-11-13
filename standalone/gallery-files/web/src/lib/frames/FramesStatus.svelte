<!-- Frames' live activity pill (top bar): library scan and photo reading, and what the AI engine is doing right now. -->
<script lang="ts">
  import { Icon } from '@immich/ui';
  import { mdiCheck, mdiFaceRecognition, mdiFolderSearchOutline, mdiImageSearchOutline, mdiMapMarkerOutline, mdiRefresh, mdiShimmer } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { fade } from 'svelte/transition';

  type Status = {
    phase: 'idle' | 'scanning' | 'indexing';
    found: number;
    done: number;
    total: number;
    count: number;
    ai?: { state: string; stage?: string | null; queued?: number; indexed?: number; faces?: number; error?: string };
  };
  type Item = { icon: string; text: string; detail?: string; pct?: number };

  const AI_STAGE: Record<string, [string, string]> = {
    reading: [mdiImageSearchOutline, 'AI: reading photos'],
    objects: [mdiShimmer, 'AI: recognising objects & scenes'],
    faces: [mdiFaceRecognition, 'AI: finding faces'],
    places: [mdiMapMarkerOutline, 'AI: naming places'],
  };
  const n = (x = 0) => x.toLocaleString();

  let status = $state<Status>();
  let loadedCount = $state<number>();
  let doneFlash = $state(false);
  let timer: ReturnType<typeof setTimeout>;
  let flashTimer: ReturnType<typeof setTimeout>;
  let stopped = false;

  const items = $derived.by(() => {
    const s = status;
    const out: Item[] = [];
    if (!s) return out;
    if (s.phase === 'scanning') out.push({ icon: mdiFolderSearchOutline, text: 'Scanning folders', detail: `${n(s.found)} found` });
    if (s.phase === 'indexing')
      out.push({
        icon: mdiImageSearchOutline,
        text: 'Reading photos',
        detail: `${n(s.done)} / ${n(s.total)}`,
        pct: s.total ? s.done / s.total : 0,
      });
    const ai = s.ai;
    if (ai?.state === 'starting') out.push({ icon: mdiShimmer, text: 'AI engine starting' });
    if (ai?.state === 'indexing') {
      const [icon, text] = AI_STAGE[ai.stage ?? ''] ?? [mdiShimmer, 'AI: looking at photos'];
      // The AI's queue only holds what it was handed so far, so "left" would understate: show what is done
      out.push({ icon, text, detail: `${n(ai.indexed)} done · ${n(ai.faces)} faces` });
    }
    return out;
  });
  const busy = $derived(items.length > 0);
  const fresh = $derived(status && loadedCount !== undefined ? status.count - loadedCount : 0);

  async function poll() {
    if (stopped) return;
    try {
      if (!document.hidden) {
        const res = await fetch('/api/frames/status');
        if (res.ok) {
          const wasBusy = busy;
          status = await res.json();
          loadedCount ??= status!.count;
          if (wasBusy && !busy) {
            doneFlash = true;
            clearTimeout(flashTimer);
            flashTimer = setTimeout(() => (doneFlash = false), 5000);
          }
        }
      }
    } catch {
      // Frames restarting: try again shortly
    }
    timer = setTimeout(poll, busy ? 1000 : 4000);
  }

  onMount(() => void poll());
  onDestroy(() => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(flashTimer);
  });
</script>

{#if busy || doneFlash || fresh > 0}
  <div
    transition:fade={{ duration: 150 }}
    role="status"
    aria-live="polite"
    class="flex h-10 max-w-[min(34rem,60vw)] items-center gap-3 overflow-hidden rounded-full bg-primary/10 ps-3 pe-2 text-sm text-primary"
  >
    {#each items as item, i (item.text)}
      {#if i > 0}<span class="h-5 w-px shrink-0 bg-primary/25"></span>{/if}
      <span class="flex min-w-0 items-center gap-2" title="{item.text}{item.detail ? ` · ${item.detail}` : ''}">
        <Icon icon={item.icon} size="18" class="shrink-0 motion-safe:animate-pulse" />
        <span class="hidden truncate font-medium lg:inline">{item.text}</span>
        {#if item.detail}<span class="truncate tabular-nums opacity-80">{item.detail}</span>{/if}
        {#if item.pct !== undefined}
          <span class="hidden h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-primary/20 md:block">
            <span class="block h-full rounded-full bg-primary transition-[width] duration-500" style:width="{Math.round(item.pct * 100)}%"></span>
          </span>
        {/if}
      </span>
    {/each}
    {#if !busy && doneFlash}
      <span class="flex items-center gap-2 font-medium">
        <Icon icon={mdiCheck} size="18" />
        Up to date · {n(status?.count)} photos
      </span>
    {/if}
    {#if fresh > 0}
      <button
        type="button"
        onclick={() => location.reload()}
        class="flex shrink-0 items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-medium text-light hover:opacity-90"
        title="Show the newly indexed photos"
      >
        <Icon icon={mdiRefresh} size="14" />
        {n(fresh)} new
      </button>
    {:else}
      <span class="w-1"></span>
    {/if}
  </div>
{/if}
