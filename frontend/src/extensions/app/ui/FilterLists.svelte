<!--
  The filter lists of GET /api/filters (docs/API.md), as the app's listing has them (extensions/app/listing.svelte.ts):
  grouped by category, each with its publisher, license, size and last update, an on/off switch, and, once the engine
  host reported `blocker.stats`, whether it was compiled or why not (GNOME's own sentence for the list's code: names
  and texts never come from the engine host). Used by Settings → Extensions and the Extensions page (WAVE-B3 §7.1).
  "Update lists now" asks the server for the listing whatever `autoUpdateLists` says.
-->
<script lang="ts">
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Button from '../../../components/Button.svelte';
  import Skeleton from '../../../components/Skeleton.svelte';
  import Switch from '../../../components/Switch.svelte';
  import Tag from '../../../components/Tag.svelte';
  import { formatBytes, formatRelativeTime } from '../../../lib/format';
  import { settings } from '../../../settings/store.svelte';
  import type { BlockerStats } from '../../../shared/engine-protocol';
  import { browser } from '../../../browser/browser.svelte';
  import { listErrorText } from '../../../browser/ui/error-copy';
  import { CATEGORY_LABELS, CATEGORY_ORDER, categoryCanApply, listEnabled, safeHref, type ServerFilterList } from '../lists';

  let { stats = null }: { stats?: BlockerStats | null } = $props();

  const store = browser.filterListing;
  const listing = $derived(store.listing);
  const lists = $derived(listing?.lists ?? []);
  const choices = $derived(settings.value.extensions.lists);
  const blockingOn = $derived(Object.values(settings.value.extensions.enabled).some(Boolean));
  let updating = $state(false);

  const isOn = (l: ServerFilterList): boolean => listEnabled(l, choices);
  const compiled = $derived(new Map((stats?.lists ?? []).map((l) => [l.id, l])));

  /** "1.2 MB · updated 3 hours ago · GPL-3.0" (built here: whitespace at the edges of template blocks is dropped). */
  function meta(l: ServerFilterList): string {
    const parts: string[] = [];
    if (!l.available) parts.push('Not downloaded by the server yet');
    else {
      if (l.size > 0) parts.push(formatBytes(l.size));
      if (l.updated_at && l.updated_at > 0) parts.push(`updated ${formatRelativeTime(l.updated_at)}`);
    }
    parts.push(l.license || 'License not stated');
    return parts.join(' · ');
  }

  function toggle(l: ServerFilterList, on: boolean): void {
    const next = { ...choices };
    // Store only deviations from the server's default, so new defaults reach people who never touched a list.
    if (on === l.default_enabled) delete next[l.id];
    else next[l.id] = on;
    settings.set('extensions', 'lists', next);
  }

  async function updateNow(): Promise<void> {
    updating = true;
    try {
      await store.refresh('user');
    } finally {
      updating = false;
    }
  }

  const groups = $derived.by(() => {
    const by = new Map<string, ServerFilterList[]>();
    for (const l of lists) by.set(l.category, [...(by.get(l.category) ?? []), l]);
    return CATEGORY_ORDER.filter((k) => by.has(k)).map((k) => ({ key: k, label: CATEGORY_LABELS[k], lists: by.get(k)!.sort((a, b) => a.name.localeCompare(b.name)) }));
  });
  const stale = $derived(listing ? Object.keys(choices).filter((id) => !lists.some((l) => l.id === id)) : []);
  const enabledCount = $derived(lists.filter(isOn).length);
  const checked = $derived(store.checkedAt);
</script>

<div class="filters" data-filter-lists>
  {#if listing === null && (store.state === 'loading' || store.state === 'idle')}
    <Skeleton lines={3} />
  {:else if listing === null && store.state === 'missing'}
    <p class="msg">This server does not publish filter lists, so blocking uses no lists. Your choices are kept and apply once it does.</p>
  {:else if listing === null}
    <div class="msg row">
      <span>The filter lists could not be loaded from the server.</span>
      <Button size="sm" variant="ghost" icon={RefreshCw} onclick={() => void updateNow()}>Try again</Button>
    </div>
  {:else if !lists.length}
    <p class="msg">This server publishes no filter lists.</p>
  {:else}
    <div class="msg row">
      <span>
        {enabledCount} of {lists.length} lists on{blockingOn ? '' : ' — every blocker is off, so none are applied'}.
        {#if checked}Checked with the server {formatRelativeTime(checked)}.{/if}
      </span>
      <Button size="sm" variant="ghost" icon={RefreshCw} loading={updating} onclick={() => void updateNow()}>Update lists now</Button>
    </div>
    {#each groups as group (group.key)}
      {@const applies = categoryCanApply(group.key, settings.value)}
      <div class="group">
        <h4 class="eyebrow">{group.label}{applies ? '' : ' · its blocker is off'}</h4>
        <ul>
          {#each group.lists as l (l.id)}
            {@const href = safeHref(l.homepage)}
            {@const st = compiled.get(l.id)}
            <li data-list={l.id}>
              <div class="info">
                <span class="name">{l.name}</span>
                <span class="meta">
                  {meta(l)}{#if href}{' · '}<a {href} target="_blank" rel="noopener noreferrer">Publisher <ExternalLink size={12} aria-hidden="true" /></a>{/if}
                </span>
                {#if st && isOn(l)}
                  {#if st.state === 'compiled'}
                    <span class="state ok" data-list-state="compiled">In use · {st.rules.toLocaleString()} rules{st.dropped ? ` (${st.dropped.toLocaleString()} left out)` : ''}</span>
                  {:else}
                    <span class="state bad" data-list-state="failed">{listErrorText(st.error)}</span>
                  {/if}
                {/if}
              </div>
              <div class="toggle">
                {#if l.default_enabled}<Tag tone="neutral">Default</Tag>{/if}
                <Switch id="filter-list-{l.id}" aria-label={l.name} checked={isOn(l)} onchange={(on) => toggle(l, on)} />
              </div>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
    {#if stale.length}
      <p class="msg">
        {stale.length} saved choice{stale.length === 1 ? ' is' : 's are'} for lists this server no longer offers.
        <Button
          size="sm"
          variant="ghost"
          onclick={() => {
            const next = { ...choices };
            for (const id of stale) delete next[id];
            settings.set('extensions', 'lists', next);
          }}>Forget them</Button
        >
      </p>
    {/if}
  {/if}
</div>

<style>
  .filters {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    width: 100%;
  }

  .msg {
    font-size: var(--text-sm);
    color: var(--text-2);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .group h4 {
    margin-bottom: var(--space-2);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
  }

  li {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
  }

  li + li {
    border-top: 1px solid var(--hairline);
  }

  .info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .name {
    font-weight: 500;
  }

  .meta {
    font-size: var(--text-sm);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }

  .meta a {
    color: var(--text-2);
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  .state {
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .state.ok {
    color: var(--success);
  }

  .state.bad {
    color: var(--danger);
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
</style>
