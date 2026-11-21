<!--
  Editable quick links (stored in IndexedDB kv "home.quickLinks"). Click opens through the BrowserBridge;
  right-click / ContextMenu key for open-in-tab, edit, reorder and remove; tiles can also be dragged to reorder.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Copy from '@lucide/svelte/icons/copy';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Plus from '@lucide/svelte/icons/plus';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import IconButton from '../../components/IconButton.svelte';
  import Menu from '../../components/Menu.svelte';
  import type { MenuItem } from '../../components/menu';
  import { tooltip } from '../../components/tooltip.svelte';
  import { openContextMenu } from '../../app/overlays/contextmenu.svelte';
  import { confirm } from '../../app/overlays/dialogs.svelte';
  import { toast } from '../../app/overlays/toast.svelte';
  import { browseLink, openUrl } from '../../browser/bridge';
  import { displayUrl } from '../../lib/url';
  import { defaultQuickLinks, initialQuickLinks, loadQuickLinks, MAX_QUICK_LINKS, newQuickLink, saveQuickLinks, type QuickLink } from './data';
  import Monogram from './Monogram.svelte';
  import QuickLinkDialog from './QuickLinkDialog.svelte';

  // Rendered from the synchronous mirror in the first frame (no layout shift); IndexedDB confirms or corrects it.
  let links = $state<QuickLink[]>(initialQuickLinks());
  let storageOk = $state(true);
  let dialogOpen = $state(false);
  let dialogMode = $state<'add' | 'edit'>('add');
  let editing = $state<QuickLink | null>(null);
  let dragIndex = $state<number | null>(null);
  let dropIndex = $state<number | null>(null);

  onMount(() => {
    void loadQuickLinks().then((r) => {
      const same = r.links.length === links.length && r.links.every((l, i) => l.id === links[i]?.id && l.title === links[i]?.title && l.url === links[i]?.url);
      if (!same) links = r.links;
      storageOk = r.available;
    });
  });

  async function persist(next: QuickLink[]): Promise<boolean> {
    links = next;
    try {
      await saveQuickLinks($state.snapshot(next));
      return true;
    } catch {
      storageOk = false;
      toast.error('Quick links were not saved', { description: 'Local storage is unavailable in this browser session.' });
      return false;
    }
  }

  function open(link: QuickLink, ev?: MouseEvent): void {
    const newTab = !!ev && (ev.ctrlKey || ev.metaKey || ev.button === 1);
    void openUrl(link.url, { newTab, background: newTab && !ev?.shiftKey });
  }

  function move(index: number, to: number): void {
    if (to < 0 || to >= links.length || to === index) return;
    const next = [...links];
    const [item] = next.splice(index, 1);
    if (item) next.splice(to, 0, item);
    void persist(next);
  }

  async function remove(index: number): Promise<void> {
    const before = [...links];
    const removed = links[index];
    if (!removed) return;
    if (await persist(links.filter((_, i) => i !== index))) {
      toast.show({
        title: `Removed “${removed.title}”`,
        actions: [{ label: 'Undo', onClick: () => void persist(before) }],
      });
    }
  }

  function startAdd(): void {
    if (links.length >= MAX_QUICK_LINKS) {
      toast.info(`You can keep up to ${MAX_QUICK_LINKS} quick links.`);
      return;
    }
    dialogMode = 'add';
    editing = null;
    dialogOpen = true;
  }

  function startEdit(link: QuickLink): void {
    dialogMode = 'edit';
    editing = link;
    dialogOpen = true;
  }

  function save(data: { title: string; url: string }): void {
    if (dialogMode === 'edit' && editing) {
      const id = editing.id;
      void persist(links.map((l) => (l.id === id ? { ...l, ...data } : l)));
    } else {
      void persist([...links, newQuickLink(data.title, data.url)]);
    }
  }

  async function resetDefaults(): Promise<void> {
    const ok = await confirm({
      title: 'Restore default quick links?',
      message: 'Your current quick links are replaced by the defaults.',
      confirmLabel: 'Restore',
    });
    if (ok && (await persist(defaultQuickLinks()))) toast.success('Default quick links restored');
  }

  function menuFor(link: QuickLink, index: number): MenuItem[] {
    return [
      { label: 'Open', icon: ExternalLink, onSelect: () => open(link) },
      { label: 'Open in new tab', onSelect: () => void openUrl(link.url, { newTab: true }) },
      { label: 'Open in background tab', onSelect: () => void openUrl(link.url, { newTab: true, background: true }) },
      { kind: 'separator' },
      { label: 'Edit…', icon: Pencil, onSelect: () => startEdit(link) },
      { label: 'Copy address', icon: Copy, onSelect: () => void copy(link.url) },
      { kind: 'separator' },
      { label: 'Move left', icon: ArrowLeft, disabled: index === 0, onSelect: () => move(index, index - 1) },
      { label: 'Move right', icon: ArrowRight, disabled: index === links.length - 1, onSelect: () => move(index, index + 1) },
      { kind: 'separator' },
      { label: 'Remove', icon: Trash2, danger: true, onSelect: () => void remove(index) },
    ];
  }

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Address copied');
    } catch {
      toast.error('Could not copy', { description: 'Clipboard access was denied by the browser.' });
    }
  }

  const sectionMenu = $derived<MenuItem[]>([
    { label: 'Add quick link…', icon: Plus, disabled: links.length >= MAX_QUICK_LINKS, onSelect: startAdd },
    { label: 'Restore defaults…', icon: RotateCcw, onSelect: () => void resetDefaults() },
  ]);
