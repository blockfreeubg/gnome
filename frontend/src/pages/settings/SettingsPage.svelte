<!--
  Settings (/settings, /settings/:section). Desktop: sections sidebar with search + the section's rows. Phones: the
  sections list first, then one section per page under a sideways-scrolling row of section pills. Search filters rows across every section (registry.ts), highlights
  the matched words and keeps the controls working in the results. Deep links: /settings/<section>#<row id>.
-->
<script lang="ts">
  import { tick, type Component } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Cloud from '@lucide/svelte/icons/cloud';
  import Gamepad2 from '@lucide/svelte/icons/gamepad-2';
  import Gauge from '@lucide/svelte/icons/gauge';
  import Globe from '@lucide/svelte/icons/globe';
  import Keyboard from '@lucide/svelte/icons/keyboard';
  import Palette from '@lucide/svelte/icons/palette';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import SearchX from '@lucide/svelte/icons/search-x';
  import Shield from '@lucide/svelte/icons/shield';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import type { LucideIcon } from '@lucide/svelte';
  import Button from '../../components/Button.svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import Icon from '../../components/Icon.svelte';
  import SearchInput from '../../components/SearchInput.svelte';
  import { confirm } from '../../app/overlays/dialogs.svelte';
  import { toast } from '../../app/overlays/toast.svelte';
  import { router } from '../../app/router.svelte';
  import type { PageProps } from '../../app/routes';
  import { setSettingsSearch } from './ctx';
  import { pathsAreDefault, resetPaths } from './edit';
  import { FEATURE_NAMES } from '../../settings/features';
  import {
    activeRowsOf,
    isSectionId,
    matchRanges,
    queryTerms,
    rowsOf,
    searchSettings,
    SECTIONS,
    sectionDescription,
    sectionOf,
    type SectionId,
  } from './registry';
  import Account from './sections/Account.svelte';
  import Advanced from './sections/Advanced.svelte';
  import Appearance from './sections/Appearance.svelte';
  import Browser from './sections/Browser.svelte';
  import Extensions from './sections/Extensions.svelte';
  import Games from './sections/Games.svelte';
  import Performance from './sections/Performance.svelte';
  import Privacy from './sections/Privacy.svelte';
  import Shortcuts from './sections/Shortcuts.svelte';
  import Vpn from './sections/Vpn.svelte';

  let { params }: PageProps = $props();

  const VIEWS: Record<SectionId, Component> = {
    appearance: Appearance,
    browser: Browser,
    privacy: Privacy,
    performance: Performance,
    vpn: Vpn,
    games: Games,
    extensions: Extensions,
    shortcuts: Shortcuts,
    account: Account,
    advanced: Advanced,
  };
  const ICONS: Record<SectionId, LucideIcon> = {
    appearance: Palette,
    browser: Globe,
    privacy: Shield,
    performance: Gauge,
    vpn: ShieldCheck,
    games: Gamepad2,
    extensions: Puzzle,
    shortcuts: Keyboard,
    account: Cloud,
    advanced: SlidersHorizontal,
  };

  const narrow = new MediaQuery('max-width: 759px');

  let query = $state('');
  const terms = $derived(queryTerms(query));
  const hits = $derived(searchSettings(query));
  const matches = $derived(new Set(hits.map((h) => `${h.row.section}.${h.row.id}`)));
  const searching = $derived(terms.length > 0);
  const counts = $derived.by(() => {
    const c = new Map<SectionId, number>();
    for (const h of hits) c.set(h.row.section, (c.get(h.row.section) ?? 0) + 1);
    return c;
  });
  /** Sections with results, best hit first. */
  const resultSections = $derived([...new Set(hits.map((h) => h.row.section))]);

  setSettingsSearch({
    get active() {
      return searching;
    },
    get terms() {
      return terms;
    },
    get matches() {
      return matches;
    },
  });

  const requested = $derived(params.section ?? null);
  const unknownSection = $derived(requested !== null && !isSectionId(requested));
  const current = $derived<SectionId | null>(isSectionId(requested) ? requested : null);
  /** Desktop shows Appearance at /settings; phones show the sections list there. */
  const shown = $derived<SectionId | null>(current ?? (narrow.current ? null : 'appearance'));
  const View = $derived(shown ? VIEWS[shown] : null);
  const meta = $derived(shown ? sectionOf(shown) : null);
  /** Sections with at least one setting this build acts on (the others belong to features not present yet). */
  const listed = $derived(SECTIONS.filter((s) => activeRowsOf(s.id).length > 0));
  const activeRows = $derived(shown ? activeRowsOf(shown) : []);
  /** The feature a section without active rows waits for (its rows all name the same one). */
  const missingFeature = $derived(shown && !activeRows.length ? (rowsOf(shown).find((r) => r.needs)?.needs ?? null) : null);
  const sectionPaths = $derived(activeRows.flatMap((r) => r.paths));
  const sectionIsDefault = $derived(pathsAreDefault(sectionPaths));
  const showList = $derived(!narrow.current || (!current && !unknownSection));
  const showContent = $derived(!narrow.current || !!current || searching || unknownSection);

  async function resetSection(): Promise<void> {
    if (!meta) return;
    const ok = await confirm({
      title: `Reset ${meta.label.toLowerCase()} settings?`,
      message: `Every setting on this page goes back to its default.`,
      confirmLabel: 'Reset',
      danger: true,
    });
    if (!ok) return;
    resetPaths(sectionPaths);
    toast.success(`${meta.label} reset to defaults`);
  }

  // ── Search highlighting (CSS Custom Highlight API; no DOM changes, so controls are untouched) ──
  let contentEl = $state<HTMLElement>();
  const HIGHLIGHT = 'gnome-settings-search';

  function paintHighlights(root: HTMLElement | undefined, words: readonly string[]): void {
    const registry = typeof CSS !== 'undefined' ? (CSS as unknown as { highlights?: Map<string, unknown> }).highlights : undefined;
    const HighlightCtor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!registry || !HighlightCtor) return;
    if (!root || !words.length) {
      registry.delete(HIGHLIGHT);
      return;
    }
    const ranges: Range[] = [];
    for (const el of root.querySelectorAll('.setting-row .label, .setting-row .desc, .result-title')) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const [start, end] of matchRanges(node.textContent ?? '', words)) {
          const r = document.createRange();
          r.setStart(node, start);
          r.setEnd(node, end);
          ranges.push(r);
        }
      }
    }
    registry.set(HIGHLIGHT, new HighlightCtor(...ranges));
  }

  $effect(() => {
    const words = terms;
    const root = contentEl;
    void hits;
    void tick().then(() => paintHighlights(root, words));
  });
  $effect(() => () => paintHighlights(undefined, []));

  // ── Deep links: /settings/<section>#<row id> scrolls to the row and flashes it ──
  $effect(() => {
    const hash = router.current?.hash ?? '';
    void shown;
    if (!hash || hash.length < 2) return;
    let id = hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      /* raw */
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    void tick().then(() => {
      const el = document.getElementById(id);
      if (!el || !contentEl?.contains(el)) return;
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash');
      timer = setTimeout(() => el.classList.remove('flash'), 1600);
    });
    return () => clearTimeout(timer);
  });

  // ── Phones: the section pills scroll sideways; keep the current one in view (without moving the page) ──
  let pillsEl = $state<HTMLElement>();
  $effect(() => {
    const scroller = pillsEl;
    void current;
    if (!scroller) return;
    void tick().then(() => {
      const el = scroller.querySelector<HTMLElement>('[aria-current="page"]');
      if (!el) return;
      const box = scroller.getBoundingClientRect();
      const item = el.getBoundingClientRect();
      scroller.scrollLeft += item.left - box.left - (box.width - item.width) / 2;
    });
  });

  function onSearchKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && query) {
      ev.preventDefault();
      ev.stopPropagation();
      query = '';
    }
  }
