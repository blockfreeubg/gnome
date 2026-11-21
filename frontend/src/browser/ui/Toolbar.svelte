<!--
  Toolbar (DESIGN.md §11.3: 50px, on every route): back, forward, reload/stop, home, the address bar (with the star,
  the pop-up indicator and the engine badge inside it), the content-blocking shield (proxied pages, once the built-in
  extensions are registered; also in the compact and phone toolbars, WAVE-B3 §7.1), downloads, the browser menu and
  the account avatar.
  `compact` (appearance.toolbar) keeps back, forward, reload, the address bar and the menu; on phones it is back ·
  address bar · tab count · menu. On GNOME's own pages Back/Forward walk the app's history, Reload re-mounts the
  page and the address bar shows gnome://<page>.
-->
<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Bookmark from '@lucide/svelte/icons/bookmark';
  import CircleUser from '@lucide/svelte/icons/circle-user';
  import Download from '@lucide/svelte/icons/download';
  import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
  import History from '@lucide/svelte/icons/history';
  import House from '@lucide/svelte/icons/house';
  import Maximize from '@lucide/svelte/icons/maximize';
  import Minus from '@lucide/svelte/icons/minus';
  import Plus from '@lucide/svelte/icons/plus';
  import Printer from '@lucide/svelte/icons/printer';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import Search from '@lucide/svelte/icons/search';
  import Settings from '@lucide/svelte/icons/settings';
  import X from '@lucide/svelte/icons/x';
  import Badge from '../../components/Badge.svelte';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import Logo from '../../components/Logo.svelte';
  import Menu from '../../components/Menu.svelte';
  import type { MenuItem } from '../../components/menu';
  import { openHomepage } from '../../app/builtin';
  import { navigate, router } from '../../app/router.svelte';
  import { pathFor } from '../../app/routes';
  import { server } from '../../app/server.svelte';
  import { tooltip } from '../../components/tooltip.svelte';
  import { account } from '../../settings/account.svelte';
  import { isFeatureActive } from '../../settings/features';
  import { settings } from '../../settings/store.svelte';
  import { browser } from '../browser.svelte';
  import Omnibox from './Omnibox.svelte';
  import Shield from './Shield.svelte';

  interface Props {
    mobile?: boolean;
    /** The browser view is the visible route (otherwise navigation acts on GNOME's own pages). */
    onBrowser?: boolean;
    /** The tab strip is hidden: the GNOME mark (Home) moves to the toolbar's start. */
    markAtStart?: boolean;
    ontabs?: () => void;
    downloadsAnchor?: HTMLElement;
  }
  let { mobile = false, onBrowser = true, markAtStart = false, ontabs, downloadsAnchor = $bindable() }: Props = $props();

  const t = $derived(browser.model.active);
  const compact = $derived(settings.value.appearance.toolbar === 'compact');
  const pageLive = $derived(onBrowser && !!t?.live);
  const zoomable = $derived(pageLive && browser.hasCapability('zoom'));
  const activeDownloads = $derived(browser.downloads.size);
  const tabCount = $derived(Math.min(browser.model.tabs.length, 99));
  /** The shield: a proxied page in the browser view, with the built-in extensions present (no numbers for internal pages). */
  const shieldTab = $derived(onBrowser && t?.url && isFeatureActive('extensions') ? t : null);
  const canBack = $derived(onBrowser ? !!t?.canGoBack : router.canGoBack);
  const canForward = $derived(onBrowser ? !!t?.canGoForward : router.canGoForward);
  /** Account avatar (servers with accounts): who is signed in, or a way to sign in (Settings → Account & sync). */
  const accountItem = $derived.by(() => {
    if (!server.config?.features.accounts) return null;
    const name = account.displayName;
    return name ? { initial: name.trim().charAt(0).toUpperCase(), name: `Account: ${name}` } : { initial: '', name: 'Sign in' };
  });

  function back(): void {
    if (onBrowser) browser.go(-1);
    else router.back();
  }

  function forward(): void {
    if (onBrowser) browser.go(1);
    else router.forward();
  }

  function reload(): void {
    if (onBrowser) browser.reload();
    else router.reload();
  }

  const menuItems = (): MenuItem[] => {
    const items: MenuItem[] = [];
    // Phones show only Back in the toolbar: Forward and Reload/Stop live at the top of the menu (as in mobile browsers).
    if (mobile) {
      items.push(
        { label: 'Forward', icon: ArrowRight, disabled: !canForward, onSelect: forward },
        onBrowser && t?.loading && t.live
          ? { label: 'Stop loading', icon: X, onSelect: () => browser.stop() }
          : { label: 'Reload', icon: RotateCw, disabled: onBrowser && !t?.url, onSelect: reload },
        { kind: 'separator' },
      );
    }
    items.push(
      { label: 'New tab', icon: Plus, shortcut: 'newTab', onSelect: () => browser.newTab() },
      { label: 'Reopen closed tab', icon: History, shortcut: 'reopenClosedTab', disabled: browser.model.closed.length === 0, onSelect: () => browser.reopenClosed() },
      { kind: 'separator' },
      { label: 'Find in page…', icon: Search, shortcut: 'findInPage', disabled: !pageLive, onSelect: () => browser.openFind() },
    );
    if (browser.hasCapability('zoom')) {
      items.push({
        kind: 'submenu',
        label: `Zoom (${Math.round((t?.zoom ?? 1) * 100)}%)`,
        disabled: !zoomable,
        items: [
          { label: 'Zoom in', icon: Plus, shortcut: 'zoomIn', keepOpen: true, onSelect: () => browser.zoom(1) },
          { label: 'Zoom out', icon: Minus, shortcut: 'zoomOut', keepOpen: true, onSelect: () => browser.zoom(-1) },
          { label: 'Reset zoom', shortcut: 'zoomReset', onSelect: () => browser.zoom(0) },
        ],
      });
    }
    if (browser.hasCapability('print')) items.push({ label: 'Print…', icon: Printer, disabled: !pageLive, onSelect: () => browser.action('print') });
    items.push(
      { label: 'Fullscreen', icon: Maximize, shortcut: 'toggleFullscreen', onSelect: () => browser.toggleFullscreen() },
      { kind: 'separator' },
      { label: 'Bookmark this page…', icon: Bookmark, shortcut: 'bookmarkPage', disabled: !onBrowser || !t?.url, onSelect: () => t?.url && browser.editBookmark(t.url, t.title) },
      { label: 'History', icon: History, shortcut: 'openHistory', onSelect: () => void navigate('/history') },
      { label: 'Bookmarks', icon: Bookmark, shortcut: 'openBookmarks', onSelect: () => void navigate('/bookmarks') },
      { label: 'Downloads', icon: Download, shortcut: 'openDownloads', onSelect: () => void navigate('/downloads') },
      { kind: 'separator' },
    );
    // Phones have no bookmarks bar (the chrome is the toolbar alone): the switch would do nothing there.
    if (!mobile) {
      items.push({
        kind: 'checkbox',
        label: 'Show bookmarks bar',
        checked: settings.value.appearance.showBookmarksBar,
        onToggle: (v) => void settings.set('appearance', 'showBookmarksBar', v),
      });
    }
    items.push(
      { label: 'Settings', icon: Settings, shortcut: 'openSettings', onSelect: () => void navigate('/settings/browser') },
    );
    if (browser.engineState !== 'idle') {
      items.push({ kind: 'separator' }, { label: 'Restart browser engine', icon: RotateCw, onSelect: () => browser.restartEngine('restart') });
    }
    return items;
  };
