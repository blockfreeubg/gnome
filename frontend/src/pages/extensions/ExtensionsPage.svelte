<!--
  Extensions (WAVE-B3 §7.1): GNOME's five built-in extensions (first-party, part of GNOME's browser; nothing to
  install). Overview (a switch, one honest sentence, the state and this session's counts per extension), Filter lists
  (the server's listing with license, publisher, size, update time, on/off and whether each was compiled), Site rules
  (the Settings editors), Cookies (the cookie manager), Status (what the engine host compiled and caches) and How
  blocking works (what it does and does not do, §11 in plain words).

  Live data (counts, compiled lists, cookies, cache) comes from the engine host and needs the browser to run; before
  that the page shows the settings, which apply when it starts. Every text about the blocker's state is GNOME's own
  sentence for a code (error-copy.ts); list names come from GNOME's own `/api/filters` listing. Shown only once the
  built-in extensions are registered (registerFeature('extensions')): otherwise an honest empty state.
-->
<script lang="ts">
  import Ban from '@lucide/svelte/icons/ban';
  import BookOpen from '@lucide/svelte/icons/book-open';
  import Cookie from '@lucide/svelte/icons/cookie';
  import Eraser from '@lucide/svelte/icons/eraser';
  import EyeOff from '@lucide/svelte/icons/eye-off';
  import Gauge from '@lucide/svelte/icons/gauge';
  import ListFilter from '@lucide/svelte/icons/list-filter';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import Radar from '@lucide/svelte/icons/radar';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Settings2 from '@lucide/svelte/icons/settings-2';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Globe from '@lucide/svelte/icons/globe';
  import type { LucideIcon } from '@lucide/svelte';
  import { tick } from 'svelte';
  import Button from '../../components/Button.svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import Icon from '../../components/Icon.svelte';
  import PageHeader from '../../components/PageHeader.svelte';
  import Switch from '../../components/Switch.svelte';
  import Tabs from '../../components/Tabs.svelte';
  import { toast } from '../../app/overlays/toast.svelte';
  import { router } from '../../app/router.svelte';
  import type { PageProps } from '../../app/routes';
  import { browser } from '../../browser/browser.svelte';
  import { BLOCK_CATEGORY_LABELS, blockerStateCopy } from '../../browser/ui/error-copy';
  import { siteOf } from '../../extensions/core/site';
  import { BLOCKER_CATEGORIES, sumCounts, type CategoryCounts } from '../../extensions/app/stats.svelte';
  import CookieManager from '../../extensions/app/ui/CookieManager.svelte';
  import FilterLists from '../../extensions/app/ui/FilterLists.svelte';
  import SiteRules from '../../extensions/app/ui/SiteRules.svelte';
  import { formatBytes, formatDateTime, formatRelativeTime } from '../../lib/format';
  import { isFeatureActive } from '../../settings/features';
  import type { Settings } from '../../settings/schema';
  import { settings } from '../../settings/store.svelte';
  import type { BlockCategory, BlockerGroup } from '../../shared/engine-protocol';

  let {}: PageProps = $props();

  type TabId = 'overview' | 'lists' | 'rules' | 'cookies' | 'status' | 'how';
  const TABS: ReadonlyArray<{ id: TabId; label: string; icon: LucideIcon }> = [
    { id: 'overview', label: 'Overview', icon: Puzzle },
    { id: 'lists', label: 'Filter lists', icon: ListFilter },
    { id: 'rules', label: 'Site rules', icon: Globe },
    { id: 'cookies', label: 'Cookies', icon: Cookie },
    { id: 'status', label: 'Status', icon: Gauge },
    { id: 'how', label: 'How blocking works', icon: BookOpen },
  ];
  const fromHash = (h: string): TabId => (TABS.find((t) => `#${t.id}` === h)?.id ?? 'overview');
  let tab = $state<TabId>(fromHash(router.current?.hash ?? ''));
  // A link to /extensions#<tab> (the shield, Settings) selects that tab, also while the page is open.
  $effect(() => {
    const h = router.current?.hash ?? '';
    if (h) tab = fromHash(h);
  });

  // On a narrow screen the tab row scrolls sideways: keep the selected tab (also one picked through a link) in view.
  $effect(() => {
    void tab;
    void tick().then(() => document.querySelector('.ext-tabs [role="tab"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  });

  const feature = $derived(isFeatureActive('extensions'));
  const ext = $derived(settings.value.extensions);
  const running = $derived(browser.engineState === 'ready' || browser.engineState === 'unresponsive');
  const blockerLive = $derived(running && browser.hasCapability('blocker'));
  const status = $derived(browser.status?.blocker ?? null);
  const stateCopy = $derived(blockerLive && status ? blockerStateCopy(status) : null);
  const stats = $derived(browser.blockerStats);
  const totals = $derived(browser.blockStats.totals);
  const openUrls = $derived(browser.tabs.map((t) => t.url).filter((u): u is string => !!u));
  const sites = $derived(browser.blockStats.sitesOf(openUrls, siteOf));

  type Key = keyof Settings['extensions']['enabled'];
  interface Ext {
    key: Key;
    name: string;
    icon: LucideIcon;
    text: string;
    /** The categories whose session counts belong to it, and what a count is ("67 blocked this session"; cosmetic filtering: requests its cookie-notice and annoyance lists blocked, hiding is not counted). */
    counts: readonly BlockCategory[];
    counted?: string;
    /** Uses filter lists (its state is the blocker's). */
    lists: boolean;
  }
  const EXTENSIONS: readonly Ext[] = [
    { key: 'adblock', name: 'Ad blocker', icon: Ban, text: 'Blocks requests to ad servers, and pages on the scam and malware list, on sites you open in GNOME.', counts: ['ads', 'security'], counted: 'blocked', lists: true },
    { key: 'trackers', name: 'Tracker blocker', icon: Radar, text: 'Blocks requests to tracking and analytics servers on sites you open in GNOME.', counts: ['trackers'], counted: 'blocked', lists: true },
    { key: 'privacy', name: 'Privacy protection', icon: EyeOff, text: 'Sends Global Privacy Control, cuts what the Referer header tells other sites, and removes tracking parameters from pages you open, as set under Settings → Privacy.', counts: ['urlparams'], counted: 'pages cleaned', lists: false },
    { key: 'cookies', name: 'Cookie manager', icon: Cookie, text: 'Applies the cookie setting under Settings → Privacy and your cookie rules to sites opened in GNOME.', counts: [], lists: false },
    { key: 'cosmetic', name: 'Cosmetic filtering', icon: Eraser, text: 'Hides ad frames and page clutter, and applies cookie-notice and annoyance lists.', counts: ['cookies', 'annoyances'], counted: 'blocked', lists: true },
  ];

  const GROUP_LABELS: Record<BlockerGroup, string> = {
    ads: 'Ads',
    security: 'Scam and malware sites',
    trackers: 'Trackers',
    params: 'Tracking parameters',
    cookies: 'Cookie notices',
    annoyances: 'Annoyances',
  };

  function setEnabled(k: Key, v: boolean): void {
    settings.set('extensions', 'enabled', { ...ext.enabled, [k]: v });
  }

  function countOf(c: CategoryCounts, cats: readonly BlockCategory[]): number {
    return cats.reduce((n, k) => n + (c[k] ?? 0), 0);
  }

  function extState(e: Ext): string {
    if (!ext.enabled[e.key]) return 'Off';
    if (!e.lists) return 'On';
    if (!stateCopy) return 'On';
    return stateCopy.label === 'Ready' ? 'On' : stateCopy.label;
  }

  // Opening the page refreshes the listing (with auto-update on) and the engine host's stats.
  $effect(() => {
    if (!feature) return;
    void browser.filterListing.refresh('page');
  });
  $effect(() => {
    void status?.state;
    void status?.lists;
    if (blockerLive) void browser.refreshBlockerStats();
  });

  let rebuilding = $state(false);
  async function rebuild(): Promise<void> {
    rebuilding = true;
    try {
      await browser.rebuildFilters();
      toast.info('Rebuilding filter data', { description: 'The current filter data stays in use until the new one is ready.' });
    } catch {
      toast.error('Could not rebuild the filter data', { description: 'The browser engine did not answer.' });
    } finally {
      rebuilding = false;
    }
  }
</script>

<div class="page narrow">
  <PageHeader title="Extensions" description="Built-in content blocking for sites you open in GNOME’s browser. Part of GNOME: nothing to install." />

  {#if !feature}
    <div class="card">
      <EmptyState
        icon={Puzzle}
        title="Not available in this build"
        description="This GNOME server’s browser engine does not run the built-in content blocker yet, so there is nothing to switch on here."
      />
    </div>
  {:else}
    {#if browser.siteRulesPaused}
      <p class="banner warn" role="status"><Icon icon={TriangleAlert} size={16} /> Site rules are paused on this page: GNOME noticed tampering in its browser engine. Reload GNOME to resume them.</p>
    {/if}
    {#if !running}
      <p class="banner" data-ext-offline>These settings apply when GNOME’s browser starts. Live data (what was blocked, which filter lists are in use, cookies) appears once the browser is open.</p>
    {/if}

    {#if stateCopy?.text}
      <p class="banner" class:warn={stateCopy.tone === 'warn'} class:error={stateCopy.tone === 'error'} role="status" data-blocker-text>{stateCopy.text}</p>
    {/if}

    <Tabs tabs={TABS} bind:value={tab} label="Extensions" class="ext-tabs">
      {#snippet panel(id)}
        {#if id === 'overview'}
          <div class="grid">
            {#each EXTENSIONS as e (e.key)}
              <article class="card ext" data-extension={e.key}>
                <span class="tile"><Icon icon={e.icon} size={16} /></span>
                <div class="ext-body">
                  <h2 class="ext-name">{e.name}</h2>
                  <p class="ext-text">{e.text}</p>
                  <p class="ext-meta">
                    <span class="state" class:off={!ext.enabled[e.key]} class:busy={extState(e) === 'Preparing'} class:error={extState(e) === 'Problem'}>{extState(e)}</span>
                    {#if e.counts.length && blockerLive}
                      <span> · {countOf(totals, e.counts)} {e.counted} this session</span>
                    {/if}
                    {#if e.key === 'cookies'}
                      <span> · {Object.keys(ext.cookieRules).length} cookie rules</span>
                    {/if}
                  </p>
                </div>
                <Switch aria-label={e.name} checked={ext.enabled[e.key]} onchange={(v) => setEnabled(e.key, v)} />
              </article>
            {/each}
          </div>

          <section class="card pad" aria-labelledby="session-title">
            <h2 id="session-title" class="eyebrow">This session</h2>
            {#if !blockerLive}
              <p class="muted">Counts appear once the browser is open.</p>
            {:else if sumCounts(totals) === 0}
              <p class="muted">Nothing blocked yet since GNOME opened.</p>
            {:else}
              <ul class="kv">
                {#each BLOCKER_CATEGORIES.filter((c) => (totals[c] ?? 0) > 0) as c (c)}
                  <li><span>{BLOCK_CATEGORY_LABELS[c]}</span><span class="n">{totals[c]}</span></li>
                {/each}
              </ul>
              {#if sites.length}
                <h3 class="eyebrow sub">By site of your open tabs</h3>
                <ul class="kv">
                  {#each sites as s (s.site)}
                    <li><span class="mono">{s.site}</span><span class="n">{sumCounts(s.counts)}</span></li>
                  {/each}
                </ul>
              {/if}
            {/if}
            <p class="hint">Counted while GNOME is open; nothing is stored.</p>
          </section>
        {:else if id === 'lists'}
          <section class="card pad">
            <div class="head-row">
              <p class="muted">Filter lists are mirrored from their publishers by this server; each keeps its own license.</p>
              {#if blockerLive}
                <Button size="sm" variant="outline" icon={RefreshCw} loading={rebuilding} onclick={() => void rebuild()}>Rebuild filter data</Button>
              {/if}
            </div>
            <FilterLists {stats} />
          </section>
        {:else if id === 'rules'}
          <section class="card pad rules">
            <SiteRules />
          </section>
        {:else if id === 'cookies'}
          <section class="card pad">
            <CookieManager />
          </section>
        {:else if id === 'status'}
          <section class="card pad" data-blocker-status>
            {#if !blockerLive}
              <p class="muted">The content blocker runs inside GNOME’s browser: its state appears once the browser is open.</p>
            {:else}
              <ul class="kv">
                <li><span>State</span><span>{stateCopy?.label ?? '—'}{stateCopy?.text ? ` · ${stateCopy.text}` : ''}</span></li>
                <li><span>Filter lists in use</span><span class="n">{status?.lists ?? 0}</span></li>
                {#if stats}
                  <li><span>Filter engine</span><span>Ghostery adblocker (engine format {stats.engineVersion})</span></li>
                  <li><span>Filter data built</span><span>{stats.builtAt === null ? 'Not yet' : `${formatDateTime(stats.builtAt)} (${formatRelativeTime(stats.builtAt)})`}</span></li>
                  <li><span>Loaded from</span><span>{stats.source === 'cache' ? 'This browser’s cache' : stats.source === 'build' ? `A build in this browser${stats.buildMs !== null ? ` (${(stats.buildMs / 1000).toFixed(1)} s)` : ''}` : '—'}</span></li>
                  <li><span>Cache</span><span>{formatBytes(stats.cache.bytes)} of {formatBytes(stats.cache.limitBytes)} · {stats.cache.entries} entries</span></li>
                  {#if stats.resources}
                    <li><span>Redirect resources and scriptlets</span><span class="n">{stats.resources.redirects} · {stats.resources.scriptlets}</span></li>
                  {/if}
                {/if}
              </ul>
              {#if stats?.engines.length}
                <h3 class="eyebrow sub">Filter data per group</h3>
                <ul class="kv">
                  {#each stats.engines as g (g.group)}
                    <li><span>{GROUP_LABELS[g.group]}</span><span class="n">{formatBytes(g.bytes)} · {g.network.toLocaleString()} network · {g.cosmetic.toLocaleString()} hiding · {g.scriptlets.toLocaleString()} scriptlet rules</span></li>
                  {/each}
                </ul>
              {/if}
              <div class="head-row">
                <Button size="sm" variant="ghost" icon={RefreshCw} onclick={() => void browser.refreshBlockerStats()}>Refresh</Button>
                <Button size="sm" variant="ghost" icon={Settings2} href="/settings/performance#cacheLimitMB">Cache limit</Button>
              </div>
            {/if}
          </section>
        {:else}
          <section class="card pad prose" data-how-blocking-works>
            <h2 class="eyebrow">What it does</h2>
            <p>GNOME’s content blocker runs inside GNOME’s own browser, on the sites you open there. It blocks requests to ad and tracker servers named by the filter lists you turn on, hides ad frames and page clutter, sends Global Privacy Control, trims the Referer header and removes tracking parameters from pages you open, and applies your cookie setting and cookie rules. It does nothing outside GNOME’s browser.</p>
            <h2 class="eyebrow">What it does not do</h2>
            <ul>
              <li>It cannot stop a site that targets GNOME. Every site opened in GNOME runs inside one shared browser engine, and a site built to break out of it can turn blocking off and read the site rules of the sites you have open and all of your cookie rules.</li>
              <li>A site can see that it is being filtered, and can undo the hiding and scripts on its own pages. Network blocking, privacy headers and cookie rules are decided outside the page.</li>
              <li>Tracking parameters are removed from pages you open, not from requests inside them. Cookies on WebSocket connections are not controlled, and storage of third-party frames is not partitioned.</li>
              <li>Workers and blank frames get the Global Privacy Control header but not <span class="mono">navigator.globalPrivacyControl</span>. Requests whose page GNOME cannot tell are treated as third-party under your global settings.</li>
              <li>Not supported: procedural cosmetic filters, HTML filtering, the <span class="mono">$csp</span>, <span class="mono">$popup</span>, <span class="mono">$urlskip</span>, <span class="mono">$header</span>, <span class="mono">$cookie</span> and <span class="mono">$removeheader</span> rules, <span class="mono">$removeparam</span> rules written as regular expressions, and custom filters of your own.</li>
            </ul>
            <h2 class="eyebrow">What travels to the browser engine</h2>
            <p>The engine gets the filter lists (public), your allowed sites and per-site rules only for the sites it shows or is about to load, all of your cookie rules while the cookie manager is on, and a key that protects its cached filter data. Besides these it gets only the browser settings it applies itself; never your history, bookmarks or account.</p>
          </section>
        {/if}
      {/snippet}
    </Tabs>
  {/if}
</div>

<style>
  .card {
    background: var(--glass-bg-card);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-xl);
    box-shadow: var(--glass-inset), var(--shadow-raise);
  }

  .page > .card {
    margin-top: var(--space-6);
  }

  .pad {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5) var(--space-6);
    margin-top: var(--space-4);
  }

  :global(.ext-tabs) {
    margin-top: var(--space-5);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr));
    gap: var(--space-3);
    margin-top: var(--space-4);
  }

  .ext {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-4) var(--space-4) var(--space-4);
  }

  .tile {
    display: grid;
    place-items: center;
    flex: none;
    width: 32px;
    height: 32px;
    border-radius: var(--radius);
    background: var(--selected);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
    color: var(--text);
  }

  .ext-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .ext-name {
    font-family: var(--font-ui);
    font-size: var(--text-md);
    font-weight: 600;
    letter-spacing: 0;
    color: var(--text);
  }

  .ext-text {
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--text-2);
  }

  .ext-meta {
    font-size: var(--text-xs);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }

  .state {
    color: var(--success);
    font-weight: 600;
  }

  .state.off {
    color: var(--text-3);
  }

  .state.busy {
    color: var(--warning);
  }

  .state.error {
    color: var(--danger);
  }

  .banner {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-4);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-lg);
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    font-size: var(--text-sm);
    color: var(--text-2);
  }

  .banner.warn {
    color: var(--warning);
    background: var(--warning-soft);
  }

  .banner.error {
    color: var(--danger);
    background: var(--danger-soft);
  }

  .muted,
  .hint {
    font-size: var(--text-sm);
    color: var(--text-3);
  }

  .hint {
    font-size: var(--text-xs);
  }

  .sub {
    margin-top: var(--space-2);
  }

  .kv {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
  }

  .kv li {
    display: flex;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-2) var(--space-4);
    font-size: var(--text-sm);
    color: var(--text-2);
  }

  .kv li > :last-child {
    text-align: right;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .kv li + li {
    border-top: 1px solid var(--hairline);
  }

  .n {
    font-variant-numeric: tabular-nums;
  }

  .head-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .rules {
    padding-top: var(--space-2);
    padding-bottom: var(--space-2);
  }

  .prose p,
  .prose li {
    font-size: var(--text-sm);
    line-height: 1.65;
    color: var(--text-2);
  }

  .prose ul {
    margin: 0;
    padding-left: 1.2em;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .prose h2 {
    margin-top: var(--space-2);
  }

  @media (max-width: 759px) {
    .pad {
      padding: var(--space-4);
    }

    .page > .card {
      margin-top: var(--space-4);
    }
  }
</style>
