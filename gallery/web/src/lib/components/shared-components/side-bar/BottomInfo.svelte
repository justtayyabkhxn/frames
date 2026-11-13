<script lang="ts">
  import { authManager } from '#lib/managers/auth-manager.svelte.ts';
  import { featureFlagsManager } from '#lib/managers/feature-flags-manager.svelte.ts';
  import { Route } from '#lib/route.ts';
  import { hideBackupsReminder } from '#lib/stores/preferences.store.ts';
  import { ImmichBackupsSidebarItem } from '@futo-org/backups-orchestrator-ui';
  import PurchaseInfo from './PurchaseInfo.svelte';
  import ServerStatus from './ServerStatus.svelte';
  import StorageSpace from './StorageSpace.svelte';
</script>

<div class="ms-4 mt-auto overflow-hidden rounded-lg">
  <StorageSpace />

  {#if authManager.user.isAdmin && featureFlagsManager.value.backups && !$hideBackupsReminder}
    <ImmichBackupsSidebarItem href={Route.backups()} />
  {/if}
</div>


<div class="mb-6"></div>
