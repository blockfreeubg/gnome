<!--
  History: visits newest first, grouped by day, with search (URL and title), selection, per-visit actions,
  "remove every visit to this page", clearing by time range and Undo. Data: src/library (IndexedDB), live across
  GNOME tabs. Links open through the browser bridge; middle-click opens GNOME's /browse link, never the site directly.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import Bookmark from '@lucide/svelte/icons/bookmark';
  import Copy from '@lucide/svelte/icons/copy';
  import Ellipsis from '@lucide/svelte/icons/ellipsis-vertical';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import HistoryIcon from '@lucide/svelte/icons/history';
  import PanelTop from '@lucide/svelte/icons/panel-top';
  import Search from '@lucide/svelte/icons/search';
  import CloudCheck from '@lucide/svelte/icons/cloud-check';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Button from '../../components/Button.svelte';
  import Checkbox from '../../components/Checkbox.svelte';
  import Dialog from '../../components/Dialog.svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import PageHeader from '../../components/PageHeader.svelte';
  import RadioGroup from '../../components/RadioGroup.svelte';
  import SearchInput from '../../components/SearchInput.svelte';
  import Skeleton from '../../components/Skeleton.svelte';
  import type { MenuItem } from '../../components/menu';
  import { openContextMenu } from '../../app/overlays/contextmenu.svelte';
  import { toast } from '../../app/overlays/toast.svelte';
  import type { PageProps } from '../../app/routes';
  import { browseLink, openUrl } from '../../browser/bridge';
  import { formatNumber } from '../../lib/format';
  import { initLibrary, localLibrary } from '../../library/index';
  import { clearSyncedHistory, historySynced } from '../../library/synced';
  import Notice from '../../library/ui/Notice.svelte';
  import SiteTile from '../../library/ui/SiteTile.svelte';
  import { CLEAR_RANGES, copyText, errorText, formatClock, groupByDay, hostname, rangeStart, shortUrl, type ClearRange, word } from '../../library/ui/view';
  import { BOOKMARK_ROOT, type HistoryVisit } from '../../shared/browser-data';
  import { settings } from '../../settings/store.svelte';

  let { query }: PageProps = $props();

  initLibrary();
  const lib = localLibrary()!;
  const PAGE = 150;

  const initialQuery = (): string => query.get('q') ?? '';
  let text = $state(initialQuery());
  let applied = $state(initialQuery());
  // Raw: replaced as a whole on every load (up to 2000 visits; no deep proxies needed).
  let visits = $state.raw<HistoryVisit[]>([]);
  let total = $state<number | null>(null);
  let loading = $state(true);
  let loadingMore = $state(false);
  let hasMore = $state(false);
  let failed = $state<string | null>(null);
  let clearOpen = $state(false);
  let clearRange = $state<ClearRange>('hour');
  let clearing = $state(false);
  let clearRemote = $state(true);
  let sentinel = $state<HTMLElement>();
  const selected = new SvelteSet<string>();

  const enabled = $derived(settings.value.browser.history.enabled);
  const retention = $derived(settings.value.browser.history.retentionDays);
  const synced = $derived(historySynced());
  const groups = $derived(groupByDay(visits, (v) => v.visitedAt));
  const searching = $derived(applied.trim().length > 0);

  let generation = 0;
  async function load(reset: boolean): Promise<void> {
    const gen = ++generation;
    const last = reset ? undefined : visits[visits.length - 1];
    const limit = reset ? Math.max(PAGE, Math.min(visits.length, 2000)) : PAGE;
    if (!reset) loadingMore = true;
    try {
      const [page, count] = await Promise.all([
        lib.history.query({ text: applied, before: last?.visitedAt, beforeId: last?.id, limit }),
        reset ? lib.history.count() : Promise.resolve(total),
      ]);
      if (gen !== generation) return;
      visits = reset ? page : [...visits, ...page];
      hasMore = page.length >= limit;
      total = count;
      failed = null;
      if (reset) for (const id of [...selected]) if (!page.some((v) => v.id === id)) selected.delete(id);
    } catch (err) {
      if (gen === generation) failed = errorText(err);
    } finally {
      if (gen === generation) {
        loading = false;
        loadingMore = false;
      }
    }
  }

  // Search as you type (debounced); the query string keeps the search across reloads and in Back/Forward.
  $effect(() => {
    const t = text;
    const timer = setTimeout(() => {
      if (t === applied) return;
      applied = t;
      const url = new URL(location.href);
      if (t.trim()) url.searchParams.set('q', t);
      else url.searchParams.delete('q');
      history.replaceState(history.state, '', url);
      void load(true);
    }, 160);
    return () => clearTimeout(timer);
  });

  onMount(() => {
    void load(true);
    let pending: ReturnType<typeof setTimeout> | null = null;
    const off = lib.history.onChange(() => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        void load(true);
      }, 120);
    });
    return () => {
      off();
      if (pending) clearTimeout(pending);
    };
  });

  // Infinite scroll: the next page loads when the end of the list comes near.
  $effect(() => {
    const el = sentinel;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !loadingMore) void load(false);
    }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  });

  function open(v: HistoryVisit, ev?: MouseEvent): void {
    if (ev && (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey)) return;
    ev?.preventDefault();
    void openUrl(v.url);
  }

  async function removeVisits(list: HistoryVisit[], message: string): Promise<void> {
    if (!list.length) return;
    try {
      await lib.history.remove(list.map((v) => v.id));
      for (const v of list) selected.delete(v.id);
      toast.show({
        title: message,
        kind: 'success',
        actions: [{ label: 'Undo', onClick: () => lib.history.restore(list) }],
      });
    } catch (err) {
      toast.error('Could not update history', { description: errorText(err) });
    }
  }

  async function removePage(v: HistoryVisit): Promise<void> {
    try {
      const all = await lib.history.visitsOf(v.url);
      await removeVisits(all, all.length === 1 ? 'Removed 1 visit' : `Removed ${formatNumber(all.length)} visits to this page`);
    } catch (err) {
      toast.error('Could not update history', { description: errorText(err) });
    }
  }

  async function bookmark(v: HistoryVisit): Promise<void> {
    try {
      const existing = await lib.bookmarks.byUrl(v.url);
      if (existing.length) {
        toast.info('Already bookmarked', { description: existing[0]!.title });
        return;
      }
      const b = await lib.bookmarks.add({ parentId: BOOKMARK_ROOT, kind: 'bookmark', title: v.title ?? hostname(v.url), url: v.url });
      toast.show({ title: 'Bookmark added', description: b.title, kind: 'success', actions: [{ label: 'Undo', onClick: () => lib.bookmarks.remove(b.id) }] });
    } catch (err) {
      toast.error('Could not add the bookmark', { description: errorText(err) });
    }
  }

  function menu(v: HistoryVisit): MenuItem[] {
    const host = hostname(v.url);
    return [
      { label: 'Open', icon: ExternalLink, onSelect: () => void openUrl(v.url) },
      { label: 'Open in new tab', icon: PanelTop, onSelect: () => void openUrl(v.url, { newTab: true }) },
      { label: 'Copy address', icon: Copy, onSelect: async () => ((await copyText(v.url)) ? toast.success('Address copied') : toast.error('Could not copy', { description: 'Clipboard access was denied by the browser.' })) },
      { label: 'Bookmark this page', icon: Bookmark, onSelect: () => void bookmark(v) },
      ...(host ? [{ label: `More from ${host}`, icon: Search, onSelect: () => (text = host) }] : []),
      { kind: 'separator' },
      { label: 'Remove this visit', icon: Trash2, danger: true, onSelect: () => void removeVisits([v], 'Removed 1 visit') },
      { label: 'Remove every visit to this page', icon: Trash2, danger: true, onSelect: () => void removePage(v) },
    ];
  }

  function toggle(id: string, on: boolean): void {
    if (on) selected.add(id);
    else selected.delete(id);
  }

  function toggleDay(items: HistoryVisit[], on: boolean): void {
    for (const v of items) toggle(v.id, on);
  }

  async function runClear(): Promise<void> {
    clearing = true;
    try {
      const from = rangeStart(clearRange);
      if (from === null) await lib.history.clear();
      else await lib.history.removeRange(from, Number.MAX_SAFE_INTEGER);
      const remote = from === null && synced && clearRemote;
      if (remote) {
        try {
          await clearSyncedHistory();
        } catch (err) {
          clearOpen = false;
          toast.error('Cleared in this browser only', {
            description: `The copy on your account could not be cleared: ${errorText(err)}`,
          });
          return;
        }
      }
      clearOpen = false;
      toast.success('History cleared', {
        description: remote ? 'Here and on your account. Your other devices remove it when they next sync.' : CLEAR_RANGES.find((r) => r.value === clearRange)?.label,
      });
    } catch (err) {
      toast.error('Could not clear history', { description: errorText(err) });
    } finally {
      clearing = false;
    }
  }

  const clearNote = $derived(
    !synced
      ? 'Removes visits from this browser.'
      : clearRange === 'all'
        ? 'Removes visits from this browser and, if you choose, from your account.'
        : 'Removes visits from this browser. The copy on your account is kept: only “All time” can clear it.',
  );

  const retentionText = $derived(retention > 0 ? `Visits are kept for ${retention} ${word(retention, 'day')}.` : 'Visits are kept until you remove them.');
