<!--
  Home search / address box. Suggestions: the primary action (open address / search / GNOME page), then matching
  bookmarks and history (from IndexedDB, filtered in memory). Enter opens through the BrowserBridge;
  Alt+Enter opens in a new tab.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
  import Bookmark from '@lucide/svelte/icons/bookmark';
  import Clock from '@lucide/svelte/icons/clock';
  import Globe from '@lucide/svelte/icons/globe';
  import LayoutGrid from '@lucide/svelte/icons/layout-grid';
  import Search from '@lucide/svelte/icons/search';
  import Combobox, { type ComboboxModifiers } from '../../components/Combobox.svelte';
  import Icon from '../../components/Icon.svelte';
  import Kbd from '../../components/Kbd.svelte';
  import { register } from '../../app/shortcuts';
  import { openInput, openUrl } from '../../browser/bridge';
  import { isCoarsePointer } from '../../lib/platform';
  import { displayUrl, parseOmnibox } from '../../lib/url';
  import { SEARCH_ENGINES } from '../../settings/defaults';
  import { settings } from '../../settings/store.svelte';
  import { loadSuggestionIndex, suggest, type SiteEntry, type SuggestionIndex } from './data';

  type Option =
    | { key: string; kind: 'primary'; mode: 'url' | 'search' | 'internal'; title: string; detail: string }
    | { key: string; kind: 'site'; source: 'history' | 'bookmark'; entry: SiteEntry };

  let value = $state('');
  let open = $state(false);
  let input = $state<HTMLInputElement>();
  let index = $state.raw<SuggestionIndex | null>(null);
  let loadingIndex: Promise<void> | null = null;

  const search = $derived(settings.value.browser);
  const engineLabel = $derived(search.searchEngine === 'custom' ? 'your search engine' : SEARCH_ENGINES[search.searchEngine].label);

  const options = $derived.by((): Option[] => {
    const q = value.trim();
    if (!q) return [];
    const out: Option[] = [];
    const r = parseOmnibox(q, { searchEngine: search.searchEngine, customSearchUrl: search.customSearchUrl });
    if (r) {
      if (r.kind === 'url') out.push({ key: 'primary', kind: 'primary', mode: 'url', title: displayUrl(r.href), detail: 'Open address' });
      else if (r.kind === 'internal') out.push({ key: 'primary', kind: 'primary', mode: 'internal', title: q, detail: 'Open GNOME page' });
      else out.push({ key: 'primary', kind: 'primary', mode: 'search', title: q, detail: `Search ${engineLabel}` });
    }
    if (index) {
      const s = suggest(index, q, 5);
      for (const b of s.bookmarks) out.push({ key: b.key, kind: 'site', source: 'bookmark', entry: b });
      for (const h of s.history) out.push({ key: h.key, kind: 'site', source: 'history', entry: h });
    }
    return out;
  });

  function ensureIndex(): void {
    if (index && Date.now() - index.loadedAt < 30_000) return;
    loadingIndex ??= loadSuggestionIndex()
      .then((i) => {
        index = i;
      })
      .finally(() => {
        loadingIndex = null;
      });
  }

  function select(opt: Option, mods: ComboboxModifiers): void {
    const newTab = mods.altKey;
    if (opt.kind === 'primary') openInput(value, { newTab });
    else void openUrl(opt.entry.url, { newTab });
    value = '';
    open = false;
  }

  function submit(text: string, mods: ComboboxModifiers): void {
    if (!text.trim()) return;
    openInput(text, { newTab: mods.altKey });
    value = '';
  }

  function groupOf(opt: Option): string | undefined {
    if (opt.kind === 'primary') return undefined;
    return opt.source === 'bookmark' ? 'Bookmarks' : 'History';
  }

  onMount(() => {
    const off = register('focusOmnibox', () => {
      input?.focus();
      input?.select();
    });
    // Focus the box on load like a new-tab page, unless something else already has focus or on touch screens.
    if (input && document.activeElement === document.body && !isCoarsePointer()) input.focus({ preventScroll: true });
    return off;
  });
</script>