</script>

<section class="quick" aria-label="Quick links">
  <ul class="tiles" role="list">
    {#each links as link, i (link.id)}
      <li
        class="slot"
        class:dragging={dragIndex === i}
        class:drop-before={dropIndex === i && dragIndex !== null && dragIndex > i}
        class:drop-after={dropIndex === i && dragIndex !== null && dragIndex < i}
        draggable="true"
        ondragstart={(ev) => {
          dragIndex = i;
          ev.dataTransfer?.setData('text/plain', link.url);
          if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
        }}
        ondragover={(ev) => {
          if (dragIndex === null) return;
          ev.preventDefault();
          dropIndex = i;
        }}
        ondragleave={() => {
          if (dropIndex === i) dropIndex = null;
        }}
        ondrop={(ev) => {
          ev.preventDefault();
          if (dragIndex !== null) move(dragIndex, i);
          dragIndex = null;
          dropIndex = null;
        }}
        ondragend={() => {
          dragIndex = null;
          dropIndex = null;
        }}
      >
        <a
          class="tile"
          href={browseLink(link.url)}
          draggable="false"
          onclick={(ev) => {
            if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
            ev.preventDefault();
            open(link, ev);
          }}
          oncontextmenu={(ev) => openContextMenu(ev, menuFor(link, i), { label: link.title })}
          {@attach tooltip({ text: displayUrl(link.url), placement: 'bottom', delay: 700, describe: true })}
        >
          <Monogram url={link.url} title={link.title} size={44} glass class="tile-icon" />
          <span class="label">{link.title}</span>
        </a>
      </li>
    {/each}
    {#if links.length < MAX_QUICK_LINKS}
      <li class="slot">
        <button type="button" class="tile add" onclick={startAdd} disabled={!storageOk}>
          <span class="add-icon" aria-hidden="true"><Plus size={17} strokeWidth={1.75} /></span>
          <span class="label">Add link</span>
        </button>
      </li>
    {/if}
  </ul>
  <div class="options">
    <Menu items={sectionMenu} label="Quick link options" placement="bottom-end">
      {#snippet trigger(props)}
        <IconButton {...props} icon={Ellipsis} label="Quick link options" size="sm" tooltipPlacement="bottom" />
      {/snippet}
    </Menu>
  </div>
</section>

<QuickLinkDialog bind:open={dialogOpen} mode={dialogMode} initial={editing} onsave={save} />

<style>
  .quick {
    position: relative;
    width: 100%;
  }

  .tiles {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 4px 2px;
    margin: 0;
    padding: 0;
  }

  .slot {
    position: relative;
  }

  .slot.dragging {
    opacity: 0.4;
  }

  .slot.drop-before::before,
  .slot.drop-after::after {
    content: '';
    position: absolute;
    top: 8px;
    bottom: 26px;
    width: 2px;
    border-radius: 2px;
    background: var(--accent);
  }

  .slot.drop-before::before {
    left: -2px;
  }

  .slot.drop-after::after {
    right: -2px;
  }

  .tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    width: 84px;
    padding: 6px 2px 4px;
    border-radius: var(--radius-lg);
    /* Home sets --home-label to the primary text color over a backdrop the user supplied. */
    color: var(--home-label, var(--text-2));
    text-decoration: none;
    transition: color var(--t-1) var(--ease-out);
  }

  .tile :global(.tile-icon),
  .add-icon {
    transition:
      transform var(--t-2) var(--ease-out),
      background-color var(--t-1) var(--ease-out),
      box-shadow var(--t-1) var(--ease-out),
      border-color var(--t-1) var(--ease-out),
      color var(--t-1) var(--ease-out);
  }

  .tile:hover {
    color: var(--text);
  }

  .tile:hover :global(.tile-icon) {
    transform: translateY(calc(-2px * var(--motion-move)));
    background: color-mix(in oklab, var(--surface-3) 92%, transparent);
    box-shadow:
      inset 0 0 0 1px color-mix(in oklab, var(--text) 26%, transparent),
      var(--glass-inset),
      0 14px 28px -14px rgba(0, 0, 0, 0.75);
  }

  .tile:active :global(.tile-icon) {
    transform: scale(var(--press-scale));
  }

  .tile:focus-visible {
    outline-offset: 0;
  }

  .label {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
    font-weight: 500;
    line-height: 1.3;
  }

  /* Labels sit on the backdrop: a faint shadow keeps them crisp over bright spots of a picture. */
  :global(.theme-dark) .label {
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
  }

  .add-icon {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: var(--radius-lg);
    border: 1px dashed color-mix(in oklab, var(--text) 26%, transparent);
    background: color-mix(in oklab, var(--bg) 40%, transparent);
    color: var(--home-label, var(--text-2));
  }

  .tile.add {
    color: var(--home-label, var(--text-2));
  }

  .tile.add:hover .add-icon {
    border-color: color-mix(in oklab, var(--text) 50%, transparent);
    color: var(--text);
    transform: translateY(calc(-2px * var(--motion-move)));
  }

  .tile.add:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .tile.add:disabled .add-icon {
    transform: none;
  }

  /* Phones: four tiles per row (seven tiles wrap 4 + 3 instead of 3 + 3 + 1). */
  @media (max-width: 480px) {
    .tile {
      width: 78px;
    }
  }

  /* Section options: to the right of the tiles on wide screens, under the row's right end on narrow ones. */
  .options {
    position: absolute;
    top: 14px;
    right: -36px;
    opacity: 0;
    transition: opacity var(--t-2) var(--ease-out);
  }

  /* Narrow screens: centered under the tiles (an anchored part of the group, not a stray button off to the side). */
  @media (max-width: 759px) {
    .options {
      position: static;
      display: flex;
      justify-content: center;
      margin-top: 2px;
    }
  }

  /* The button sits straight on the backdrop: one step brighter than a ghost button's idle color. */
  .options :global(.icon-btn) {
    color: var(--home-label, var(--text-2));
  }

  .quick:hover .options,
  .quick:focus-within .options {
    opacity: 1;
  }

  @media (hover: none) {
    .options {
      opacity: 1;
    }
  }
</style>
