<!--
  Navigation rail (DESIGN.md §11.4), below the toolbar: search (command palette), the main destinations in clusters,
  then Settings, About and the collapse toggle at the bottom. Compact (default) is the slim icon rail with tooltips;
  expanded is the same rail at 212px with labels; overlay is the hidden rail revealed as a floating glass panel.
  The current item is a white tint in a rounded square (monochrome; no accent). The account entry lives in the
  toolbar's avatar and the VPN status in the tab strip's chip.
-->
<script lang="ts">
  import PanelLeftClose from '@lucide/svelte/icons/panel-left-close';
  import PanelLeftOpen from '@lucide/svelte/icons/panel-left-open';
  import PanelRightClose from '@lucide/svelte/icons/panel-right-close';
  import PanelRightOpen from '@lucide/svelte/icons/panel-right-open';
  import Search from '@lucide/svelte/icons/search';
  import Icon from '../components/Icon.svelte';
  import Kbd from '../components/Kbd.svelte';
  import type { MenuItem } from '../components/menu';
  import { tooltip } from '../components/tooltip.svelte';
  import type { Settings } from '../settings/schema';
  import { settings } from '../settings/store.svelte';
  import { openContextMenu } from './overlays/contextmenu.svelte';
  import { router } from './router.svelte';
  import { navRoutes, pathFor, type RouteDef, type RouteNav } from './routes';
  import { shell } from './shell.svelte';

  interface Props {
    mode: 'expanded' | 'compact' | 'overlay';
    side: 'left' | 'right';
    onnavigate?: () => void;
  }

  let { mode, side, onnavigate }: Props = $props();

  const expanded = $derived(mode !== 'compact');
  const tipSide = $derived(side === 'left' ? 'right' : 'left');
  const main = $derived(navRoutes('main'));
  const bottom = $derived(navRoutes('bottom'));
  function clusters(routes: Array<RouteDef & { nav: RouteNav }>): Array<Array<RouteDef & { nav: RouteNav }>> {
    const out: Array<Array<RouteDef & { nav: RouteNav }>> = [];
    let last = -1;
    for (const r of routes) {
      const c = Math.floor(r.nav.order / 100);
      if (c !== last) out.push([]);
      out[out.length - 1]!.push(r);
      last = c;
    }
    return out;
  }

  const SIDEBAR_MODES: ReadonlyArray<{ value: Settings['appearance']['sidebar']; label: string }> = [
    { value: 'auto', label: 'Automatic' },
    { value: 'expanded', label: 'Expanded' },
    { value: 'compact', label: 'Compact' },
    { value: 'hidden', label: 'Hidden' },
  ];

  /** Right-click (or the ContextMenu key / Shift+F10) anywhere on the rail: sidebar mode and position. */
  function onContextMenu(ev: MouseEvent): void {
    const a = settings.value.appearance;
    const link = (ev.target as Element | null)?.closest?.('a[href]');
    const items: MenuItem[] = [];
    if (link instanceof HTMLAnchorElement) {
      // Replaces the browser's link menu, so keep its most useful entry.
      items.push(
        { label: 'Open in new browser tab', onSelect: () => void window.open(link.href, '_blank', 'noopener') },
        { kind: 'separator' },
      );
    }
    items.push(
      { kind: 'label', label: 'Sidebar' },
      ...SIDEBAR_MODES.map(
        (m): MenuItem => ({
          kind: 'radio',
          label: m.label,
          checked: a.sidebar === m.value,
          onSelect: () => void settings.set('appearance', 'sidebar', m.value),
        }),
      ),
      { kind: 'separator' },
      {
        kind: 'submenu',
        label: 'Position',
        items: (['left', 'right'] as const).map(
          (side): MenuItem => ({
            kind: 'radio',
            label: side === 'left' ? 'Left' : 'Right',
            checked: a.sidebarPosition === side,
            onSelect: () => void settings.set('appearance', 'sidebarPosition', side),
          }),
        ),
      },
      { kind: 'separator' },
      { label: 'Search and commands', shortcut: 'commandPalette', onSelect: () => shell.openPalette() },
    );
    openContextMenu(ev, items, { label: 'Sidebar options' });
  }

  function toggleCollapse(): void {
    settings.set('appearance', 'sidebar', expanded ? 'compact' : 'expanded');
  }

  const collapseIcon = $derived(
    side === 'left' ? (expanded ? PanelLeftClose : PanelLeftOpen) : expanded ? PanelRightClose : PanelRightOpen,
  );
