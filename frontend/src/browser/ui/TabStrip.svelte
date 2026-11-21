<!--
  Tab strip (DESIGN.md §11.2: 38px, on every route): the GNOME mark (Home) at the start, pinned tabs as icons, then
  borderless tabs with favicon (or spinner), title and close ×, the new-tab button and, at the end, the VPN chip.
  Drag to reorder, middle-click or Delete to close, right-click (or the context-menu key) for tab actions, arrow keys
  move between tabs. On GNOME's other pages the active tab is drawn "selected but not in view"; choosing a tab opens
  the browser view with it.
-->
<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy';
  import Globe from '@lucide/svelte/icons/globe';
  import History from '@lucide/svelte/icons/history';
  import Pin from '@lucide/svelte/icons/pin';
  import PinOff from '@lucide/svelte/icons/pin-off';
  import Plus from '@lucide/svelte/icons/plus';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import X from '@lucide/svelte/icons/x';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import Spinner from '../../components/Spinner.svelte';
  import { tooltip } from '../../components/tooltip.svelte';
  import type { MenuItem } from '../../components/menu';
  import Logo from '../../components/Logo.svelte';
  import { openContextMenu } from '../../app/overlays/contextmenu.svelte';
  import { navigate, router } from '../../app/router.svelte';
  import { pathFor, routeTitle } from '../../app/routes';
  import { getStatus } from '../../app/status';
  import { displayUrl } from '../../lib/url';
  import { browser } from '../browser.svelte';
  import { faviconOf, titleOf } from './util';
  import type { Tab } from '../tabs.svelte';

  interface Props {
    /** The browser view is the visible route (otherwise the active tab is selected but not in view). */
    onBrowser?: boolean;
  }
  let { onBrowser = true }: Props = $props();

  const tabs = $derived(browser.model.tabs);
  const vpn = $derived(getStatus('vpn'));
  const vpnTone = $derived(
    vpn?.state === 'ok' ? 'success' : vpn?.state === 'degraded' || vpn?.state === 'starting' ? 'warning' : vpn?.state === 'down' ? 'danger' : 'neutral',
  );

  /** Shows a tab: activates it and, from another GNOME page, opens the browser view. */
  function show(id: number): void {
    browser.activate(id);
    if (!onBrowser) void navigate('/browse');
  }
  const activeId = $derived(browser.model.activeId);

  /**
   * The GNOME page in view (Home, Games, Settings…): drawn as the current tab at the end of the strip while it is
   * shown, so the strip always says what the window is showing. Not a control: pages are routes, not browser tabs.
   */
  const pageTab = $derived.by(() => {
    const r = router.current;
    if (onBrowser || !r) return null;
    return { title: routeTitle(r.route, r.params), icon: r.route.nav?.icon ?? null };
  });

  let dragId = $state<number | null>(null);
  let dropIndex = $state<number | null>(null);
  let strip = $state<HTMLElement>();

  function menuFor(t: Tab): MenuItem[] {
    const i = browser.model.indexOf(t.id);
    const right = tabs.slice(i + 1).map((x) => x.id);
    const others = tabs.filter((x) => x.id !== t.id && !x.pinned).map((x) => x.id);
    return [
      { label: 'New tab', icon: Plus, shortcut: 'newTab', onSelect: () => browser.newTab() },
      { kind: 'separator' },
      { label: 'Reload', icon: RotateCw, disabled: !t.url, onSelect: () => browser.reload(t.id) },
      { label: 'Duplicate', icon: Copy, shortcut: 'duplicateTab', onSelect: () => browser.duplicate(t.id) },
      { label: t.pinned ? 'Unpin' : 'Pin', icon: t.pinned ? PinOff : Pin, shortcut: 'pinTab', onSelect: () => browser.togglePin(t.id) },
      { kind: 'separator' },
      { label: 'Close tab', icon: X, shortcut: 'closeTab', onSelect: () => browser.close(t.id) },
      { label: 'Close other tabs', disabled: others.length === 0, onSelect: () => void browser.closeMany(others) },
      { label: 'Close tabs to the right', disabled: right.length === 0, onSelect: () => void browser.closeMany(right) },
      { kind: 'separator' },
      { label: 'Reopen closed tab', icon: History, shortcut: 'reopenClosedTab', disabled: browser.model.closed.length === 0, onSelect: () => browser.reopenClosed() },
    ];
  }

  function onKey(ev: KeyboardEvent, t: Tab): void {
    const i = browser.model.indexOf(t.id);
    let next: Tab | undefined;
    if (ev.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    else if (ev.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (ev.key === 'Home') next = tabs[0];
    else if (ev.key === 'End') next = tabs.at(-1);
    else if (ev.key === 'Delete') {
      ev.preventDefault();
      browser.close(t.id);
      return;
    } else if ((ev.key === 'Enter' || ev.key === ' ') && !onBrowser) {
      ev.preventDefault();
      show(t.id);
      return;
    }
    if (!next) return;
    ev.preventDefault();
    browser.activate(next.id);
    queueMicrotask(() => strip?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus());
  }

  function onDragStart(ev: DragEvent, t: Tab): void {
    dragId = t.id;
    ev.dataTransfer?.setData('text/plain', t.url ?? '');
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  }

  function onDragOver(ev: DragEvent, i: number): void {
    if (dragId === null) return;
    ev.preventDefault();
    const el = ev.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    dropIndex = ev.clientX > r.left + r.width / 2 ? i + 1 : i;
  }

  function onDrop(ev: DragEvent): void {
    if (dragId === null || dropIndex === null) return;
    ev.preventDefault();
    const from = browser.model.indexOf(dragId);
    browser.model.move(dragId, dropIndex > from ? dropIndex - 1 : dropIndex);
    dragId = null;
    dropIndex = null;
  }
</script>

<div class="strip" class:away={!onBrowser}>
  <a href="/" class="home" aria-label="Home" {@attach tooltip({ text: 'Home', placement: 'bottom' })}>
    <Logo size={19} decorative />
  </a>
  <div class="tabs" role="tablist" tabindex="-1" aria-label="Tabs" bind:this={strip} ondragleave={() => (dropIndex = null)}>
    {#each tabs as t, i (t.id)}
      {@const active = t.id === activeId}
      <div
        class="tab"
        class:active
        class:pinned={t.pinned}
        class:drop-before={dropIndex === i && dragId !== t.id}
        class:drop-after={dropIndex === i + 1 && i === tabs.length - 1 && dragId !== t.id}
        class:dragging={dragId === t.id}
        role="tab"
        tabindex={active ? 0 : -1}
        aria-selected={active}
        aria-controls={onBrowser ? 'browser-content' : undefined}
        aria-keyshortcuts="Delete"
        data-tab={t.id}
        draggable="true"
        title={t.url ? `${titleOf(t)}\n${displayUrl(t.error?.url ?? t.url)}` : titleOf(t)}
        onclick={() => show(t.id)}
        onauxclick={(ev) => {
          if (ev.button === 1) {
            ev.preventDefault();
            browser.close(t.id);
          }
        }}
        onmousedown={(ev) => {
          if (ev.button === 1) ev.preventDefault();
        }}
        oncontextmenu={(ev) => openContextMenu(ev, menuFor(t), { label: 'Tab menu' })}
        onkeydown={(ev) => onKey(ev, t)}
        ondragstart={(ev) => onDragStart(ev, t)}
        ondragover={(ev) => onDragOver(ev, i)}
        ondrop={onDrop}
        ondragend={() => {
          dragId = null;
          dropIndex = null;
        }}
      >
        <span class="icon" aria-hidden="true">
          {#if t.loading}
            <Spinner size={13} />
          {:else if faviconOf(t)}
            <img src={faviconOf(t)} alt="" width="16" height="16" draggable="false" />
          {:else}
            <Icon icon={Globe} size={14} />
          {/if}
        </span>
        {#if !t.pinned}
          <span class="title">{titleOf(t)}</span>
          {#if t.discarded && !active}<span class="sr-only">(unloaded)</span>{/if}
          <!-- A pointer affordance only: a focusable control inside role="tab" is not allowed (nested-interactive).
               Keyboard and screen-reader users close a tab with Delete (aria-keyshortcuts), the tab menu or the
               close-tab shortcut. -->
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <span
            class="close"
            aria-hidden="true"
            onclick={(ev) => {
              ev.stopPropagation();
              browser.close(t.id);
            }}
            {@attach tooltip({ text: 'Close tab', action: 'closeTab', placement: 'bottom' })}
          >
            <Icon icon={X} size={13} />
          </span>
        {:else}
          <span class="sr-only">{titleOf(t)}</span>
        {/if}
      </div>
    {/each}
  </div>
  {#if pageTab}
    <!-- Hidden from assistive tech: the document title and the rail's current item already name the page. -->
    <div class="page-tab" class:first={tabs.length === 0} aria-hidden="true">
      <span class="icon">
        {#if pageTab.icon}<Icon icon={pageTab.icon} size={14} />{:else}<Logo size={14} decorative />{/if}
      </span>
      <span class="title">{pageTab.title}</span>
    </div>
  {/if}
  <IconButton icon={Plus} label="New tab" size="sm" action="newTab" tooltipPlacement="bottom" onclick={() => browser.newTab()} />
  <span class="spacer"></span>
  {#if vpn}
    <a href={pathFor('vpn')} class="vpn" {@attach tooltip({ text: `VPN: ${vpn.detail ?? vpn.state}`, placement: 'bottom-end', describe: true })}>
      <span class="dot {vpnTone}" aria-hidden="true"></span>
      <span class="vpn-label">VPN{vpn.detail ? ` · ${vpn.detail}` : ''}</span>
      <span class="sr-only">, status: {vpn.state}</span>
    </a>
  {/if}
</div>

<style>
  .strip {
    display: flex;
    align-items: stretch;
    gap: 2px;
    height: var(--tabstrip-h);
    padding: 0 10px 0 0;
    border-bottom: 1px solid var(--hairline);
  }

  .strip > :global(.icon-btn) {
    align-self: center;
    margin-left: 4px;
  }

  .home {
    display: grid;
    place-items: center;
    flex: none;
    width: var(--tabstrip-h);
    color: var(--text-2);
    transition: color var(--t-1) var(--ease-out);
  }

  .home:hover {
    color: var(--text);
  }

  .home:focus-visible {
    outline-offset: -6px;
    border-radius: var(--radius);
  }

  .tabs {
    display: flex;
    align-items: stretch;
    min-width: 0;
    flex: 0 1 auto;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  .tabs::-webkit-scrollbar {
    display: none;
  }

  .tab {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 1 200px;
    width: 200px;
    min-width: 96px;
    max-width: 200px;
    padding: 0 8px 0 12px;
    color: var(--text-3);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: default;
    user-select: none;
    outline: none;
    transition:
      background-color var(--t-1) var(--ease-out),
      color var(--t-1) var(--ease-out);
  }

  /* 1px × 14px separators between idle tabs. */
  .tab + .tab::before {
    content: '';
    position: absolute;
    left: 0;
    top: 50%;
    height: 14px;
    margin-top: -7px;
    width: 1px;
    background: var(--hairline);
  }

  .tab.active::before,
  .tab.active + .tab::before,
  .tab:hover::before,
  .tab:hover + .tab::before {
    opacity: 0;
  }

  .tab.pinned {
    flex: none;
    min-width: 0;
    width: 40px;
    max-width: 40px;
    justify-content: center;
    padding: 0;
  }

  .tab:hover {
    background: var(--hover);
    color: var(--text-2);
  }

  .tab.active {
    color: var(--text);
  }

  /* The active tab: a 2px underline in the text color (monochrome chrome, DESIGN.md §1.2). */
  .tab.active::after {
    content: '';
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: -1px;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--text);
  }

  /* The GNOME page in view, as the current tab (not interactive). */
  .page-tab {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 1 auto;
    min-width: 0;
    max-width: 200px;
    padding: 0 16px 0 12px;
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: 500;
    white-space: nowrap;
    user-select: none;
  }

  .page-tab .icon {
    color: var(--text-2);
  }

  .page-tab .title {
    mask-image: none;
    text-overflow: ellipsis;
  }

  .page-tab::after {
    content: '';
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: -1px;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--text);
  }

  .page-tab:not(.first)::before {
    content: '';
    position: absolute;
    left: 0;
    top: 50%;
    height: 14px;
    margin-top: -7px;
    width: 1px;
    background: var(--hairline);
  }

  /* Another GNOME page is in view: the browser's active tab stays marked, quieter. */
  .away .tab.active {
    color: var(--text-2);
  }

  .away .tab.active::after {
    opacity: 0.4;
  }

  .tab:focus-visible {
    box-shadow: inset 0 0 0 2px var(--focus);
    border-radius: var(--radius-sm);
  }

  .tab.dragging {
    opacity: 0.45;
  }

  .tab.drop-before {
    box-shadow: inset 2px 0 0 var(--accent);
  }

  .tab.drop-after {
    box-shadow: inset -2px 0 0 var(--accent);
  }

  .icon {
    display: grid;
    place-items: center;
    width: 14px;
    height: 14px;
    flex: none;
    color: var(--text-3);
  }

  .tab.active .icon {
    color: var(--text-2);
  }

  .icon img {
    width: 14px;
    height: 14px;
    object-fit: contain;
    border-radius: 2px;
  }

  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    mask-image: linear-gradient(to right, #000 calc(100% - 18px), transparent);
  }

  .close {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    flex: none;
    border-radius: var(--radius-sm);
    color: var(--text-3);
    opacity: 0;
    cursor: pointer;
    transition:
      opacity var(--t-1) var(--ease-out),
      background-color var(--t-1) var(--ease-out),
      color var(--t-1) var(--ease-out);
  }

  .tab:hover .close,
  .tab.active .close {
    opacity: 1;
  }

  .close:hover {
    background: var(--press);
    color: var(--text);
  }

  .spacer {
    flex: 1;
    min-width: 8px;
  }

  .vpn {
    align-self: center;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex: none;
    max-width: 260px;
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-pill);
    color: var(--text-2);
    font-size: var(--text-sm);
    font-weight: 500;
    white-space: nowrap;
    transition:
      background-color var(--t-1) var(--ease-out),
      color var(--t-1) var(--ease-out),
      border-color var(--t-1) var(--ease-out);
  }

  .vpn:hover {
    background: var(--hover);
    border-color: var(--hairline-strong);
    color: var(--text);
  }

  .vpn-label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dot {
    width: 7px;
    height: 7px;
    flex: none;
    border-radius: 50%;
    background: var(--text-3);
  }

  .dot.success {
    background: var(--success);
    box-shadow: 0 0 0 3px var(--success-soft);
  }

  .dot.warning {
    background: var(--warning);
    box-shadow: 0 0 0 3px var(--warning-soft);
  }

  .dot.danger {
    background: var(--danger);
    box-shadow: 0 0 0 3px var(--danger-soft);
  }

  @media (pointer: coarse) {
    .close {
      opacity: 1;
    }
  }
</style>
