<!--
  Command palette (Ctrl/⌘+K): pages from the route registry, registered commands and — when the query looks like
  an address or search — an "Open …" entry. Fuzzy search, keyboard first (↑↓ PageUp PageDown, Enter, Esc).
-->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import type { LucideIcon } from '@lucide/svelte';
  import Check from '@lucide/svelte/icons/check';
  import Globe from '@lucide/svelte/icons/globe';
  import History from '@lucide/svelte/icons/history';
  import Search from '@lucide/svelte/icons/search';
  import Icon from '../components/Icon.svelte';
  import Kbd from '../components/Kbd.svelte';
  import { captureFocus } from '../components/focus';
  import { modalClosed, modalShown } from '../components/modal-stack.svelte';
  import { animate, canMove, DUR } from '../components/motion';
  import { resolveShortcut } from '../components/menu';
  import { openInput } from '../browser/bridge';
  import { fuzzyMatch, highlightParts } from '../lib/fuzzy';
  import { displayUrl, parseOmnibox } from '../lib/url';
  import { SEARCH_ENGINES } from '../settings/defaults';
  import { settings } from '../settings/store.svelte';
  import { listCommands, markUsed, recentIds } from './commands';
  import { navigate } from './router.svelte';
  import { allRoutes, pathFor } from './routes';
  import { shell } from './shell.svelte';

  interface Item {
    id: string;
    title: string;
    subtitle?: string;
    group: string;
    icon?: LucideIcon;
    shortcut?: string;
    checked?: boolean;
    keywords?: string[];
    run: () => void | Promise<void>;
    indices?: number[];
  }

  const uid = $props.id();
  const narrow = new MediaQuery('max-width: 759px');
  let dialogEl = $state<HTMLDialogElement>();
  let panelEl = $state<HTMLDivElement>();
  let inputEl = $state<HTMLInputElement>();
  let query = $state('');
  /** Bumped on every open so "Recent" is re-read from storage and the selection resets. */
  let openCount = $state(0);
  /** Highlighted result: back to the first one whenever the query changes or the palette reopens. */
  let active = $derived.by(() => {
    void query;
    void openCount;
    return 0;
  });
  let restore: (() => void) | null = null;

  const pageItems = $derived.by((): Item[] =>
    allRoutes()
      .filter((r) => r.nav && r.palette !== false)
      .map((r) => ({
        id: `route:${r.id}`,
        title: r.nav!.label,
        subtitle: r.description,
        group: 'Go to',
        icon: r.nav!.icon,
        shortcut: r.nav!.shortcut,
        keywords: r.keywords,
        run: () => navigate(pathFor(r.id)),
      })),
  );

  const commandItems = $derived.by((): Item[] =>
    listCommands().map((c) => ({
      id: `cmd:${c.id}`,
      title: c.title,
      subtitle: c.subtitle,
      group: c.group,
      icon: c.icon,
      shortcut: c.shortcut,
      checked: c.checked?.(),
      keywords: c.keywords,
      run: c.run,
    })),
  );

  /** "Open <address>" / "Search <engine> for …" for the typed text (internal gnome:// pages match as routes). */
  const web = $derived.by((): { item: Item; isUrl: boolean } | null => {
    const q = query.trim();
    if (!q) return null;
    const b = settings.value.browser;
    const r = parseOmnibox(q, { searchEngine: b.searchEngine, customSearchUrl: b.customSearchUrl });
    if (!r || r.kind === 'internal') return null;
    const engine = b.searchEngine === 'custom' ? 'your search engine' : SEARCH_ENGINES[b.searchEngine].label;
    const isUrl = r.kind === 'url';
    return {
      isUrl,
      item: {
        id: 'web:open',
        title: isUrl ? `Open ${displayUrl(r.href)}` : `Search ${engine} for “${q}”`,
        subtitle: isUrl ? 'Opens in the browser' : undefined,
        group: 'Web',
        icon: isUrl ? Globe : Search,
        run: () => void openInput(q),
      },
    };
  });

  interface Section {
    label: string;
    items: Item[];
  }

  const sections = $derived.by((): Section[] => {
    const q = query.trim();
    const all = [...pageItems, ...commandItems];
    void openCount;
    if (!q) {
      const byId = new Map(all.map((i) => [i.id, i]));
      const recent = recentIds()
        .map((id) => byId.get(id))
        .filter((i): i is Item => !!i)
        .map((i) => ({ ...i, icon: i.icon ?? History }));
      const groups = new Map<string, Item[]>();
      for (const item of all) {
        const list = groups.get(item.group) ?? [];
        list.push(item);
        groups.set(item.group, list);
      }
      const out: Section[] = [];
      if (recent.length) out.push({ label: 'Recent', items: recent.map((i) => ({ ...i, id: `recent:${i.id}` })) });
      for (const [label, items] of groups) out.push({ label, items });
      return out;
    }
    const scored: Array<Item & { score: number }> = [];
    for (const item of all) {
      const t = fuzzyMatch(q, item.title);
      let score = t ? t.score : -Infinity;
      if (item.keywords) {
        for (const k of item.keywords) {
          const m = fuzzyMatch(q, k);
          if (m) score = Math.max(score, m.score * 0.75);
        }
      }
      if (item.subtitle) {
        const m = fuzzyMatch(q, item.subtitle);
        if (m) score = Math.max(score, m.score * 0.5);
      }
      if (score > -Infinity) scored.push({ ...item, score, indices: t?.indices ?? [] });
    }
    scored.sort((a, b) => b.score - a.score);
    const out: Section[] = [];
    // An address the user typed comes first; a web search is the fallback after matching pages and commands.
    if (web?.isUrl) out.push({ label: 'Web', items: [web.item] });
    if (scored.length) out.push({ label: 'Results', items: scored.slice(0, 40) });
    if (web && !web.isUrl) out.push({ label: 'Web', items: [web.item] });
    return out;
  });

  const flat = $derived(sections.flatMap((s) => s.items));
  const flatIndex = $derived.by(() => {
    const m = new Map<string, number>();
    flat.forEach((item, i) => m.set(item.id, i));
    return m;
  });

  $effect(() => {
    document.getElementById(`${uid}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  });

  // Open / close the native dialog. Only `dialogEl` and `shell.paletteOpen` are dependencies; the resets below are
  // untracked so this effect never reads state it writes.
  $effect(() => {
    const el = dialogEl;
    if (!el) return;
    if (shell.paletteOpen && !el.open) {
      untrack(() => {
        restore = captureFocus();
        query = '';
        openCount += 1;
      });
      el.showModal();
      modalShown(el);
      void tick().then(() => {
        inputEl?.focus();
        if (panelEl) {
          void animate(
            panelEl,
            [
              { opacity: 0, transform: canMove() ? 'translateY(-6px) scale(0.99)' : 'none' },
              { opacity: 1, transform: 'none' },
            ],
            DUR[2],
          );
        }
      });
    } else if (!shell.paletteOpen && el.open) {
      el.close(); // focus is restored by the dialog's close event (onNativeClose)
      modalClosed(el);
    }
  });

  /** Runs for every close, including the browser closing the dialog itself (e.g. a repeated Escape). */
  function onNativeClose(): void {
    if (dialogEl?.open) return; // reopened before this (asynchronous) close event was delivered
    if (dialogEl) modalClosed(dialogEl);
    if (shell.paletteOpen) shell.closePalette();
    const r = restore;
    restore = null;
    r?.();
  }

  function close(): void {
    shell.closePalette();
  }

  async function run(item: Item | undefined): Promise<void> {
    if (!item) return;
    const id = item.id.replace(/^recent:/, '');
    if (id !== 'web:open') markUsed(id);
    restore = null; // the command decides where focus goes
    close();
    await tick();
    try {
      await item.run();
    } catch (err) {
      console.error('[gnome] command failed', err);
    }
  }

  function onKeydown(ev: KeyboardEvent): void {
    const n = flat.length;
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        if (n) active = (active + 1) % n;
        break;
      case 'ArrowUp':
        ev.preventDefault();
        if (n) active = (active - 1 + n) % n;
        break;
      case 'PageDown':
        ev.preventDefault();
        if (n) active = Math.min(n - 1, active + 8);
        break;
      case 'PageUp':
        ev.preventDefault();
        if (n) active = Math.max(0, active - 8);
        break;
      case 'Enter':
        ev.preventDefault();
        void run(flat[active]);
        break;
      default:
        if ((ev.key === 'k' || ev.key === 'K') && (ev.metaKey || ev.ctrlKey)) {
          ev.preventDefault();
          close();
        }
    }
  }
</script>

<dialog
  bind:this={dialogEl}
  class="palette"
  aria-label="Command palette"
  oncancel={(ev) => {
    ev.preventDefault();
    close();
  }}
  onclose={onNativeClose}
  onclick={(ev) => {
    if (ev.target === dialogEl) close();
  }}
>
  {#if shell.paletteOpen}
    <div class="panel" bind:this={panelEl}>
      <div class="search">
        <Icon icon={Search} size={18} class="search-icon" />
        <input
          bind:this={inputEl}
          bind:value={query}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="{uid}-list"
          aria-activedescendant={flat.length ? `${uid}-opt-${active}` : undefined}
          aria-autocomplete="list"
          aria-label="Search commands and pages"
          placeholder={narrow.current ? 'Search or enter an address' : 'Search commands, pages, or type an address'}
          autocomplete="off"
          spellcheck="false"
          onkeydown={onKeydown}
        />
        <Kbd keys={['esc']} />
      </div>

      <div class="results">
        {#if flat.length === 0}
          <p class="none">No matches for “{query.trim()}”.</p>
        {:else}
          <!-- mousedown: keeps focus (and typing) in the search field when results are pressed, in every browser -->
          <div id="{uid}-list" role="listbox" aria-label="Results" tabindex="-1" onmousedown={(ev) => ev.preventDefault()}>
            {#each sections as section, si (section.label)}
              <div role="group" aria-labelledby="{uid}-g{si}">
                <div class="group-label eyebrow" id="{uid}-g{si}">{section.label}</div>
                {#each section.items as item (item.id)}
                  {@const index = flatIndex.get(item.id) ?? 0}
                  {@const shortcut = resolveShortcut(item.shortcut)}
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <div
                    id="{uid}-opt-{index}"
                    role="option"
                    tabindex="-1"
                    class="option"
                    class:active={index === active}
                    aria-selected={index === active}
                    onpointermove={() => (active = index)}
                    onclick={() => run(item)}
                  >
                    <span class="opt-icon">{#if item.icon}<Icon icon={item.icon} size={16} />{/if}</span>
                    <span class="opt-text">
                      <span class="opt-title">
                        {#if item.indices?.length}
                          {#each highlightParts(item.title, item.indices) as part, pi (pi)}
                            {#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}
                          {/each}
                        {:else}
                          {item.title}
                        {/if}
                      </span>
                      {#if item.subtitle}<span class="opt-sub">{item.subtitle}</span>{/if}
                    </span>
                    {#if query.trim() && section.label === 'Results'}<span class="opt-group">{item.group}</span>{/if}
                    {#if item.checked}<span class="opt-check"><Check size={15} strokeWidth={2} aria-label="Current" /></span>{/if}
                    {#if shortcut}<span class="opt-kbd"><Kbd combo={shortcut} /></span>{/if}
                  </div>
                {/each}
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <footer class="hints" aria-hidden="true">
        <span><Kbd keys={['↑', '↓']} /> navigate</span>
        <span><Kbd keys={['↵']} /> open</span>
        <span><Kbd keys={['esc']} /> close</span>
      </footer>
    </div>
  {/if}
</dialog>

<style>
  .palette {
    margin: 13vh auto auto;
    width: min(640px, calc(100vw - 24px));
    max-height: none;
    overflow: visible;
    color: var(--text);
  }

  .palette::backdrop {
    background: var(--scrim, rgba(8, 8, 6, 0.6));
    animation: fade-in calc(var(--dur-2, 160ms) * var(--motion, 1)) ease-out both;
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
  }

  .panel {
    display: flex;
    flex-direction: column;
    max-height: min(560px, 74dvh);
    border-radius: var(--radius-xl);
    background: var(--glass-bg-dense);
    -webkit-backdrop-filter: var(--glass-filter);
    backdrop-filter: var(--glass-filter);
    border: 1px solid var(--glass-border);
    box-shadow:
      inset 0 1px 0 var(--glass-highlight),
      var(--shadow-sheet);
    overflow: hidden;
  }

  .search {
    flex: none; /* the panel only has a max-height: without this the long result list squeezes the input row */
    display: flex;
    align-items: center;
    gap: 12px;
    height: 48px;
    margin: 10px 10px 4px;
    padding: 0 12px 0 14px;
    border-radius: var(--radius-lg);
    background: var(--field-bg);
    border: 1px solid var(--field-border);
    transition:
      border-color var(--t-1) var(--ease-out),
      box-shadow var(--t-1) var(--ease-out);
  }

  .search:focus-within {
    border-color: var(--focus-border);
    box-shadow: 0 0 0 3px var(--focus-halo);
  }

  .search :global(.search-icon) {
    color: var(--text-3);
  }

  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    outline: none;
    background: transparent;
    font-size: 1.07rem;
    font-weight: 500;
    color: var(--text);
  }

  .search input::placeholder {
    color: var(--text-3);
  }

  .results {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 6px;
  }

  .group-label {
    padding: 10px 10px 5px;
  }

  .option {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 44px;
    padding: 6px 10px;
    border-radius: var(--radius);
    cursor: pointer;
    user-select: none;
  }

  .option.active {
    background: var(--selected);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
  }

  .opt-icon {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    flex: none;
    border-radius: var(--radius);
    border: 1px solid var(--hairline);
    color: var(--text-2);
  }

  .option.active .opt-icon {
    color: var(--text);
    border-color: var(--hairline-strong);
  }

  .opt-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .opt-title,
  .opt-sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .opt-title {
    font-weight: 500;
  }

  .opt-title mark {
    background: none;
    color: var(--text);
    font-weight: 700;
    text-decoration: underline;
    text-decoration-color: color-mix(in oklab, var(--accent) 70%, transparent);
    text-decoration-thickness: 2px;
    text-underline-offset: 3px;
  }

  .opt-sub {
    font-size: var(--text-sm);
    color: var(--text-3);
  }

  .opt-group {
    font-size: var(--text-xs);
    color: var(--text-3);
    white-space: nowrap;
  }

  .opt-check {
    display: grid;
    color: var(--accent);
  }

  .none {
    padding: 28px 16px;
    text-align: center;
    color: var(--text-3);
  }

  .hints {
    flex: none;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 9px 16px;
    border-top: 1px solid var(--hairline);
    font-size: var(--text-xs);
    color: var(--text-3);
  }

  .hints span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  /* Phones and touch screens: no key caps or keyboard legend, more room for names. */
  @media (max-width: 759px), (pointer: coarse) {
    .opt-kbd,
    .hints,
    .search :global(.kbd) {
      display: none;
    }
  }

  @media (max-width: 759px) {
    .palette {
      margin-top: 8vh;
    }
  }
</style>
