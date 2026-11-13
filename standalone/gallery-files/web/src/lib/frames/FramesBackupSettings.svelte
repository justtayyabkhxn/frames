<script lang="ts">
  import { handleError } from '#lib/utils/handle-error.ts';
  import { Button, toastManager } from '@immich/ui';
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';

  type Saved = { name: string; size: number; createdAt: string };
  type Result = { files: number; missing: number; albums: number; tags: number; people: number; faces: number };

  let saved = $state<Saved[]>([]);
  let busy = $state(false);
  let picker = $state<HTMLInputElement>();

  const call = async (method: string, url: string, body?: string) => {
    const res = await fetch(url, { method, body, headers: body ? { 'Content-Type': 'application/json' } : {} });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.message ?? res.statusText);
    return data;
  };
  const load = async () => {
    saved = await call('GET', '/api/frames/exports');
  };
  const size = (n: number) => (n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  const summary = (r: Result) =>
    `Restored ${r.albums} albums, ${r.tags} tags, ${r.people} people and ${r.faces} faces; ${r.files} photos matched` +
    (r.missing ? `, ${r.missing} not in this library` : '');

  const run = async (task: () => Promise<void>, failure: string) => {
    busy = true;
    try {
      await task();
    } catch (error) {
      handleError(error, failure);
    } finally {
      busy = false;
    }
  };
  const exportNow = () =>
    run(async () => {
      const r = await call('POST', '/api/frames/export');
      toastManager.primary(`Saved ${r.name}`);
      await load();
    }, 'Could not export');
  const restore = (body: () => Promise<{ url: string; text?: string }>) =>
    run(async () => {
      const { url, text } = await body();
      toastManager.primary(summary(await call('POST', url, text)));
    }, 'Could not import');
  const importSaved = (name: string) => restore(async () => ({ url: `/api/frames/import?name=${encodeURIComponent(name)}` }));
  const importFile = (file: File) => restore(async () => ({ url: '/api/frames/import', text: await file.text() }));
  const remove = (name: string) =>
    run(async () => {
      await call('DELETE', `/api/frames/exports/${encodeURIComponent(name)}`);
      await load();
    }, 'Could not delete');

  onMount(load);
</script>

<section class="my-4">
  <div in:fade={{ duration: 500 }} class="flex flex-col gap-4 sm:ms-8">
    <p class="text-sm text-gray-600 dark:text-gray-300">
      Save everything Frames knows about your photos (favorites, archive, albums, tags, people and faces, face
      decisions, locations, ratings, descriptions and settings) to a file in the Frames folder (data/exports). Import
      it later, here or on another PC with the same photos. Importing only adds; it never deletes.
    </p>
    <div class="flex flex-wrap gap-2">
      <Button shape="round" size="small" disabled={busy} onclick={exportNow}>Export now</Button>
      <Button shape="round" size="small" variant="outline" disabled={busy} onclick={() => picker?.click()}>
        Import from file…
      </Button>
      <input
        bind:this={picker}
        type="file"
        accept=".json,application/json"
        class="hidden"
        onchange={(e) => {
          const file = (e.currentTarget as HTMLInputElement).files?.[0];
          if (file) importFile(file);
          (e.currentTarget as HTMLInputElement).value = '';
        }}
      />
    </div>
    {#if saved.length > 0}
      <ul class="flex flex-col gap-2">
        {#each saved as item (item.name)}
          <li class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
            <div class="flex flex-col">
              <span class="text-sm font-medium">{new Date(item.createdAt).toLocaleString()}</span>
              <span class="text-xs text-gray-500">{item.name} · {size(item.size)}</span>
            </div>
            <div class="flex gap-2">
              <Button shape="round" size="small" variant="ghost" href={`/api/frames/exports/${encodeURIComponent(item.name)}`}>
                Download
              </Button>
              <Button shape="round" size="small" variant="ghost" disabled={busy} onclick={() => importSaved(item.name)}>
                Import
              </Button>
              <Button shape="round" size="small" variant="ghost" color="danger" disabled={busy} onclick={() => remove(item.name)}>
                Delete
              </Button>
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="text-sm text-gray-500">No exports yet.</p>
    {/if}
  </div>
</section>
