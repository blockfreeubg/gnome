<!--
  The address bar: shows the active tab's address (as text: it is not a security indicator, ENGINE-PROTOCOL §1.2
  rule 3), edits it, and suggests the primary action, bookmarks, history and (when enabled and offered) search
  suggestions. Enter opens in the active tab, Alt+Enter in a new tab. The star bookmarks the page; the pop-up
  indicator and the engine badge sit at its end. On GNOME's own pages it shows gnome://<page> (empty on Home) and
  what is typed opens in the browser (a new tab unless the active one is empty).
  The site icon is deliberately not a padlock: addresses are not security indicators (ENGINE-PROTOCOL §1.2 rule 3).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
  import Bookmark from '@lucide/svelte/icons/bookmark';
  import Clock from '@lucide/svelte/icons/clock';
  import Globe from '@lucide/svelte/icons/globe';
  import LayoutGrid from '@lucide/svelte/icons/layout-grid';
  import Search from '@lucide/svelte/icons/search';
  import Star from '@lucide/svelte/icons/star';
  import type { LucideIcon } from '@lucide/svelte';
  import { router } from '../../app/router.svelte';
  import Combobox, { type ComboboxModifiers } from '../../components/Combobox.svelte';
  import Icon from '../../components/Icon.svelte';
  import { tooltip } from '../../components/tooltip.svelte';
  import { displayUrl } from '../../lib/url';
  import { SEARCH_ENGINES } from '../../settings/defaults';
  import { settings } from '../../settings/store.svelte';
  import { library, onLibrary, type Suggestion } from '../../shared/browser-data';
  import { browser } from '../browser.svelte';
  import { mergeOptions, primaryOption, SuggestThrottle, wantsSearchSuggestions, type OmniOption } from '../omnibox';
  import EngineBadge from './EngineBadge.svelte';
  import MarkGlyph from './MarkGlyph.svelte';
  import PopupIndicator from './PopupIndicator.svelte';

  interface Props {
    compact?: boolean;
    /** The browser view is the visible route; otherwise the field shows the GNOME page's gnome:// address. */
    onBrowser?: boolean;
  }
  let { compact = false, onBrowser = true }: Props = $props();

  /** gnome://<page> for the current GNOME page; Home (the new-tab page) shows an empty field. */
  const pageAddress = $derived.by(() => {
    const r = router.current;
    if (onBrowser || !r || r.route.id === 'home') return '';
    return `gnome://${r.pathname.replace(/^\/+/, '')}`;
  });
  /**
   * The site icon: a globe for every page, whatever its scheme. Never a padlock (or an "open lock" warning whose
   * absence reads as "secure"): a hostile page can make its tab show any address, so the address bar must not look
   * like proof of a site's identity (ENGINE-PROTOCOL §1.2 rule 3; this overrides DESIGN.md §11.3's lock icons).
   */
  const siteIcon = $derived.by((): LucideIcon => {
    if (focused) return Search;
    if (!onBrowser) return pageAddress ? (MarkGlyph as unknown as LucideIcon) : Search;
    return active?.url ? Globe : Search;
  });

  const active = $derived(browser.model.active);
  const search = $derived(settings.value.browser);
  const engineName = $derived(search.searchEngine === 'custom' ? 'your search engine' : SEARCH_ENGINES[search.searchEngine].label);

  let value = $state('');
  let open = $state(false);
  let focused = $state(false);
  let input = $state<HTMLInputElement>();
  let fromLibrary = $state.raw<Suggestion[]>([]);
  let queries = $state.raw<string[]>([]);
  let bookmarked = $state(false);
  const throttle = new SuggestThrottle();
  let suggestTimer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;

  // The field shows the active tab's address (or the GNOME page's) unless the user is editing it.
  let shownFor: string | null = null;
  $effect(() => {
    const t = active;
    // A failed navigation shows the address that failed (the error overlay is about it), like browsers do.
    const url = t?.error?.url ?? t?.url ?? null;
    const draft = t?.draft ?? null;
    const page = pageAddress;
    const key = onBrowser ? `tab:${t?.id ?? ''}` : `page:${page}`;
    if (focused && shownFor === key) return;
    shownFor = key;
    value = onBrowser ? (draft ?? (url ? displayUrl(url) : '')) : page;
  });

  /** What the field shows when it is not being edited. */
  function resting(): string {
    if (!onBrowser) return pageAddress;
    const shownUrl = active?.error?.url ?? active?.url;
    return shownUrl ? displayUrl(shownUrl) : '';
  }

  // Alt+L / bridge.focusOmnibox().
  $effect(() => {
    if (browser.focusOmniboxTick === 0) return;
    queueMicrotask(() => {
      input?.focus();
      input?.select();
    });
  });

  // The star: is the active page bookmarked?
  let libVersion = $state(0);
  const bump = (): void => {
    untrack(() => {
      libVersion++;
    });
  };
  $effect(() => {
    let off: (() => void) | null = null;
    const stop = onLibrary((lib) => {
      off?.();
      off = lib ? lib.bookmarks.onChange(bump) : null;
      bump();
    });
    return () => {
      stop();
      off?.();
    };
  });
  $effect(() => {
    void libVersion;
    const url = active?.url;
    if (!url) {
      bookmarked = false;
      return;
    }
    const lib = library();
    if (!lib) return;
    let alive = true;
    void lib.bookmarks
      .byUrl(url)
      .then((b) => alive && (bookmarked = b.length > 0))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  });

  const options = $derived(mergeOptions(primaryOption(value, search, engineName), fromLibrary, queries));

  function onInput(): void {
    if (active && onBrowser) active.draft = value;
    const text = value;
    const id = ++seq;
    const lib = library();
    if (lib && text.trim()) {
      void Promise.all([lib.history.suggest(text, 6).catch(() => []), lib.bookmarks.suggest(text, 4).catch(() => [])]).then(([h, b]) => {
        if (id === seq) fromLibrary = [...b, ...h];
      });
    } else fromLibrary = [];
    if (suggestTimer) clearTimeout(suggestTimer);
    queries = [];
    const provider = wantsSearchSuggestions(text, search, search.searchSuggestions);
    if (!provider || !browser.hasCapability('suggest')) return;
    suggestTimer = setTimeout(() => {
      suggestTimer = null;
      if (id !== seq) return;
      throttle.sent(Date.now());
      void browser.searchSuggestions(text.trim(), provider).then((items) => {
        if (id === seq) queries = items;
      });
    }, throttle.delay(Date.now()));
  }

  function finish(): void {
    open = false;
    if (active && onBrowser) active.draft = null;
    input?.blur();
  }

  function select(opt: OmniOption, mods: ComboboxModifiers): void {
    const newTab = mods.altKey;
    if (opt.kind === 'primary') browser.submitOmnibox(value, { newTab });
    else if (opt.kind === 'site') browser.openUrl(opt.url, { newTab });
    else browser.submitOmnibox(opt.text, { newTab });
    finish();
  }

  function submit(text: string, mods: ComboboxModifiers): void {
    if (!text.trim()) return;
    browser.submitOmnibox(text, { newTab: mods.altKey });
    finish();
  }

  function groupOf(o: OmniOption): string | undefined {
    if (o.kind === 'site') return o.source === 'bookmark' ? 'Bookmarks' : 'History';
    if (o.kind === 'query') return `${engineName} suggestions`;
    return undefined;
  }
