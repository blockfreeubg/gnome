<!--
  Bookmarks: folder tree (desktop) and the current folder's items in their order, with add / edit / move
  (drag and drop, or Move up / Move down / the editor's folder), favorites (shown on Home; device-local), search across
  every folder, Netscape-HTML import and export, delete with Undo. The root is the bookmarks bar. The folder in view
  is in the address (?folder=<id>, ?view=favorites), so Back and Forward work.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import BookmarkIcon from '@lucide/svelte/icons/bookmark';
  import BookmarkPlus from '@lucide/svelte/icons/bookmark-plus';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Copy from '@lucide/svelte/icons/copy';
  import Ellipsis from '@lucide/svelte/icons/ellipsis-vertical';
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import FileDown from '@lucide/svelte/icons/file-down';
  import FileUp from '@lucide/svelte/icons/file-up';
  import Folder from '@lucide/svelte/icons/folder';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import FolderPlus from '@lucide/svelte/icons/folder-plus';
  import PanelTop from '@lucide/svelte/icons/panel-top';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Search from '@lucide/svelte/icons/search';
  import Star from '@lucide/svelte/icons/star';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Button from '../../components/Button.svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import Menu from '../../components/Menu.svelte';
  import PageHeader from '../../components/PageHeader.svelte';
  import SearchInput from '../../components/SearchInput.svelte';
  import Skeleton from '../../components/Skeleton.svelte';
  import type { MenuItem } from '../../components/menu';
  import { openContextMenu } from '../../app/overlays/contextmenu.svelte';
  import { toast } from '../../app/overlays/toast.svelte';
  import { navigate } from '../../app/router.svelte';
  import type { PageProps } from '../../app/routes';
  import { browseLink, openUrl } from '../../browser/bridge';
  import { formatNumber } from '../../lib/format';
  import { BookmarkError, type BookmarkTreeNode } from '../../library/bookmarks';
  import { initLibrary, localLibrary } from '../../library/index';
  import { exportNetscapeBookmarks } from '../../library/netscape';
  import Notice from '../../library/ui/Notice.svelte';
  import SiteTile from '../../library/ui/SiteTile.svelte';
  import { childCounts, copyText, descendantFolders, errorText, folderChain, folderTree, ROOT_LABEL, saveTextFile, shortUrl, word } from '../../library/ui/view';
  import { BOOKMARK_ROOT, type Bookmark } from '../../shared/browser-data';
  import BookmarkDialog from './BookmarkDialog.svelte';
  import ImportDialog from './ImportDialog.svelte';
  import type { BookmarkDraft, SaveError } from './types';

  let { query }: PageProps = $props();

  initLibrary();
  const lib = localLibrary()!;
  const store = lib.bookmarks;

  // Raw state: the lists are replaced as a whole on every change and can hold 20 000 items; deep proxies made every
  // derived value and each tree row's count read all of them through the reactivity layer (seconds per change).
  let items = $state.raw<Bookmark[]>([]);
  let loading = $state(true);
  let failed = $state<string | null>(null);
  let text = $state('');
  let results = $state.raw<Bookmark[]>([]);
  let dialogOpen = $state(false);
  let editing = $state<Bookmark | null>(null);
  let draft = $state<BookmarkDraft>({ kind: 'bookmark', title: '', url: '', parentId: BOOKMARK_ROOT, favorite: false });
  let importOpen = $state(false);

  const view = $derived(query.get('view') === 'favorites' ? 'favorites' : 'folder');
  const requested = $derived(query.get('folder') ?? BOOKMARK_ROOT);
  const byId = $derived(new Map(items.map((b) => [b.id, b])));
  const folderId = $derived(requested === BOOKMARK_ROOT || byId.get(requested)?.kind === 'folder' ? requested : BOOKMARK_ROOT);
  const tree = $derived(folderTree(items));
  const chain = $derived(folderId === BOOKMARK_ROOT ? [] : folderChain(byId, folderId));
  const counts = $derived(childCounts(items));
  const searching = $derived(text.trim().length > 0);
  const favorites = $derived(items.filter((b) => b.favorite && b.kind === 'bookmark').sort((a, b) => a.position - b.position));
  const shown = $derived(
    searching ? results : view === 'favorites' ? favorites : items.filter((b) => b.parentId === folderId).sort((a, b) => a.position - b.position || a.createdAt - b.createdAt),
  );
  const folderTitle = $derived(view === 'favorites' ? 'Favorites' : folderId === BOOKMARK_ROOT ? ROOT_LABEL : (byId.get(folderId)?.title ?? ROOT_LABEL));
  const liveCount = $derived(items.filter((b) => b.kind === 'bookmark').length);
  const forbidden = $derived(editing?.kind === 'folder' ? descendantFolders(items, editing.id) : new Set<string>());

  async function load(): Promise<void> {
    try {
      items = await store.all();
      failed = null;
      if (searching) results = await store.search(text, 500);
    } catch (err) {
      failed = errorText(err);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = store.onChange(() => {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        void load();
      }, 60);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  });

  $effect(() => {
    const q = text.trim();
    if (!q) {
      results = [];
      return;
    }
    const timer = setTimeout(async () => {
      try {
        results = await store.search(q, 500);
      } catch {
        results = [];
      }
    }, 120);
    return () => clearTimeout(timer);
  });

  function go(id: string | 'favorites'): void {
    text = '';
    const to = id === 'favorites' ? '/bookmarks?view=favorites' : id === BOOKMARK_ROOT ? '/bookmarks' : `/bookmarks?folder=${encodeURIComponent(id)}`;
    void navigate(to);
  }

  function pathOf(b: Bookmark): string {
    if (b.parentId === BOOKMARK_ROOT) return ROOT_LABEL;
    return [ROOT_LABEL, ...folderChain(byId, b.parentId).map((f) => f.title)].join(' › ');
  }

  // ── Editing ──────────────────────────────────────────────────────────────────────────────────────────────────────

  function addNew(kind: 'bookmark' | 'folder'): void {
    editing = null;
    draft = { kind, title: '', url: '', parentId: view === 'favorites' ? BOOKMARK_ROOT : folderId, favorite: view === 'favorites' };
    dialogOpen = true;
  }

  function edit(b: Bookmark): void {
    editing = b;
    draft = { kind: b.kind, title: b.title, url: b.url ?? '', parentId: b.parentId, favorite: b.favorite };
    dialogOpen = true;
  }

  async function save(d: BookmarkDraft): Promise<SaveError | null> {
    try {
      let url = d.url.trim();
      if (d.kind === 'bookmark' && url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
      if (editing) {
        await store.update(editing.id, { title: d.title, ...(d.kind === 'bookmark' ? { url } : {}), parentId: d.parentId });
        if (d.kind === 'bookmark' && d.favorite !== editing.favorite) await store.setFavorite(editing.id, d.favorite);
        toast.success(d.kind === 'folder' ? 'Folder saved' : 'Bookmark saved');
      } else {
        const b = await store.add({ parentId: d.parentId, kind: d.kind, title: d.title, url: d.kind === 'bookmark' ? url : null, favorite: d.favorite });
        toast.success(d.kind === 'folder' ? 'Folder created' : 'Bookmark added', { description: b.title });
      }
      return null;
    } catch (err) {
      const message = errorText(err);
      return { field: err instanceof BookmarkError && err.code === 'invalid-url' ? 'url' : 'folder', message };
    }
  }

  async function remove(b: Bookmark): Promise<void> {
    try {
      const folders = b.kind === 'folder' ? descendantFolders(items, b.id) : null;
      const inside = folders ? items.filter((x) => folders.has(x.parentId)).length : 0;
      const undo = await store.removeWithUndo(b.id);
      toast.show({
        title: b.kind === 'folder' ? `Deleted “${b.title}”` : 'Bookmark deleted',
        description: b.kind === 'folder' && inside ? `With ${formatNumber(inside)} ${word(inside, 'item')} inside.` : b.kind === 'bookmark' ? b.title : undefined,
        kind: 'success',
        actions: [{ label: 'Undo', onClick: () => undo() }],
      });
    } catch (err) {
      toast.error('Could not delete', { description: errorText(err) });
    }
  }

  async function act(fn: () => Promise<unknown>, failure: string): Promise<void> {
    try {
      await fn();
    } catch (err) {
      toast.error(failure, { description: errorText(err) });
    }
  }

  function siblingsOf(b: Bookmark): Bookmark[] {
    return items.filter((x) => x.parentId === b.parentId).sort((x, y) => x.position - y.position || x.createdAt - y.createdAt);
  }

  function move(b: Bookmark, delta: number): void {
    const s = siblingsOf(b);
    const i = s.findIndex((x) => x.id === b.id);
    const to = i + delta;
    if (i < 0 || to < 0 || to >= s.length) return;
    void act(() => store.update(b.id, { position: to }), 'Could not move');
  }

  function openAll(folder: Bookmark): void {
    const urls = items.filter((x) => x.parentId === folder.id && x.kind === 'bookmark' && x.url).map((x) => x.url!);
    for (const u of urls.slice(0, 20)) void openUrl(u, { newTab: true, background: true });
    if (urls.length > 20) toast.info(`Opened the first 20 of ${formatNumber(urls.length)} bookmarks`);
  }

  function menu(b: Bookmark): MenuItem[] {
    const s = view === 'folder' && !searching ? siblingsOf(b) : [];
    const i = s.findIndex((x) => x.id === b.id);
    const order: MenuItem[] = s.length
      ? [
          { label: 'Move up', icon: ArrowUp, disabled: i <= 0, onSelect: () => move(b, -1) },
          { label: 'Move down', icon: ArrowDown, disabled: i >= s.length - 1, onSelect: () => move(b, 1) },
        ]
      : [];
    if (b.kind === 'folder') {
      const n = items.filter((x) => x.parentId === b.id && x.kind === 'bookmark').length;
      return [
        { label: 'Open folder', icon: FolderOpen, onSelect: () => go(b.id) },
        { label: n ? `Open all ${formatNumber(Math.min(n, 20))} in new tabs` : 'Open all in new tabs', icon: PanelTop, disabled: !n, onSelect: () => openAll(b) },
        { kind: 'separator' },
        { label: 'Rename or move…', icon: Pencil, onSelect: () => edit(b) },
        ...order,
        { kind: 'separator' },
        { label: 'Delete folder', icon: Trash2, danger: true, onSelect: () => void remove(b) },
      ];
    }
    return [
      { label: 'Open', icon: ExternalLink, onSelect: () => void openUrl(b.url!) },
      { label: 'Open in new tab', icon: PanelTop, onSelect: () => void openUrl(b.url!, { newTab: true }) },
      { label: 'Copy address', icon: Copy, onSelect: async () => ((await copyText(b.url!)) ? toast.success('Address copied') : toast.error('Could not copy', { description: 'Clipboard access was denied by the browser.' })) },
      { kind: 'separator' },
      { label: 'Edit…', icon: Pencil, onSelect: () => edit(b) },
      { label: b.favorite ? 'Remove from favorites' : 'Add to favorites', icon: Star, onSelect: () => void act(() => store.setFavorite(b.id, !b.favorite), 'Could not update favorites') },
      ...order,
      ...(searching || view === 'favorites' ? [{ label: 'Show in folder', icon: Folder, onSelect: () => go(b.parentId) }] : []),
      { kind: 'separator' },
      { label: 'Delete', icon: Trash2, danger: true, onSelect: () => void remove(b) },
    ];
  }

  function activate(b: Bookmark, ev: MouseEvent): void {
    if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
    ev.preventDefault();
    if (b.kind === 'folder') go(b.id);
    else void openUrl(b.url!);
  }

  // ── Import / export ──────────────────────────────────────────────────────────────────────────────────────────────

  async function runImport(nodes: BookmarkTreeNode[], title: string) {
    const out = await store.importTree(nodes, BOOKMARK_ROOT, { folderTitle: title });
    toast.success(`Imported ${formatNumber(out.bookmarks)} ${word(out.bookmarks, 'bookmark')}`, {
      description: out.skipped ? `${formatNumber(out.skipped)} skipped (not web addresses, or over the limit).` : `Into “${title}”.`,
    });
    if (out.folderId) go(out.folderId);
    return out;
  }

  function runExport(): void {
    const html = exportNetscapeBookmarks(items);
    const name = `gnome-bookmarks-${new Date().toISOString().slice(0, 10)}.html`;
    saveTextFile(name, html, 'text/html');
    toast.success('Bookmarks exported', { description: name });
  }

  const moreItems: MenuItem[] = [
    { label: 'Import from file…', icon: FileUp, onSelect: () => (importOpen = true) },
    { label: 'Export to file', icon: FileDown, onSelect: runExport },
  ];

  // ── Drag and drop (mouse; keyboard users have Move up / Move down and the editor's folder) ─────────────────────

  let dragging = $state<string | null>(null);
  let dropAt = $state<{ id: string; where: 'before' | 'after' | 'into' } | null>(null);
  let dropFolder = $state<string | null>(null);
  /** The dragged folder and everything inside it (computed once per drag, not per dragover event). */
  let dragBlocked: Set<string> | null = null;

  function canDropInto(folder: string): boolean {
    if (!dragging || !byId.has(dragging)) return false;
    return !dragBlocked?.has(folder);
  }

  function onDragStart(b: Bookmark, ev: DragEvent): void {
    if (searching || view === 'favorites') return;
    dragging = b.id;
    dragBlocked = b.kind === 'folder' ? descendantFolders(items, b.id) : null;
    ev.dataTransfer?.setData('text/x-gnome-bookmark', b.id);
    if (b.url) ev.dataTransfer?.setData('text/uri-list', b.url);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  }

  function onRowOver(b: Bookmark, ev: DragEvent): void {
    if (!dragging || dragging === b.id) return;
    const el = ev.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const y = (ev.clientY - r.top) / r.height;
    const where = b.kind === 'folder' && y > 0.3 && y < 0.7 && canDropInto(b.id) ? 'into' : y < 0.5 ? 'before' : 'after';
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    dropAt = { id: b.id, where };
  }

  function onRowDrop(ev: DragEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    const target = dropAt;
    const id = dragging;
    endDrag();
    if (!target || !id) return;
    if (target.where === 'into') {
      void act(() => store.update(id, { parentId: target.id }), 'Could not move');
      return;
    }
    const list = shown.filter((x) => x.id !== id);
    const index = list.findIndex((x) => x.id === target.id) + (target.where === 'after' ? 1 : 0);
    void act(() => store.update(id, { parentId: folderId, position: index }), 'Could not move');
  }

  function onFolderOver(id: string, ev: DragEvent): void {
    if (!dragging || !canDropInto(id)) return;
    ev.preventDefault();
    dropFolder = id;
  }

  function onFolderDrop(id: string, ev: DragEvent): void {
    ev.preventDefault();
    const d = dragging;
    endDrag();
    if (d && byId.get(d)?.parentId !== id) void act(() => store.update(d, { parentId: id }), 'Could not move');
  }

  function endDrag(): void {
    dragging = null;
    dragBlocked = null;
    dropAt = null;
    dropFolder = null;
  }
</script>

<div class="page narrow library">
  <PageHeader title="Bookmarks" description="Saved pages and folders. The top level is your bookmarks bar; favorites also show on Home.">
    {#snippet actions()}
      <Button variant="outline" icon={FolderPlus} onclick={() => addNew('folder')}>New folder</Button>
      <Button variant="primary" icon={BookmarkPlus} onclick={() => addNew('bookmark')}>Add bookmark</Button>
      <Menu items={moreItems} label="Import and export" placement="bottom-end">
        {#snippet trigger(props)}
          <IconButton {...props} icon={Ellipsis} label="Import and export" variant="secondary" />
        {/snippet}
      </Menu>
    {/snippet}
  </PageHeader>

  {#if failed}
    <Notice icon={TriangleAlert} tone="danger" title="Bookmarks are unavailable">
      {failed}
      {#snippet actions()}<Button size="sm" variant="secondary" onclick={load}>Try again</Button>{/snippet}
    </Notice>
  {/if}

  <div class="layout">
    <nav class="tree" aria-label="Bookmark folders">
      <button
        type="button"
        class="node"
        class:active={view === 'favorites' && !searching}
        aria-current={view === 'favorites' && !searching ? 'page' : undefined}
        onclick={() => go('favorites')}
      >
        <Star size={16} strokeWidth={1.75} aria-hidden="true" />
        <span class="label">Favorites</span>
        <span class="n">{favorites.length || ''}</span>
      </button>
      <div class="sep"></div>
      {#each tree as f (f.id)}
        {@const current = view === 'folder' && !searching && f.id === folderId}
        <button
          type="button"
          class="node"
          class:active={current}
          class:drop={dropFolder === f.id}
          class:top={f.depth === 0}
          style:--depth={f.depth}
          aria-current={current ? 'page' : undefined}
          onclick={() => go(f.id)}
          ondragover={(e) => onFolderOver(f.id, e)}
          ondragleave={() => dropFolder === f.id && (dropFolder = null)}
          ondrop={(e) => onFolderDrop(f.id, e)}
        >
          {#if f.id === BOOKMARK_ROOT}
            <BookmarkIcon size={16} strokeWidth={1.75} aria-hidden="true" />
          {:else if current}
            <FolderOpen size={16} strokeWidth={1.75} aria-hidden="true" />
          {:else}
            <Folder size={16} strokeWidth={1.75} aria-hidden="true" />
          {/if}
          <span class="label">{f.title}</span>
          <span class="n">{counts.get(f.id) || ''}</span>
        </button>
      {/each}
    </nav>

    <section class="content" aria-labelledby="bm-heading">
      <div class="toolbar">
        <SearchInput bind:value={text} label="Search bookmarks" placeholder="Search all bookmarks" class="search" />
        <p class="summary">{formatNumber(liveCount)} {word(liveCount, 'bookmark')}</p>
      </div>

      <div class="card">
        <div class="crumbs">
          {#if searching}
            <h2 id="bm-heading" class="heading">Results for “{text.trim()}”</h2>
          {:else}
            <nav aria-label="Folder path" class="path">
              {#if view === 'folder' && chain.length}
                <button type="button" class="crumb" onclick={() => go(BOOKMARK_ROOT)}>{ROOT_LABEL}</button>
                {#each chain.slice(0, -1) as c (c.id)}
                  <ChevronRight size={14} aria-hidden="true" />
                  <button type="button" class="crumb" onclick={() => go(c.id)}>{c.title}</button>
                {/each}
                <ChevronRight size={14} aria-hidden="true" />
              {/if}
              <h2 id="bm-heading" class="heading">{folderTitle}</h2>
            </nav>
          {/if}
        </div>

        {#if loading}
          <div class="skeleton" aria-hidden="true">{#each [0, 1, 2, 3, 4] as i (i)}<Skeleton height="44px" />{/each}</div>
        {:else if !shown.length}
          {#if searching}
            <EmptyState icon={Search} title="No matches" description={`No bookmark or folder matches “${text.trim()}”.`} size="sm" />
          {:else if view === 'favorites'}
            <EmptyState icon={Star} title="No favorites yet" description="Mark a bookmark with the star to keep it on Home." size="sm" />
          {:else if folderId === BOOKMARK_ROOT && !items.length}
            <EmptyState icon={BookmarkIcon} title="No bookmarks yet" description="Bookmark pages while you browse, add one here, or import the bookmarks of another browser." size="sm">
              {#snippet actions()}
                <Button variant="primary" icon={BookmarkPlus} onclick={() => addNew('bookmark')}>Add bookmark</Button>
                <Button variant="secondary" icon={FileUp} onclick={() => (importOpen = true)}>Import…</Button>
              {/snippet}
            </EmptyState>
          {:else}
            <EmptyState icon={FolderOpen} title="This folder is empty" description="Add a bookmark here or drag one in." size="sm" />
          {/if}
        {:else}
          <ul
            class="list"
            role="list"
            ondragend={endDrag}
            ondragover={(e) => {
              // Between rows: keep the position the last row indicated.
              if (dragging && dropAt) e.preventDefault();
            }}
            ondrop={onRowDrop}
          >
            {#each shown as b (b.id)}
              {@const title = b.title || (b.url ? shortUrl(b.url) : 'Untitled')}
              <li
                class="row"
                class:dragging={dragging === b.id}
                class:drop-before={dropAt?.id === b.id && dropAt.where === 'before'}
                class:drop-after={dropAt?.id === b.id && dropAt.where === 'after'}
                class:drop-into={dropAt?.id === b.id && dropAt.where === 'into'}
                ondragover={(e) => onRowOver(b, e)}
                ondrop={onRowDrop}
              >
                <a
                  class="main"
                  href={b.kind === 'folder' ? `/bookmarks?folder=${encodeURIComponent(b.id)}` : browseLink(b.url!)}
                  draggable={!searching && view === 'folder'}
                  ondragstart={(e) => onDragStart(b, e)}
                  onclick={(e) => activate(b, e)}
                  oncontextmenu={(e) => openContextMenu(e, menu(b), { label: title })}
                >
                  {#if b.kind === 'folder'}
                    <span class="folder-tile" aria-hidden="true"><Folder size={16} strokeWidth={1.75} /></span>
                  {:else}
                    <SiteTile url={b.url!} {title} size={28} />
                  {/if}
                  <span class="text">
                    <span class="title">{title}</span>
                    {#if b.kind === 'folder'}
                      {@const n = counts.get(b.id) ?? 0}
                      <span class="sub">{n ? `${formatNumber(n)} ${word(n, 'item')}` : 'Empty folder'}</span>
                    {:else}
                      <span class="sub">{shortUrl(b.url!)}</span>
                    {/if}
                    {#if searching || view === 'favorites'}<span class="sub where">{pathOf(b)}</span>{/if}
                  </span>
                </a>
                {#if b.kind === 'bookmark'}
                  <IconButton
                    icon={Star}
                    size="sm"
                    class="star {b.favorite ? 'on' : ''}"
                    label={b.favorite ? `Remove ${title} from favorites` : `Add ${title} to favorites`}
                    pressed={b.favorite}
                    tooltip={false}
                    onclick={() => act(() => store.setFavorite(b.id, !b.favorite), 'Could not update favorites')}
                  />
                {/if}
                <IconButton icon={Ellipsis} size="sm" label="Actions for {title}" tooltip={false} onclick={(e) => openContextMenu(e, menu(b), { label: title })} />
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </section>
  </div>
</div>

<BookmarkDialog bind:open={dialogOpen} {editing} {draft} folders={tree} {forbidden} onsave={save} onclose={() => (editing = null)} />
<ImportDialog bind:open={importOpen} onimport={runImport} onclose={() => {}} />

<style>
  .library {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .layout {
    display: grid;
    grid-template-columns: 228px minmax(0, 1fr);
    gap: var(--space-6);
    align-items: start;
    margin-top: var(--space-2);
  }

  /* Folder navigation as a card (novene settings navigation, DESIGN.md §12). */
  .tree {
    position: sticky;
    top: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: calc(100vh - 160px);
    overflow-y: auto;
    padding: var(--space-2);
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-raise);
  }

  .node {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: calc(36px * var(--density));
    padding: 0 var(--space-2) 0 calc(10px + var(--depth, 0) * 14px);
    border-radius: var(--radius);
    color: var(--text-2);
    font-size: 13px;
    font-weight: 500;
    text-align: left;
    transition:
      background-color var(--t-1) var(--ease-out),
      color var(--t-1) var(--ease-out);
  }

  .node :global(svg) {
    flex: none;
    color: var(--text-3);
  }

  .node:hover {
    background: var(--hover);
    color: var(--text);
  }

  .node.active {
    color: var(--text);
    background: var(--selected);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
  }

  .node.active :global(svg),
  .node:hover :global(svg) {
    color: var(--text);
  }

  .node.drop {
    box-shadow: inset 0 0 0 1px var(--accent);
    background: var(--accent-soft);
  }

  .node .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .node .n {
    color: var(--text-3);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .node.active .n {
    color: var(--text-2);
  }

  .sep {
    height: 1px;
    margin: var(--space-1) var(--space-2);
    background: var(--hairline);
  }

  .content {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }

  .toolbar :global(.search) {
    flex: 1;
    max-width: 520px;
  }

  .summary {
    margin: 0 0 0 auto;
    color: var(--text-3);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }

  /* The folder's contents sit in one glass card; rows are separated by hairlines. */
  .card {
    background: var(--glass-bg-card);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-xl);
    box-shadow: var(--glass-inset), var(--shadow-raise);
    padding-bottom: var(--space-2);
  }

  .crumbs {
    padding: var(--space-4) var(--space-4) var(--space-3);
  }

  .path {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-1);
    color: var(--text-3);
  }

  .crumb {
    color: var(--text-2);
    font-size: var(--text-sm);
    font-weight: 500;
    border-radius: var(--radius-sm);
    padding: 2px 4px;
  }

  .crumb:hover {
    color: var(--text);
    background: var(--hover);
  }

  .heading {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: var(--text-lg);
    letter-spacing: var(--tracking-heading);
    color: var(--text);
  }

  .skeleton {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 0 var(--space-4) var(--space-2);
  }

  .list {
    margin: 0;
    padding: 0 var(--space-2);
    list-style: none;
  }

  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: 0 var(--space-2);
    border-radius: var(--radius);
    min-height: calc(48px * var(--density));
    transition: background-color var(--t-1) var(--ease-out);
  }

  .row + .row::before {
    content: '';
    position: absolute;
    top: 0;
    left: calc(var(--space-2) + 28px + var(--space-3));
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
  .row:focus-within + .row::before {
    opacity: 0;
  }

  .row.dragging {
    opacity: 0.45;
  }

  .row.drop-before::after,
  .row.drop-after::after {
    content: '';
    position: absolute;
    left: var(--space-2);
    right: var(--space-2);
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
  }

  .row.drop-before::after {
    top: -1px;
  }

  .row.drop-after::after {
    bottom: -1px;
  }

  .row.drop-into {
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent);
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

  .folder-tile {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    flex: none;
    border-radius: calc(var(--radius) - 2px);
    color: var(--text);
    background: var(--selected);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
  }

  .text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .title,
  .sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title {
    color: var(--text);
    font-size: 13.5px;
    font-weight: 500;
  }

  .sub {
    color: var(--text-3);
    font-size: var(--text-sm);
  }

  .sub.where {
    font-size: var(--text-xs);
  }

  .row :global(.star) {
    opacity: 0;
    transition: opacity var(--t-1) var(--ease-out);
  }

  .row:hover :global(.star),
  .row:focus-within :global(.star),
  .row :global(.star.on) {
    opacity: 1;
  }

  .row :global(.star.on) {
    color: var(--accent);
    background: transparent;
    box-shadow: none;
  }

  .row :global(.star.on svg) {
    fill: currentColor;
  }

  @media (max-width: 759px) {
    .layout {
      grid-template-columns: 1fr;
      gap: var(--space-4);
    }

    .tree {
      position: static;
      flex-direction: row;
      overflow-x: auto;
      max-height: none;
      padding: 0 0 var(--space-1);
      gap: var(--space-1);
    }

    .tree .node:not(.active):not(.top):not(:first-child) {
      display: none;
    }

    .tree .sep {
      display: none;
    }

    .tree {
      background: none;
      border: 0;
      box-shadow: none;
      border-radius: 0;
    }

    .node {
      flex: none;
      padding: 0 var(--space-3);
      border: 1px solid var(--hairline-strong);
      border-radius: var(--radius-pill);
    }

    .node.active {
      border-color: transparent;
    }

    .node .n {
      display: none;
    }

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
      display: none;
    }

    .row :global(.star) {
      opacity: 1;
    }
  }

  @media (pointer: coarse) {
    .row :global(.star) {
      opacity: 1;
    }
  }
</style>