</script>

<div class="page narrow library">
  <PageHeader title="History" description="Pages you visited in GNOME's browser. Kept only in this browser unless you turn on history sync.">
    {#snippet actions()}
      <Button variant="outline" icon={Trash2} onclick={() => (clearOpen = true)} disabled={!total}>Clear history…</Button>
    {/snippet}
  </PageHeader>

  <!-- While visits are selected the selection bar covers this row (and sticks under the chrome) instead of being
       inserted above the list: inserting it pushed every row down by its height, under the pointer, between the
       first and the second click on a checkbox. -->
  <div class="toolbar" class:selecting={selected.size > 0}>
    <SearchInput bind:value={text} label="Search history" placeholder="Search history" class="search" />
    <p class="summary" aria-live="polite">
      {#if total !== null}
        {#if searching}
          {formatNumber(visits.length)}{hasMore ? '+' : ''} {word(visits.length, 'match', 'matches')}
        {:else}
          {formatNumber(total)} {word(total, 'visit')}
        {/if}
      {/if}
    </p>
    {#if selected.size}
      <div class="selection" role="region" aria-label="Selected visits">
        <span class="count">{formatNumber(selected.size)} selected</span>
        <Button size="sm" variant="ghost" onclick={() => selected.clear()}>Cancel</Button>
        <Button size="sm" variant="danger" icon={Trash2} onclick={() => removeVisits(visits.filter((v) => selected.has(v.id)), selected.size === 1 ? 'Removed 1 visit' : `Removed ${formatNumber(selected.size)} visits`)}>
          Remove
        </Button>
      </div>
    {/if}
  </div>

  {#if !enabled}
    <Notice icon={HistoryIcon} title="History is off">
      New visits are not saved. What is listed here stays until you remove it.
      {#snippet actions()}
        <Button size="sm" variant="secondary" onclick={() => settings.set('browser', 'history', { ...settings.value.browser.history, enabled: true })}>Turn on</Button>
      {/snippet}
    </Notice>
  {:else if synced}
    <Notice icon={CloudCheck} title="Synced with your account">
      Visits from your other devices appear here. {retentionText}
    </Notice>
  {/if}

  {#if failed}
    <Notice icon={TriangleAlert} tone="danger" title="History is unavailable">
      {failed}
      {#snippet actions()}
        <Button size="sm" variant="secondary" onclick={() => load(true)}>Try again</Button>
      {/snippet}
    </Notice>
  {/if}

  {#if loading || visits.length || !failed}
  <div class="card">
    {#if loading}
      <div class="skeleton" aria-hidden="true">
        {#each [0, 1, 2, 3, 4, 5] as i (i)}<Skeleton height="44px" />{/each}
      </div>
    {:else if !visits.length && !failed}
      {#if searching}
        <EmptyState icon={Search} title="No matches" description={`Nothing in your history matches “${applied.trim()}”.`} />
      {:else}
        <EmptyState
          icon={HistoryIcon}
          title="No history yet"
          description={enabled ? 'Pages you open in the browser are listed here by day.' : 'Saving history is off.'}
        />
      {/if}
    {:else}
      <div class="days">
        {#each groups as g (g.key)}
          {@const all = g.items.every((v) => selected.has(v.id))}
          <section class="day" aria-labelledby="day-{g.key}">
            <header class="day-head">
              <input
                type="checkbox"
                class="pick"
                checked={all}
                indeterminate={!all && g.items.some((v) => selected.has(v.id))}
                aria-label="Select every visit of {g.label}"
                onchange={(e) => toggleDay(g.items, e.currentTarget.checked)}
              />
              <h2 id="day-{g.key}" class="eyebrow">{g.label}</h2>
            </header>
            <ul role="list">
              {#each g.items as v (v.id)}
                {@const title = v.title || hostname(v.url) || v.url}
                <li class="row" class:selected={selected.has(v.id)}>
                  <input type="checkbox" class="pick" checked={selected.has(v.id)} aria-label="Select {title}" onchange={(e) => toggle(v.id, e.currentTarget.checked)} />
                  <time class="time" datetime={new Date(v.visitedAt).toISOString()}>{formatClock(v.visitedAt)}</time>
                  <a class="main" href={browseLink(v.url)} onclick={(e) => open(v, e)} oncontextmenu={(e) => openContextMenu(e, menu(v), { label: title })}>
                    <SiteTile url={v.url} {title} size={28} />
                    <span class="text">
                      <span class="title">{title}</span>
                      <span class="url">{shortUrl(v.url)}</span>
                    </span>
                  </a>
                  <IconButton icon={Ellipsis} size="sm" label="Actions for {title}" tooltip={false} onclick={(e) => openContextMenu(e, menu(v), { label: title })} />
                </li>
              {/each}
            </ul>
          </section>
        {/each}
        {#if hasMore}
          <div class="more" bind:this={sentinel}>
            <Button variant="ghost" loading={loadingMore} onclick={() => load(false)}>Show older visits</Button>
          </div>
        {:else if !searching && visits.length > 20}
          <p class="end">{retentionText}</p>
        {/if}
      </div>
    {/if}
  </div>
  {/if}
</div>

<Dialog bind:open={clearOpen} title="Clear history" description={clearNote} size="sm">
  <RadioGroup label="Time range" value={clearRange} options={CLEAR_RANGES} onchange={(v) => (clearRange = v)} />
  {#if synced && clearRange === 'all'}
    <div class="remote">
      <Checkbox
        label="Also clear the copy on your account"
        description="History sync is on. Your other devices remove their copies the next time they sync."
        checked={clearRemote}
        onchange={(v) => (clearRemote = v)}
      />
    </div>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (clearOpen = false)}>Cancel</Button>
    <Button variant="danger" loading={clearing} onclick={runClear}>Clear history</Button>
  {/snippet}
</Dialog>

<style>
  .remote {
    margin-top: var(--space-4);
  }

  .library {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .toolbar {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-4);
    margin-top: var(--space-2);
  }

  .toolbar.selecting {
    position: sticky;
    top: var(--space-2);
    z-index: 3;
  }

  /* Hidden, not removed: the row keeps its height and the search keeps its text for when the selection ends. */
  .toolbar.selecting > :global(:not(.selection)) {
    visibility: hidden;
  }

  .toolbar :global(.search) {
    flex: 1;
    max-width: 560px;
  }

  .summary {
    margin: 0 0 0 auto;
    color: var(--text-3);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }

  /* The list sits in one glass card (DESIGN.md §12); rows are separated by hairlines. */
  .card {
    background: var(--glass-bg-card);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-xl);
    box-shadow: var(--glass-inset), var(--shadow-raise);
  }

  .selection {
    position: absolute;
    top: 50%;
    left: 0;
    right: 0;
    min-height: calc(100% + var(--space-2));
    transform: translateY(-50%);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 2px var(--space-1) 2px var(--space-4);
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-lg);
    background: var(--glass-bg-dense);
    -webkit-backdrop-filter: var(--glass-filter);
    backdrop-filter: var(--glass-filter);
    box-shadow: var(--shadow-pop);
  }

  .selection .count {
    margin-right: auto;
    font-size: 13px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .skeleton {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
  }

  .days {
    display: flex;
    flex-direction: column;
    padding-bottom: var(--space-2);
  }

  .day + .day {
    border-top: 1px solid var(--hairline);
  }

  .day-head {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-4) var(--space-2);
    background: var(--glass-bg-card);
  }

  .day:first-child .day-head {
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  }

  .day-head h2 {
    margin: 0;
  }

  ul {
    margin: 0;
    padding: 0 var(--space-2);
    list-style: none;
  }

  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 0 var(--space-2);
    border-radius: var(--radius);
    min-height: calc(var(--row-h) + 8px);
    transition: background-color var(--t-1) var(--ease-out);
  }

  .row + .row::before {
    content: '';
    position: absolute;
    top: 0;
    left: calc(var(--space-2) + 17px + var(--space-3));
    right: var(--space-2);
    height: 1px;
    background: var(--hairline);
  }

  .row:hover,
  .row:focus-within {
    background: var(--hover);
  }

  .row:hover::before,
  .row:focus-within::before,
  .row:hover + .row::before,
  .row:focus-within + .row::before,
  .row.selected::before,
  .row.selected + .row::before {
    opacity: 0;
  }

  .row.selected {
    background: var(--selected);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
  }

  .pick {
    width: 17px;
    height: 17px;
    margin: 0;
    flex: none;
    accent-color: var(--accent);
    opacity: 0.4;
    transition: opacity var(--t-1) var(--ease-out);
  }

  .row:hover .pick,
  .row:focus-within .pick,
  .pick:checked,
  .pick:indeterminate,
  .day-head:hover .pick,
  .pick:focus-visible {
    opacity: 1;
  }

  .time {
    flex: none;
    width: 5.4em;
    color: var(--text-3);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }

  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    color: inherit;
    text-decoration: none;
    border-radius: var(--radius-sm);
  }

  .main:focus-visible {
    outline-offset: 2px;
  }

  .text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .title,
  .url {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title {
    color: var(--text);
    font-size: 13.5px;
    font-weight: 500;
  }

  .url {
    color: var(--text-3);
    font-size: var(--text-sm);
  }

  .more,
  .end {
    display: flex;
    justify-content: center;
    padding: var(--space-4) 0 var(--space-2);
  }

  .end {
    margin: 0;
    color: var(--text-3);
    font-size: var(--text-sm);
  }

  @media (max-width: 759px) {
    .toolbar {
      flex-direction: column;
      align-items: stretch;
      gap: var(--space-2);
    }

    .toolbar :global(.search) {
      flex: none;
      max-width: none;
    }

    .summary {
      margin: 0;
    }

    .time {
      display: none;
    }

    .day-head {
      padding: var(--space-3) var(--space-3) var(--space-2);
    }

    ul {
      padding: 0 var(--space-1);
    }

    .pick {
      opacity: 1;
    }
  }

  @media (pointer: coarse) {
    .row {
      min-height: 52px;
    }

    .pick {
      opacity: 1;
    }
  }
</style>