</script>

{#snippet item(r: RouteDef & { nav: RouteNav })}
  {@const active = router.isActive(r.id)}
  <li>
    <a
      href={pathFor(r.id)}
      class="item"
      aria-current={active ? 'page' : undefined}
      onclick={() => onnavigate?.()}
      {@attach tooltip({
        text: r.nav.label,
        placement: tipSide,
        disabled: expanded,
        ...(r.nav.shortcut ? { action: r.nav.shortcut } : {}),
      })}
    >
      <Icon icon={r.nav.icon} size={17} />
      <span class="label">{r.nav.label}</span>
    </a>
  </li>
{/snippet}

<nav class="rail {mode} {side}" aria-label="Primary" oncontextmenu={onContextMenu}>
  <!-- Named by its visible text ("Search" + the shortcut), so speech-input users can say what they see. -->
  <button
    type="button"
    class="item search"
    onclick={() => shell.openPalette()}
    aria-haspopup="dialog"
    {@attach tooltip({ text: 'Search and commands', placement: tipSide, disabled: expanded, action: 'commandPalette' })}
  >
    <Icon icon={Search} size={17} />
    <span class="label">Search</span>
    <span class="search-kbd"><Kbd action="commandPalette" /></span>
  </button>

  <div class="scroll">
    {#each clusters(main) as cluster, i (i)}
      <ul class="items" role="list">
        {#each cluster as r (r.id)}{@render item(r)}{/each}
      </ul>
    {/each}
  </div>

  <div class="bottom">
    <ul class="items" role="list">
      {#each bottom as r (r.id)}{@render item(r)}{/each}
    </ul>
    {#if mode !== 'overlay'}
      <button
        type="button"
        class="item collapse"
        onclick={toggleCollapse}
        aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
        {@attach tooltip({ text: expanded ? 'Collapse sidebar' : 'Expand sidebar', placement: tipSide, disabled: expanded, action: 'toggleSidebar' })}
      >
        <Icon icon={collapseIcon} size={17} />
        <span class="label">Collapse</span>
      </button>
    {/if}
  </div>
</nav>

<style>
  .rail {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
    width: var(--rail-w);
    padding: 11px 9px;
    background: var(--chrome-bg);
    -webkit-backdrop-filter: var(--chrome-filter);
    backdrop-filter: var(--chrome-filter);
    user-select: none;
  }

  .rail.left {
    border-right: 1px solid var(--hairline);
  }

  .rail.right {
    border-left: 1px solid var(--hairline);
  }

  .expanded,
  .overlay {
    --rail-w: var(--rail-w-expanded);
    padding: 11px 10px;
  }

  .compact {
    --rail-w: var(--rail-w-compact);
    align-items: center;
  }

  .overlay {
    height: 100%;
    background: var(--glass-bg-dense);
    -webkit-backdrop-filter: var(--glass-filter);
    backdrop-filter: var(--glass-filter);
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-xl);
    box-shadow: var(--glass-inset);
  }

  .scroll {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
    margin: -3px;
    padding: 3px;
  }

  .compact .scroll {
    align-items: center;
  }

  .items {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin: 0;
    padding: 0;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 11px;
    width: 100%;
    height: calc(36px * var(--density));
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text-3);
    font: inherit;
    font-size: 0.9286rem;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    transition:
      color var(--t-1) var(--ease-out),
      background-color var(--t-1) var(--ease-out),
      box-shadow var(--t-1) var(--ease-out);
  }

  .expanded .item,
  .overlay .item {
    color: var(--text-2);
  }

  .item:hover {
    color: var(--text);
    background: var(--hover);
  }

  .item[aria-current='page'] {
    color: var(--text);
    background: var(--selected);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
  }

  .compact .item {
    justify-content: center;
    width: var(--rail-item);
    height: var(--rail-item);
    padding: 0;
  }

  .compact .label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
  }

  .search-kbd {
    flex: none;
  }

  .compact .search-kbd {
    display: none;
  }

  .bottom {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .compact .bottom {
    align-items: center;
  }

  /* Touch screens (tablets show the rail): rows of at least 40px (DESIGN.md §1.6). */
  @media (pointer: coarse) {
    .item {
      height: max(40px, calc(36px * var(--density)));
    }
  }
</style>