</script>

<div class="toolbar" class:mobile role="toolbar" aria-label="Browser toolbar">
  {#if markAtStart}
    <a href="/" class="mark" aria-label="Home" {@attach tooltip({ text: 'Home', placement: 'bottom' })}>
      <Logo size={19} decorative />
    </a>
  {/if}
  <div class="nav">
    <IconButton icon={ArrowLeft} label="Back" size="sm" action="back" tooltipPlacement="bottom" disabled={!canBack} onclick={back} />
    {#if !mobile}
      <IconButton icon={ArrowRight} label="Forward" size="sm" action="forward" tooltipPlacement="bottom" disabled={!canForward} onclick={forward} />
      {#if onBrowser && t?.loading && t.live}
        <IconButton icon={X} label="Stop loading" size="sm" tooltipPlacement="bottom" onclick={() => browser.stop()} />
      {:else}
        <IconButton icon={RotateCw} label="Reload" size="sm" action="reload" tooltipPlacement="bottom" disabled={onBrowser && !t?.url} onclick={reload} />
      {/if}
      {#if !compact}
        <IconButton icon={House} label="Home page" size="sm" action="home" tooltipPlacement="bottom" onclick={() => openHomepage()} />
      {/if}
    {/if}
  </div>

  <Omnibox compact={mobile} {onBrowser} />

  <div class="end">
    {#if shieldTab}<Shield tab={shieldTab} />{/if}
    {#if !compact && !mobile}
      <span class="dl" bind:this={downloadsAnchor}>
        <IconButton
          icon={Download}
          label="Downloads"
          size="sm"
          action="openDownloads"
          tooltipPlacement="bottom"
          pressed={browser.downloadsOpen}
          onclick={() => (browser.downloadsOpen = !browser.downloadsOpen)}
        />
        {#if activeDownloads}<Badge count={activeDownloads} tone="accent" label={`${activeDownloads} downloads in progress`} class="dl-badge" />{/if}
      </span>
    {/if}
    {#if mobile}
      <!-- The accessible name starts with the visible count (label-content-name-mismatch). -->
      <button type="button" class="tab-count" aria-label={`${tabCount} open ${tabCount === 1 ? 'tab' : 'tabs'}`} onclick={() => ontabs?.()}>
        <span aria-hidden="true">{tabCount}</span>
      </button>
    {/if}
    <Menu items={menuItems} label="Browser menu" placement="bottom-end">
      {#snippet trigger(props)}
        <IconButton {...props} icon={EllipsisVertical} label="Browser menu" size="sm" tooltipPlacement="bottom" />
      {/snippet}
    </Menu>
    {#if accountItem && !compact && !mobile}
      <a
        href={pathFor('settings-section', { section: 'account' })}
        class="avatar"
        class:signed-in={!!accountItem.initial}
        aria-label={accountItem.name}
        {@attach tooltip({ text: accountItem.name, placement: 'bottom-end' })}
      >
        {#if accountItem.initial}
          <span aria-hidden="true">{accountItem.initial}</span>
        {:else}
          <Icon icon={CircleUser} size={17} />
        {/if}
      </a>
    {/if}
  </div>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--toolbar-h);
    padding: 0 10px 0 8px;
    border-bottom: 1px solid var(--hairline);
  }

  .mark {
    display: grid;
    place-items: center;
    flex: none;
    width: 30px;
    height: 30px;
    border-radius: calc(var(--radius-sm) + 1px);
    color: var(--text-2);
    transition: color var(--t-1) var(--ease-out);
  }

  .mark:hover {
    color: var(--text);
  }

  .nav,
  .end {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }

  .nav {
    margin-right: 4px;
  }

  .end {
    margin-left: 4px;
    gap: 4px;
  }

  .dl {
    position: relative;
    display: inline-flex;
  }

  .dl :global(.dl-badge) {
    position: absolute;
    top: -3px;
    right: -4px;
    pointer-events: none;
  }

  .avatar {
    display: grid;
    place-items: center;
    flex: none;
    width: 28px;
    height: 28px;
    margin-left: 2px;
    border-radius: 50%;
    background: var(--surface-3);
    box-shadow: inset 0 0 0 1px var(--hairline-strong);
    color: var(--text-2);
    font-size: var(--text-sm);
    font-weight: 700;
    line-height: 1;
    transition:
      color var(--t-1) var(--ease-out),
      box-shadow var(--t-1) var(--ease-out);
  }

  .avatar.signed-in {
    color: var(--text);
  }

  .avatar:hover {
    color: var(--text);
    box-shadow: inset 0 0 0 1px var(--field-border-hover);
  }

  .tab-count {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border: 0;
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    border-radius: var(--radius);
  }

  .tab-count span {
    display: grid;
    place-items: center;
    min-width: 20px;
    height: 20px;
    padding: 0 3px;
    border: 1.5px solid currentColor;
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .tab-count:hover {
    color: var(--text);
    background: var(--hover);
  }

  .toolbar.mobile {
    gap: 4px;
    padding: 0 6px;
  }

  .toolbar.mobile .nav,
  .toolbar.mobile .end {
    margin: 0;
  }
</style>