</script>

<div class="settings page" class:mobile-section={narrow.current && !!current}>
  {#if narrow.current && current && meta}
    <header class="mobile-head">
      <a class="back" href="/settings"><ChevronLeft size={18} aria-hidden="true" />Settings</a>
      <nav class="pills" aria-label="Settings sections" bind:this={pillsEl}>
        <ul>
          {#each listed as s (s.id)}
            <li>
              <a href="/settings/{s.id}" class="pill" class:active={current === s.id} aria-current={current === s.id ? 'page' : undefined}>
                <Icon icon={ICONS[s.id]} size={15} />
                {s.label}
              </a>
            </li>
          {/each}
        </ul>
      </nav>
      <h1 class="title" tabindex="-1">{meta.label}</h1>
      <p class="sub">{sectionDescription(meta.id)}</p>
    </header>
  {:else if !showList}
    <header class="mobile-head">
      <h1 class="title" tabindex="-1">Settings</h1>
      <p class="sub">Saved in this browser as you change them.</p>
    </header>
  {/if}

  <div class="layout">
    {#if showList}
      <nav class="side" aria-label="Settings sections">
        <header class="side-head">
          <h1 class="title" tabindex="-1">Settings</h1>
          <p class="sub">Saved in this browser as you change them.</p>
        </header>
        <SearchInput bind:value={query} label="Search settings" placeholder="Search settings" onkeydown={onSearchKey} class="search" />
        {#if !narrow.current || !searching}
          <ul class="sections">
            {#each listed as s (s.id)}
              {@const count = counts.get(s.id) ?? 0}
              <li>
                <a
                  href="/settings/{s.id}"
                  class="section-link"
                  class:active={!searching && shown === s.id}
                  class:dim={searching && !count}
                  aria-current={!searching && shown === s.id ? 'page' : undefined}
                  onclick={() => (query = '')}
                >
                  <span class="tile" aria-hidden="true"><Icon icon={ICONS[s.id]} size={16} /></span>
                  <span class="text">
                    <span class="name">{s.label}</span>
                    {#if narrow.current}<span class="desc">{sectionDescription(s.id)}</span>{/if}
                  </span>
                  {#if searching && count}<span class="count tabular" aria-label="{count} results">{count}</span>{/if}
                  {#if narrow.current}<ChevronRight size={16} class="chev" aria-hidden="true" />{/if}
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </nav>
    {/if}

    {#if showContent}
      <section class="content" bind:this={contentEl} aria-label={searching ? 'Search results' : (meta?.label ?? 'Settings')}>
        {#if searching}
          <p class="result-summary" role="status">
            {hits.length ? `${hits.length} setting${hits.length === 1 ? ' matches' : 's match'} “${query.trim()}”` : ''}
          </p>
          {#if !hits.length}
            <div class="empty-card">
              <EmptyState icon={SearchX} title="No settings match “{query.trim()}”" description="Try another word, such as “dark”, “cookies” or “zoom”." size="sm">
                {#snippet actions()}
                  <Button size="sm" onclick={() => (query = '')}>Clear search</Button>
                {/snippet}
              </EmptyState>
            </div>
          {/if}
          {#each resultSections as id (id)}
            {@const ResultView = VIEWS[id]}
            <section class="result" aria-labelledby="result-{id}">
              <h2 class="result-head" id="result-{id}">
                <a href="/settings/{id}" onclick={() => (query = '')}>
                  <Icon icon={ICONS[id]} size={14} />
                  <span class="result-title">{sectionOf(id).label}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </a>
              </h2>
              <ResultView />
            </section>
          {/each}
        {:else if unknownSection}
          <div class="empty-card">
            <EmptyState icon={SearchX} title="There is no “{requested}” settings page" description="It may have moved. Pick a section, or search." size="sm">
              {#snippet actions()}
                <Button size="sm" href="/settings">All settings</Button>
              {/snippet}
            </EmptyState>
          </div>
        {:else if meta && missingFeature}
          {#if !narrow.current}
            <!-- Same header as every other section, so the page keeps its title while the feature is missing. -->
            <div class="section-head">
              <div>
                <h2 class="section-title">{meta.label}</h2>
                <p class="sub">{sectionDescription(meta.id)}</p>
              </div>
            </div>
          {/if}
          <div class="empty-card">
            <EmptyState
              icon={ICONS[meta.id]}
              title="{meta.label} settings are not available yet"
              description="They belong to {FEATURE_NAMES[missingFeature]}, which this version of GNOME does not include yet. They appear here once it does."
              size="sm"
            >
              {#snippet actions()}
                <Button size="sm" href="/settings">All settings</Button>
              {/snippet}
            </EmptyState>
          </div>
        {:else if View && meta}
          {#if !narrow.current}
            <div class="section-head">
              <div>
                <h2 class="section-title">{meta.label}</h2>
                <p class="sub">{sectionDescription(meta.id)}</p>
              </div>
              {#if sectionPaths.length}
                <Button size="sm" variant="ghost" icon={RotateCcw} disabled={sectionIsDefault} onclick={resetSection}>Reset section</Button>
              {/if}
            </div>
          {/if}
          {#key shown}
            <div class="rows"><View /></div>
          {/key}
          {#if narrow.current && sectionPaths.length}
            <div class="mobile-reset">
              <Button size="sm" variant="ghost" icon={RotateCcw} disabled={sectionIsDefault} onclick={resetSection}>Reset this section</Button>
            </div>
          {/if}
        {/if}
      </section>
    {/if}
  </div>
</div>

<style>
  /* novene-style settings (DESIGN.md §12): a navigation card on the left, the section's groups in glass cards. */
  .settings {
    max-width: calc(var(--page-max-narrow) + 2 * var(--page-pad-x));
    padding-top: var(--space-8);
  }

  .title {
    font-family: var(--font-display);
    font-variation-settings: var(--display-variation);
    font-weight: var(--weight-display);
    letter-spacing: var(--tracking-display);
    line-height: var(--lh-display);
    color: var(--text);
    outline: none;
  }

  .sub {
    font-size: 0.9286rem;
    color: var(--text-3);
    line-height: 1.45;
  }

  .mobile-head {
    margin-bottom: var(--space-5);
  }

  .mobile-head .title {
    font-size: var(--text-2xl);
  }

  .mobile-head .sub {
    margin-top: var(--space-1);
  }

  .back {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin: 0 0 var(--space-3) -6px;
    padding-right: var(--space-2);
    color: var(--text-2);
    font-size: var(--text-sm);
    font-weight: 500;
    text-decoration: none;
    min-height: 32px;
    border-radius: var(--radius);
  }

  .back:hover {
    color: var(--text);
  }

  /* Phones: the sections as a row of pills above the section (DESIGN.md §12); the row scrolls sideways. */
  .pills {
    margin: 0 calc(-1 * var(--page-pad-x)) var(--space-5);
    padding: 3px var(--page-pad-x);
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
    mask-image: linear-gradient(90deg, transparent 0, #000 var(--page-pad-x), #000 calc(100% - var(--page-pad-x)), transparent 100%);
  }

  .pills::-webkit-scrollbar {
    display: none;
  }

  .pills ul {
    display: flex;
    gap: var(--space-2);
    width: max-content;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 36px;
    padding: 0 14px 0 12px;
    border-radius: var(--radius-pill);
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--hairline);
    color: var(--text-2);
    font-size: 0.9286rem;
    font-weight: 500;
    white-space: nowrap;
    text-decoration: none;
    transition:
      color var(--t-1) var(--ease-out),
      background-color var(--t-1) var(--ease-out),
      box-shadow var(--t-1) var(--ease-out);
  }

  .pill :global(svg) {
    flex: none;
    color: var(--text-3);
  }

  .pill:hover {
    color: var(--text);
    background: var(--surface-2);
  }

  .pill.active {
    color: var(--text);
    background: var(--selected);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
  }

  .pill.active :global(svg) {
    color: var(--text);
  }

  .pill:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }

  @media (pointer: coarse) {
    .pill {
      min-height: 40px;
    }
  }

  .layout {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    gap: var(--space-8);
    align-items: start;
  }

  /* ── Navigation card ── */
  .side {
    position: sticky;
    top: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-3) var(--space-3);
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-lg);
    box-shadow: var(--glass-inset), var(--shadow-raise);
  }

  .side-head {
    padding: 0 var(--space-2) var(--space-1);
  }

  .side-head .title {
    font-size: var(--text-xl);
  }

  .side-head .sub {
    margin-top: 3px;
    font-size: var(--text-sm);
  }

  .sections {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .section-link {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: calc(36px * var(--density));
    padding: 0 var(--space-3) 0 var(--space-2);
    border-radius: var(--radius);
    color: var(--text-2);
    font-size: 0.9286rem;
    text-decoration: none;
    transition:
      color var(--t-1) var(--ease-out),
      background-color var(--t-1) var(--ease-out),
      box-shadow var(--t-1) var(--ease-out);
  }

  .tile {
    display: grid;
    place-items: center;
    flex: none;
    width: 22px;
    height: 22px;
    color: var(--text-3);
    transition: color var(--t-1) var(--ease-out);
  }

  .section-link:hover {
    color: var(--text);
    background: var(--hover);
  }

  .section-link:hover .tile {
    color: var(--text-2);
  }

  .section-link.active {
    color: var(--text);
    background: var(--selected);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
  }

  .section-link.active .tile {
    color: var(--text);
  }

  .section-link.dim {
    opacity: 0.5;
  }

  .text {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }

  .name {
    font-weight: 500;
  }

  .count {
    font-size: var(--text-xs);
    font-weight: 700;
    color: var(--accent-ink);
    background: var(--accent);
    border-radius: var(--radius-pill);
    min-width: 20px;
    padding: 1px 7px;
    text-align: center;
  }

  /* ── Content ── */
  .content {
    min-width: 0;
  }

  .section-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-1) 0 0;
    margin-bottom: var(--space-6);
  }

  .section-title {
    font-family: var(--font-display);
    font-variation-settings: var(--display-variation);
    font-weight: var(--weight-display);
    font-size: var(--text-2xl);
    letter-spacing: var(--tracking-display);
    line-height: var(--lh-display);
  }

  .section-head .sub {
    margin-top: var(--space-1);
  }

  .result-summary {
    font-size: var(--text-sm);
    color: var(--text-3);
    margin: var(--space-1) 0 var(--space-5);
  }

  .result-summary:empty {
    display: none;
  }

  .result + .result {
    margin-top: var(--space-8);
  }

  .result-head {
    margin: 0 0 var(--space-2) var(--space-1);
    font-size: inherit;
  }

  .result-head a {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 24px;
    color: var(--text-3);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: var(--tracking-eyebrow);
    text-transform: uppercase;
    text-decoration: none;
    border-radius: var(--radius-sm);
  }

  .result-head a:hover {
    color: var(--text);
  }

  .empty-card {
    padding: var(--space-6) var(--space-4);
    background: var(--glass-bg-card);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-xl);
    box-shadow: var(--glass-inset), var(--shadow-raise);
  }

  .mobile-reset {
    margin-top: var(--space-6);
  }

  :global(::highlight(gnome-settings-search)) {
    background-color: var(--accent-soft);
    color: var(--accent-strong);
  }

  /* ── Phones: the sections list is the page; one section per page after that ── */
  @media (max-width: 759px) {
    .settings {
      padding-top: var(--space-5);
    }

    .layout {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-5);
    }

    .side {
      position: static;
      padding: 0;
      gap: var(--space-4);
      background: none;
      border: 0;
      box-shadow: none;
    }

    .side-head {
      padding: 0;
    }

    .side-head .title {
      font-size: var(--text-2xl);
    }

    .sections {
      gap: 0;
      padding: 0 var(--space-3);
      background: var(--glass-bg-card);
      border: 1px solid var(--hairline);
      border-radius: var(--radius-lg);
      box-shadow: var(--glass-inset), var(--shadow-raise);
    }

    .sections li + li {
      border-top: 1px solid var(--hairline);
    }

    .section-link {
      min-height: 60px;
      padding: var(--space-2) 0;
      border-radius: 0;
      color: var(--text);
      font-size: var(--text-md);
    }

    .section-link:hover {
      background: none;
    }

    .tile {
      width: 32px;
      height: 32px;
      border-radius: var(--radius);
      background: var(--selected);
      box-shadow: inset 0 0 0 1px var(--selected-ring);
      color: var(--text);
    }

    .desc {
      font-size: var(--text-sm);
      color: var(--text-3);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .section-link :global(.chev) {
      color: var(--text-3);
      flex: none;
    }
  }
</style>
