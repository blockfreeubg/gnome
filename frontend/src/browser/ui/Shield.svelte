<!--
  The toolbar shield (WAVE-B3 §7.1): how many requests GNOME's content blocker stopped on this page (every category
  but direct connections, which GNOME's sandbox stops whether or not blocking is on), with a state dot while the
  blocker prepares its filter lists or failed. The popover (a gesture in GNOME's UI) is loaded on first open: it needs
  core/site.ts (tldts), which stays out of the app's first chunk. Shown only for proxied pages, and only once the
  built-in extensions are registered (registerFeature('extensions')): no numbers for GNOME's own pages.
-->
<script lang="ts">
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import ShieldOff from '@lucide/svelte/icons/shield-off';
  import Badge from '../../components/Badge.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import { inHostList } from '../../shared/site-rules';
  import { settings } from '../../settings/store.svelte';
  import { sumCounts } from '../../extensions/app/stats.svelte';
  import { browser } from '../browser.svelte';
  import type { Tab } from '../tabs.svelte';

  let { tab }: { tab: Tab } = $props();
  let anchor = $state<HTMLElement>();
  let open = $state(false);

  const count = $derived(sumCounts(tab.blockedBy));
  const blocker = $derived(browser.status?.blocker ?? null);
  const paused = $derived(!!tab.url && inHostList(settings.value.extensions.allowlist, tab.url));
  const dot = $derived(blocker?.state === 'building' ? 'warning' : blocker?.state === 'failed' ? 'danger' : null);
  const label = $derived.by(() => {
    if (paused) return 'Content blocking is paused on this site';
    const state = blocker?.state === 'building' ? ' (preparing filter lists)' : blocker?.state === 'failed' ? ' (filter lists could not be prepared)' : '';
    return `${count === 0 ? 'Nothing' : count === 1 ? '1 request' : `${count} requests`} blocked on this page${state}`;
  });

  // Loaded on first open and kept (a dynamic import: its own chunk with tldts).
  let Popover = $state<typeof import('./ShieldPopover.svelte').default | null>(null);
  async function toggle(): Promise<void> {
    if (!Popover) Popover = (await import('./ShieldPopover.svelte')).default;
    open = !open;
  }
</script>

<span class="shield" bind:this={anchor} data-shield-count={count}>
  <IconButton icon={paused ? ShieldOff : ShieldCheck} {label} size="sm" tooltipPlacement="bottom" pressed={open} onclick={() => void toggle()} />
  {#if count > 0 && !paused}<Badge count={count} tone="neutral" class="shield-badge" />{/if}
  {#if dot}<Badge dot tone={dot} class="shield-dot" />{/if}
</span>

{#if Popover}
  <Popover bind:open {anchor} {tab} />
{/if}

<style>
  .shield {
    position: relative;
    display: inline-flex;
  }

  .shield :global(.shield-badge) {
    position: absolute;
    top: -4px;
    right: -6px;
    pointer-events: none;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    font-size: 10px;
  }

  .shield :global(.shield-dot) {
    position: absolute;
    bottom: 3px;
    right: 3px;
    pointer-events: none;
  }
</style>
