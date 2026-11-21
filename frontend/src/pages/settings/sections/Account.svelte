<script lang="ts">
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Button from '../../../components/Button.svelte';
  import Switch from '../../../components/Switch.svelte';
  import { formatRelativeTime } from '../../../lib/format';
  import { account } from '../../../settings/account.svelte';
  import { syncNow } from '../../../settings/account-sync';
  import type { Settings } from '../../../settings/schema';
  import { settings } from '../../../settings/store.svelte';
  import { getRecordSync } from '../../../settings/sync';
  import AccountPanel from '../AccountPanel.svelte';
  import Group from '../Group.svelte';
  import Row from '../Row.svelte';

  type Acct = Settings['account'];
  const S = 'account' as const;
  const a = $derived(settings.value.account);
  const set = <K extends keyof Acct>(k: K, v: Acct[K]): void => void settings.set(S, k, v);

  const canSync = $derived(account.signedIn && account.syncAvailable);
  const syncOn = $derived(canSync && a.sync);
  const status = $derived(account.sync);

  const syncDescription = $derived.by(() => {
    if (!account.syncAvailable) return 'This server does not offer sync. Everything stays in this browser.';
    if (!account.signedIn) return 'Sign in above to keep a copy on this server and in your other browsers.';
    return undefined;
  });

  const statusText = $derived.by(() => {
    if (!syncOn) return null;
    switch (status.state) {
      case 'syncing':
        return 'Syncing…';
      case 'error':
        return `Sync failed: ${status.error ?? 'unknown error'}`;
      case 'offline':
        return 'Waiting for the server to be reachable.';
      default:
        return status.lastSyncedAt ? `Last synced ${formatRelativeTime(status.lastSyncedAt)}.` : 'Not synced yet.';
    }
  });

  const notStored = (kind: 'bookmarks' | 'history'): string =>
    `${kind === 'bookmarks' ? 'Bookmarks are' : 'History is'} not stored by this build yet; the choice applies once ${kind === 'bookmarks' ? 'they are' : 'it is'}.`;
</script>

<Group title="Account" bare>
  <Row section={S} id="account" stacked>
    {#snippet control()}
      <AccountPanel />
    {/snippet}
  </Row>
</Group>

<Group title="Sync">
  <Row section={S} id="sync" description={syncDescription} disabled={!canSync}>
    {#snippet control()}
      <Switch checked={syncOn} onchange={(v) => set('sync', v)} />
    {/snippet}
    {#snippet children()}
      {#if statusText}
        <div class="status" class:error={status.state === 'error'}>
          <span role="status">{statusText}</span>
          <Button size="sm" variant="ghost" icon={RefreshCw} loading={status.state === 'syncing'} onclick={() => void syncNow()}>Sync now</Button>
        </div>
      {/if}
    {/snippet}
  </Row>
  <Row section={S} id="syncSettings" disabled={!syncOn}>
    {#snippet control()}
      <Switch checked={a.syncSettings} onchange={(v) => set('syncSettings', v)} />
    {/snippet}
  </Row>
  <Row section={S} id="syncBookmarks" disabled={!syncOn} description={getRecordSync('bookmarks') ? undefined : notStored('bookmarks')}>
    {#snippet control()}
      <Switch checked={a.syncBookmarks} onchange={(v) => set('syncBookmarks', v)} />
    {/snippet}
  </Row>
  <Row
    section={S}
    id="syncHistory"
    disabled={!syncOn}
    description={getRecordSync('history') ? undefined : `Sends the addresses you visit to this server. ${notStored('history')}`}
  >
    {#snippet control()}
      <Switch checked={a.syncHistory} onchange={(v) => set('syncHistory', v)} />
    {/snippet}
  </Row>
</Group>

<style>
  /* The card names itself; the row's label and description stay for screen readers and search. */
  :global(.row[data-row='account.account'] .setting-row) {
    padding: 0;
  }

  :global(.row[data-row='account.account'] .setting-row > .text) {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .status {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    font-size: var(--text-sm);
    color: var(--text-2);
  }

  .status.error {
    color: var(--danger);
  }
</style>
