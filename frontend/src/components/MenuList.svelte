<!--
  A menu surface (role="menu") with roving focus, typeahead, checkable items, shortcut hints and nested submenus.
  Used by <Menu> (dropdowns) and the app-wide context menu host. Each level lives in the top layer.

  Keys: ↑↓ Home End move · Enter/Space activate · → opens a submenu · ← / Esc close a submenu · Esc closes the menu ·
  Tab closes everything · letters jump to items.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { autoPosition, positionAtPoint, topLayer } from './floating';
  import { createTypeahead, matchTypeahead } from './focus';
  import { popIn } from './motion';
  import { ariaKeyShortcut } from '../lib/keys';
  import { isApplePlatform } from '../lib/platform';
  import { CLOSE_MENUS_EVENT, isInteractive, resolveShortcut, type MenuAnchor, type MenuCloseReason, type MenuItem } from './menu';
  import Icon from './Icon.svelte';
  import Kbd from './Kbd.svelte';
  import MenuList from './MenuList.svelte';

  interface Props {
    items: readonly MenuItem[];
    anchor: MenuAnchor;
    label?: string;
    id?: string;
    /** Where focus goes when the menu opens. */
    autofocus?: 'first' | 'last' | 'menu';
    /** Nesting level (0 = root). */
    level?: number;
    onclose: (reason: MenuCloseReason) => void;
    /** Submenus tell their parent when the pointer enters them (keeps them open). */
    onpointerenter?: () => void;
  }

  let { items, anchor, label, id, autofocus = 'menu', level = 0, onclose, onpointerenter }: Props = $props();

  let menuEl = $state<HTMLDivElement>();
  let itemEls: HTMLElement[] = $state([]);
  let focused = $state(-1);
  let submenuIndex = $state<number | null>(null);
  let submenuFocus = $state<'first' | 'menu'>('first');
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  const typeahead = createTypeahead();
  const uid = $props.id();
  const apple = isApplePlatform();

  const checkable = $derived(items.some((i) => i.kind === 'checkbox' || i.kind === 'radio'));
  /** When some items have icons, every item reserves the icon column so labels line up. */
  const hasIcons = $derived(items.some((i) => isInteractive(i) && !!i.icon));
  const labels = $derived(items.map((i) => (isInteractive(i) ? i.label : '')));

  function interactiveIndex(i: number): boolean {
    const item = items[i];
    return !!item && isInteractive(item);
  }

  function focusItem(i: number): void {
    if (!interactiveIndex(i)) return;
    focused = i;
    itemEls[i]?.focus({ preventScroll: false });
  }

  function step(from: number, dir: 1 | -1): number {
    const n = items.length;
    for (let k = 1; k <= n; k++) {
      const i = (((from + dir * k) % n) + n) % n;
      if (interactiveIndex(i)) return i;
    }
    return from;
  }

  function openSubmenu(i: number, focus: 'first' | 'menu'): void {
    const item = items[i];
    if (!item || item.kind !== 'submenu' || item.disabled) return;
    submenuFocus = focus;
    submenuIndex = i;
  }

  function closeSubmenu(refocus: boolean): void {
    const i = submenuIndex;
    submenuIndex = null;
    if (refocus && i !== null) focusItem(i);
  }

  function activate(i: number, viaKeyboard: boolean): void {
    const item = items[i];
    if (!item || !isInteractive(item) || item.disabled) return;
    switch (item.kind) {
      case 'submenu':
        openSubmenu(i, viaKeyboard ? 'first' : 'menu');
        return;
      case 'checkbox':
        item.onToggle?.(!item.checked);
        if (!item.keepOpen) onclose('select');
        return;
      case 'radio':
        item.onSelect?.();
        if (!item.keepOpen) onclose('select');
        return;
      default:
        item.onSelect?.();
        if (!item.keepOpen) onclose('select');
    }
  }

  function onKeydown(ev: KeyboardEvent): void {
    // Events from nested submenus bubble through this element; let each level handle its own keys.
    if ((ev.target as HTMLElement | null)?.closest('[role="menu"]') !== menuEl) return;
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        focusItem(step(focused, 1));
        break;
      case 'ArrowUp':
        ev.preventDefault();
        focusItem(step(focused < 0 ? items.length : focused, -1));
        break;
      case 'Home':
        ev.preventDefault();
        focusItem(step(-1, 1));
        break;
      case 'End':
        ev.preventDefault();
        focusItem(step(items.length, -1));
        break;
      case 'ArrowRight':
        if (focused >= 0 && items[focused]?.kind === 'submenu') {
          ev.preventDefault();
          openSubmenu(focused, 'first');
        }
        break;
      case 'ArrowLeft':
        if (level > 0) {
          ev.preventDefault();
          onclose('back');
        }
        break;
      case 'Enter':
      case ' ':
        ev.preventDefault();
        if (focused >= 0) activate(focused, true);
        break;
      case 'Escape':
        ev.preventDefault();
        ev.stopPropagation();
        onclose(level > 0 ? 'back' : 'escape');
        break;
      case 'Tab':
        ev.preventDefault();
        onclose('tab');
        break;
      default: {
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        const q = typeahead(ev.key);
        if (q) {
          const i = matchTypeahead(labels, q, focused, interactiveIndex);
          if (i >= 0) focusItem(i);
        }
      }
    }
  }

  function onItemPointerMove(i: number): void {
    if (focused !== i) focusItem(i);
    if (hoverTimer) clearTimeout(hoverTimer);
    const item = items[i];
    if (item?.kind === 'submenu' && !item.disabled) {
      if (submenuIndex !== i) hoverTimer = setTimeout(() => openSubmenu(i, 'menu'), 90);
    } else if (submenuIndex !== null) {
      hoverTimer = setTimeout(() => closeSubmenu(false), 220);
    }
  }

  function place(node: HTMLElement): () => void {
    if (anchor.kind === 'point') {
      const update = (): void => {
        const p = positionAtPoint({ x: anchor.x, y: anchor.y }, { width: node.offsetWidth, height: node.offsetHeight });
        node.style.left = `${p.x}px`;
        node.style.top = `${p.y}px`;
      };
      update();
      const ro = new ResizeObserver(update);
      ro.observe(node);
      return () => ro.disconnect();
    }
    return autoPosition(anchor.element, node, anchor.placement ?? (level > 0 ? 'right-start' : 'bottom-start'), {
      offset: level > 0 ? -2 : 4,
    });
  }

  onMount(() => {
    if (autofocus === 'first') focusItem(step(-1, 1));
    else if (autofocus === 'last') focusItem(step(items.length, -1));
    else menuEl?.focus({ preventScroll: true });

    if (level > 0) return;
    const onDown = (ev: PointerEvent): void => {
      if (!menuEl?.contains(ev.target as Node)) onclose('outside');
    };
    const onBlur = (): void => onclose('outside');
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    window.addEventListener(CLOSE_MENUS_EVENT, onBlur);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
      window.removeEventListener(CLOSE_MENUS_EVENT, onBlur);
      if (hoverTimer) clearTimeout(hoverTimer);
    };
  });