{#snippet optionView(opt: Option, state: { active: boolean })}
  {#if opt.kind === 'primary'}
    <span class="opt-icon primary" class:active={state.active}>
      <Icon icon={opt.mode === 'url' ? Globe : opt.mode === 'internal' ? LayoutGrid : Search} size={16} />
    </span>
    <span class="opt-text">
      <span class="opt-title">{opt.title}</span>
    </span>
    <span class="opt-detail">{opt.detail}</span>
  {:else}
    <span class="opt-icon"><Icon icon={opt.source === 'bookmark' ? Bookmark : Clock} size={15} /></span>
    <span class="opt-text">
      <span class="opt-title">{opt.entry.title}</span>
      <span class="opt-url mono">{displayUrl(opt.entry.url)}</span>
    </span>
    {#if state.active}<span class="opt-go"><Icon icon={ArrowUpRight} size={15} /></span>{/if}
  {/if}
{/snippet}

<div class="home-search">
  <Combobox
    bind:value
    bind:open
    bind:element={input}
    {options}
    getKey={(o) => o.key}
    getLabel={(o) => (o.kind === 'primary' ? o.title : o.entry.title)}
    getGroup={groupOf}
    option={optionView}
    onselect={select}
    onsubmit={submit}
    autoActivateFirst
    size="xl"
    icon={Search}
    label="Search or enter address"
    placeholder="Search or enter an address"
    enterkeyhint="go"
    onfocus={ensureIndex}
    oninput={ensureIndex}
  >
    {#snippet trailing()}
      {#if !value}<Kbd action="focusOmnibox" class="hint" />{/if}
    {/snippet}
  </Combobox>
</div>

<style>
  .home-search {
    width: 100%;
  }

  /* The Alt+L hint means nothing on touch screens and crowds the field on phones. */
  @media (max-width: 759px), (pointer: coarse) {
    .home-search :global(.hint) {
      display: none;
    }
  }

  /* A rounded translucent pill over the backdrop (DESIGN.md §9.3). */
  .home-search :global(.combobox) {
    --h: 48px;
    gap: 12px;
    padding: 0 16px 0 18px;
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-pill);
    /* Home raises --home-pill over a backdrop the user supplied, so the placeholder keeps its contrast. */
    background: color-mix(in oklab, var(--bg) var(--home-pill, 62%), transparent);
    -webkit-backdrop-filter: blur(14px) saturate(1.2);
    backdrop-filter: blur(14px) saturate(1.2);
    box-shadow:
      var(--glass-inset),
      0 18px 50px -24px rgba(0, 0, 0, 0.6);
    font-size: 0.9643rem;
  }

  .home-search :global(.combobox .lead) {
    color: var(--text-3);
  }

  .home-search :global(.combobox .lead svg) {
    width: 17px;
    height: 17px;
  }

  .home-search :global(.combobox:hover) {
    border-color: color-mix(in oklab, var(--text) 24%, transparent);
    background: color-mix(in oklab, var(--bg) max(var(--home-pill, 62%), 70%), transparent);
  }

  .home-search :global(.combobox:focus-within) {
    border-color: var(--focus-border);
    background: color-mix(in oklab, var(--bg) max(var(--home-pill, 62%), 80%), transparent);
    box-shadow:
      0 0 0 3px var(--focus-halo),
      0 18px 50px -24px rgba(0, 0, 0, 0.6);
  }

  .home-search :global(.combobox input::placeholder) {
    color: var(--text-3);
  }

  /* Without blur (reduce transparency, GPU effects off) the pill is opaque so the placeholder keeps its contrast. */
  :global(.reduce-transparency) .home-search :global(.combobox),
  :global(.no-gpu-effects) .home-search :global(.combobox) {
    background: var(--surface-1);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }

  .opt-icon {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    flex: none;
    border-radius: var(--radius);
    color: var(--text-3);
  }

  .opt-icon.primary {
    background: var(--hover);
    box-shadow: inset 0 0 0 1px var(--hairline);
    color: var(--text-2);
  }

  .opt-icon.primary.active {
    background: var(--selected);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
    color: var(--text);
  }

  .opt-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .opt-title,
  .opt-url {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .opt-title {
    color: var(--text);
    font-weight: 500;
  }

  .opt-url {
    font-size: var(--text-xs);
    color: var(--text-3);
  }

  .opt-detail {
    font-size: var(--text-sm);
    color: var(--text-3);
    white-space: nowrap;
  }

  .opt-go {
    display: grid;
    color: var(--text-3);
  }
</style>
