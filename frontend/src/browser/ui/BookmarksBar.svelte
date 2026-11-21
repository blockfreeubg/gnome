<!--
  Bookmarks bar (DESIGN.md §9.1: 32px under the toolbar on every route, appearance.showBookmarksBar): the children of the bookmark root (lane d's
  store). Folders open a menu of their bookmarks; middle-click opens in a background tab.
-->
<script lang="ts">
  import Folder from '@lucide/svelte/icons/folder';
  import Globe from '@lucide/svelte/icons/globe';
  import Icon from '../../components/Icon.svelte';
  import Menu from '../../components/Menu.svelte';
  import type { MenuItem } from '../../components/menu';
  import { BOOKMARK_ROOT, onLibrary, type Bookmark, type BrowserLibrary } from '../../shared/browser-data';
  import { browser } from '../browser.svelte';

  let items = $state.raw<Bookmark[]>([]);
  let folders = $state.raw<Record<string, Bookmark[]>>({});
  let lib: BrowserLibrary | null = null;

  async function load(l: BrowserLibrary): Promise<void> {
    const top = await l.bookmarks.children(BOOKMARK_ROOT);
    const sub: Record<string, Bookmark[]> = {};
    for (const f of top.filter((b) => b.kind === 'folder').slice(0, 20)) sub[f.id] = await l.bookmarks.children(f.id);
    items = top.slice(0, 60);
    folders = sub;
  }

  $effect(() => {
    let off: (() => void) | null = null;
    const stop = onLibrary((l) => {
      off?.();
      off = null;
      lib = l;
      if (!l) return;
      void load(l).catch(() => undefined);
      off = l.bookmarks.onChange(() => void load(l).catch(() => undefined));
    });
    return () => {
      stop();
      off?.();
    };
  });

  function folderItems(f: Bookmark): MenuItem[] {
    const kids = folders[f.id] ?? [];
    if (!kids.length) return [{ label: 'Empty folder', disabled: true }];
    return kids
      .filter((k) => k.kind === 'bookmark' && k.url)
      .slice(0, 50)
      .map((k) => ({ label: k.title || k.url!, onSelect: () => void browser.openUrl(k.url!, {}) }));
  }
  void lib;
</script>

<nav class="bar" aria-label="Bookmarks bar">
  {#if items.length === 0}
    <span class="empty">Bookmark pages with the star in the address bar to see them here.</span>
  {:else}
    {#each items as b (b.id)}
      {#if b.kind === 'folder'}
        <Menu items={() => folderItems(b)} label={b.title} placement="bottom-start">
          {#snippet trigger(props)}
            <button type="button" class="item" {...props}><Icon icon={Folder} size={14} /><span>{b.title}</span></button>
          {/snippet}
        </Menu>
      {:else if b.url}
        <a
          class="item"
          href={`/browse?url=${encodeURIComponent(b.url)}`}
          data-router="off"
          title={b.url}
          onclick={(ev) => {
            ev.preventDefault();
            void browser.openUrl(b.url!, ev.ctrlKey || ev.metaKey ? { newTab: true, background: true } : {});
          }}
          onauxclick={(ev) => {
            if (ev.button !== 1) return;
            ev.preventDefault();
            void browser.openUrl(b.url!, { newTab: true, background: true });
          }}
        >
          <Icon icon={Globe} size={14} /><span>{b.title || b.url}</span>
        </a>
      {/if}
    {/each}
  {/if}
</nav>

<style>
  /* Part of the glass chrome (app/Chrome.svelte paints --chrome-bg behind it): no background of its own. */
  .bar {
    display: flex;
    align-items: center;
    gap: 2px;
    height: var(--bookmarks-h);
    padding: 0 8px;
    overflow: hidden;
    border-bottom: 1px solid var(--hairline);
  }

  .item {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    flex: none;
    max-width: 180px;
    height: 24px;
    padding: 0 8px;
    border: 0;
    border-radius: calc(var(--radius-sm) + 1px);
    background: transparent;
    color: var(--text-2);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 500;
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background-color var(--t-1) var(--ease-out),
      color var(--t-1) var(--ease-out);
  }

  .item span {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .item :global(svg) {
    flex: none;
    color: var(--text-3);
  }

  .item:hover,
  .item[aria-expanded='true'] {
    background: var(--hover);
    color: var(--text);
  }

  .item:focus-visible {
    outline-offset: -2px;
  }

  .empty {
    color: var(--text-3);
    font-size: var(--text-sm);
    padding: 0 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (pointer: coarse) {
    .bar {
      height: max(var(--bookmarks-h), 40px);
    }

    .item {
      height: 32px;
    }
  }
</style>