</script>

<div
  bind:this={menuEl}
  {id}
  class="menu"
  class:checkable
  role="menu"
  tabindex="-1"
  aria-label={label}
  aria-orientation="vertical"
  onkeydown={onKeydown}
  onpointerenter={() => onpointerenter?.()}
  oncontextmenu={(ev) => ev.preventDefault()}
  {@attach topLayer}
  {@attach place}
  in:popIn={{ duration: 120, scale: 0.97, origin: anchor.kind === 'point' ? 'top left' : 'top center' }}
>
  {#each items as item, i (i)}
    {#if item.kind === 'separator'}
      <div class="sep" role="separator"></div>
    {:else if item.kind === 'label'}
      <div class="group-label eyebrow" role="presentation">{item.label}</div>
    {:else}
      {@const shortcut = resolveShortcut(item.shortcut)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        bind:this={itemEls[i]}
        id="{uid}-item-{i}"
        class="item"
        class:danger={item.kind === undefined || item.kind === 'item' ? !!item.danger : false}
        class:open={submenuIndex === i}
        role={item.kind === 'checkbox' ? 'menuitemcheckbox' : item.kind === 'radio' ? 'menuitemradio' : 'menuitem'}
        tabindex="-1"
        aria-disabled={item.disabled ? 'true' : undefined}
        aria-checked={item.kind === 'checkbox' || item.kind === 'radio' ? item.checked : undefined}
        aria-haspopup={item.kind === 'submenu' ? 'menu' : undefined}
        aria-expanded={item.kind === 'submenu' ? submenuIndex === i : undefined}
        aria-keyshortcuts={shortcut ? ariaKeyShortcut(shortcut, apple) || undefined : undefined}
        onpointermove={() => onItemPointerMove(i)}
        onclick={() => activate(i, false)}
        onfocus={() => (focused = i)}
      >
        {#if checkable}
          <span class="check" aria-hidden="true">
            {#if (item.kind === 'checkbox' || item.kind === 'radio') && item.checked}
              {#if item.kind === 'radio'}<span class="radio-dot"></span>{:else}<Check size={14} strokeWidth={2.25} />{/if}
            {/if}
          </span>
        {/if}
        {#if item.icon}<Icon icon={item.icon} size={16} class="item-icon" />{:else if hasIcons}<span class="icon-slot" aria-hidden="true"></span>{/if}
        <span class="label">{item.label}</span>
        {#if shortcut}<Kbd combo={shortcut} class="item-kbd" />{/if}
        {#if item.kind === 'submenu'}<span class="chev" aria-hidden="true"><ChevronRight size={14} strokeWidth={1.75} /></span>{/if}
      </div>
      {#if item.kind === 'submenu' && submenuIndex === i && itemEls[i]}
        <MenuList
          items={item.items}
          anchor={{ kind: 'element', element: itemEls[i]!, placement: 'right-start' }}
          label={item.label}
          level={level + 1}
          autofocus={submenuFocus}
          onpointerenter={() => {
            if (hoverTimer) clearTimeout(hoverTimer);
          }}
          onclose={(reason) => {
            if (reason === 'back') closeSubmenu(true);
            else onclose(reason);
          }}
        />
      {/if}
    {/if}
  {/each}
</div>

<style>
  /* DESIGN.md §10 Menu: dense glass, a strong hairline, the lg radius, 6px inset; items in a concentric radius,
     monochrome hover (--hover) and keyboard focus (--selected + ring); the accent only marks a checked choice. */
  .menu {
    position: fixed;
    min-width: 220px;
    max-width: 340px;
    max-height: calc(100dvh - 16px);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 6px;
    border-radius: var(--radius-lg);
    background: var(--glass-bg-dense);
    -webkit-backdrop-filter: var(--glass-filter);
    backdrop-filter: var(--glass-filter);
    border: 1px solid var(--glass-border);
    box-shadow: var(--glass-inset), var(--shadow-pop);
    outline: none;
    font-size: 0.9286rem; /* 13px */
    user-select: none;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: var(--item-h);
    padding: 0 10px;
    border-radius: max(4px, calc(var(--radius-lg) - 6px));
    color: var(--text);
    font-weight: 500;
    cursor: default;
    outline: none;
    white-space: nowrap;
    transition: background-color var(--t-1) var(--ease-out);
  }

  .item:focus,
  .item.open {
    background: var(--hover);
  }

  .item:focus-visible,
  .item.open {
    background: var(--selected);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
  }

  .item[aria-disabled='true'] {
    opacity: 0.42;
  }

  .item.danger {
    color: var(--danger);
  }

  .item.danger:focus,
  .item.danger:focus-visible {
    background: var(--danger-soft);
    box-shadow: none;
  }

  :global(.item-icon) {
    color: var(--text-3);
    transition: color var(--t-1) var(--ease-out);
  }

  .item:focus :global(.item-icon),
  .item.open :global(.item-icon) {
    color: var(--text);
  }

  .danger :global(.item-icon),
  .danger:focus :global(.item-icon) {
    color: var(--danger);
  }

  .icon-slot {
    width: 16px;
    flex: none;
  }

  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Shortcuts read as quiet mono hints, not keycaps (DESIGN.md §10 Menu). */
  .item :global(.item-kbd) {
    margin-left: var(--space-4);
    color: var(--text-3);
  }

  .item :global(.item-kbd .cap) {
    min-width: 0;
    height: auto;
    padding: 0;
    border: 0;
    background: none;
  }

  .check {
    display: grid;
    place-items: center;
    width: 14px;
    flex: none;
    color: var(--accent);
  }

  .radio-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }

  .chev {
    display: grid;
    margin-right: -2px;
    color: var(--text-3);
  }

  .sep {
    height: 1px;
    margin: 6px 4px;
    background: var(--hairline);
  }

  .group-label {
    padding: 8px 10px 4px;
  }
</style>