</script>

{#snippet optionView(opt: OmniOption, state: { active: boolean })}
  {#if opt.kind === 'primary'}
    <span class="opt-icon primary" class:active={state.active}>
      <Icon icon={opt.mode === 'url' ? Globe : opt.mode === 'internal' ? LayoutGrid : Search} size={15} />
    </span>
    <span class="opt-text"><span class="opt-title">{opt.title}</span></span>
    <span class="opt-detail">{opt.detail}</span>
  {:else if opt.kind === 'site'}
    <span class="opt-icon"><Icon icon={opt.source === 'bookmark' ? Bookmark : Clock} size={14} /></span>
    <span class="opt-text">
      <span class="opt-title">{opt.title}</span>
      <span class="opt-url mono">{displayUrl(opt.url)}</span>
    </span>
    {#if state.active}<span class="opt-go"><Icon icon={ArrowUpRight} size={14} /></span>{/if}
  {:else}
    <span class="opt-icon"><Icon icon={Search} size={14} /></span>
    <span class="opt-text"><span class="opt-title">{opt.text}</span></span>
  {/if}
{/snippet}

<div class="omnibox" class:compact class:internal={!onBrowser && !!pageAddress}>
  <Combobox
    bind:value
    bind:open
    bind:element={input}
    {options}
    getKey={(o) => o.key}
    getLabel={(o) => (o.kind === 'primary' ? o.title : o.kind === 'site' ? o.title : o.text)}
    getGroup={groupOf}
    option={optionView}
    onselect={select}
    onsubmit={submit}
    autoActivateFirst
    size="md"
    icon={siteIcon}
    label="Address and search bar"
    placeholder={compact ? 'Search or enter an address' : `Search ${engineName} or enter an address`}
    enterkeyhint="go"
    data-omnibox
    oninput={onInput}
    onfocus={() => {
      focused = true;
      queueMicrotask(() => input?.select());
    }}
    onblur={() => {
      focused = false;
      if (!onBrowser) value = pageAddress;
      else if (active && !active.draft) value = resting();
    }}
    onkeydown={(ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && !open) {
        if (active && onBrowser) active.draft = null;
        value = resting();
        input?.blur();
      }
    }}
  >
    {#snippet trailing()}
      {#if onBrowser && !focused && active && active.blockedPopups.length}<PopupIndicator tab={active} />{/if}
      {#if onBrowser && active?.url && !focused}
        <button
          type="button"
          class="star"
          class:on={bookmarked}
          aria-label={bookmarked ? 'Edit bookmark' : 'Bookmark this page'}
          aria-pressed={bookmarked}
          onclick={() => active?.url && browser.editBookmark(active.url, active.title)}
          {@attach tooltip({ text: bookmarked ? 'Edit bookmark' : 'Bookmark this page', action: 'bookmarkPage', placement: 'bottom' })}
        >
          <Icon icon={Star} size={15} />
        </button>
        {#if !compact && settings.value.appearance.toolbar !== 'compact'}<EngineBadge />{/if}
      {/if}
    {/snippet}
  </Combobox>
</div>

<style>
  .omnibox {
    flex: 1;
    min-width: 0;
  }

  /* The address bar (DESIGN.md §11.3): 34px, --surface-1, a hairline, field focus (border + 3px halo). */
  .omnibox :global(.combobox) {
    height: 34px;
    gap: 9px;
    padding: 0 6px 0 12px;
    border-color: var(--hairline);
    background: var(--surface-1);
    border-radius: var(--radius);
    font-size: 0.9286rem;
  }

  .omnibox :global(.combobox:hover) {
    border-color: var(--hairline-strong);
  }

  .omnibox :global(.combobox:focus-within) {
    border-color: var(--focus-border);
    box-shadow: 0 0 0 3px var(--focus-halo);
    background: var(--surface-1);
  }

  .omnibox :global(.combobox > .lead) {
    width: 16px;
    justify-content: center;
  }

  .omnibox :global(.combobox > .lead svg) {
    width: auto;
    max-width: 16px;
    height: 15px;
  }

  .omnibox.internal :global(.combobox > .lead) {
    color: var(--text-2);
  }

  .omnibox :global(.combobox > .trail) {
    gap: 2px;
  }

  .omnibox :global(input) {
    font-size: inherit;
  }

  .omnibox:not(:focus-within) :global(input) {
    color: var(--text-2);
  }

  .omnibox:not(:focus-within) :global(input::placeholder) {
    color: var(--text-3);
  }

  .omnibox :global(.popup-btn) {
    width: 26px;
    height: 26px;
  }

  .star {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: calc(var(--radius-sm) + 1px);
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
    transition:
      color var(--t-1) var(--ease-out),
      background-color var(--t-1) var(--ease-out),
      transform var(--t-2) var(--ease-spring);
  }

  .star:hover {
    color: var(--text);
    background: var(--hover);
  }

  .star.on {
    color: var(--accent);
  }

  .star.on :global(svg) {
    fill: currentColor;
  }

  .star:active {
    transform: scale(calc(1 - 0.1 * var(--motion-move)));
  }

  .opt-icon {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    flex: none;
    border-radius: var(--radius);
    color: var(--text-3);
  }

  .opt-icon.primary {
    border: 1px solid var(--hairline-strong);
    color: var(--text-2);
  }

  .opt-icon.primary.active {
    color: var(--text);
    background: var(--selected);
    border-color: var(--selected-ring);
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

  .opt-url {
    font-size: var(--text-xs);
    color: var(--text-3);
  }

  .opt-detail {
    flex: none;
    font-size: var(--text-xs);
    color: var(--text-3);
  }

  .opt-go {
    color: var(--text-3);
    flex: none;
  }
</style>
