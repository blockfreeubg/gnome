<!--
  The global browser chrome (DESIGN.md §9.1, §11.1): the tab strip, the toolbar with the address bar and the optional
  bookmarks bar, on every route — GNOME's own pages render under it like pages in a browser. On phones it is the
  toolbar alone (back · address bar · tab count · menu); the tabs live in the tab switcher sheet.

  The chrome starts the browser model (tabs, session, shortcuts) but never the engine: the engine iframe is created
  only when the browser view first shows a proxied tab (ARCHITECTURE §5.1).
-->
<script lang="ts">
  import ProgressBar from '../components/ProgressBar.svelte';
  import { browser, startBrowser } from '../browser/browser.svelte';
  import BookmarkEditor from '../browser/ui/BookmarkEditor.svelte';
  import BookmarksBar from '../browser/ui/BookmarksBar.svelte';
  import DownloadsPanel from '../browser/ui/DownloadsPanel.svelte';
  import TabStrip from '../browser/ui/TabStrip.svelte';
  import TabSwitcher from '../browser/ui/TabSwitcher.svelte';
  import Toolbar from '../browser/ui/Toolbar.svelte';
  import { settings } from '../settings/store.svelte';
  import { router } from './router.svelte';

  interface Props {
    mobile: boolean;
    /** True while the browser view (/browse) is the visible route. */
    onBrowser: boolean;
  }
  let { mobile, onBrowser }: Props = $props();

  void startBrowser();

  const a = $derived(settings.value.appearance);
  const t = $derived(browser.model.active);
  const showStrip = $derived(!mobile && (a.tabStrip === 'top' || browser.model.tabs.length > 1));
  const showBookmarks = $derived(a.showBookmarksBar && !mobile);
  const pageLoading = $derived(onBrowser && !!t?.loading && !!t.url);

  let downloadsAnchor = $state<HTMLElement>();
  let switcherOpen = $state(false);
</script>

<div class="chrome" class:mobile class:strip={showStrip}>
  {#if showStrip}<TabStrip {onBrowser} />{/if}
  <Toolbar {mobile} {onBrowser} markAtStart={!showStrip && !mobile} ontabs={() => (switcherOpen = true)} bind:downloadsAnchor />
  {#if showBookmarks}<BookmarksBar />{/if}
  <div class="progress" aria-hidden={!(pageLoading || router.pending)}>
    {#if pageLoading}
      <ProgressBar label={`Loading ${t?.title || 'page'}`} size="xs" />
    {:else if router.pending}
      <ProgressBar label="Loading page" size="xs" />
    {/if}
  </div>
</div>

<DownloadsPanel anchor={downloadsAnchor} />
<BookmarkEditor />
{#if mobile}<TabSwitcher bind:open={switcherOpen} />{/if}

<style>
  .chrome {
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--chrome-bg);
    -webkit-backdrop-filter: var(--chrome-filter);
    backdrop-filter: var(--chrome-filter);
  }

  /* Panels opened from the chrome over web pages (downloads, engine, pop-ups): nearly opaque, so busy pages behind
     them never hurt legibility (backdrop blur is not rendered everywhere, e.g. headless Firefox). */
  :global(.popover.popover.browser-pop) {
    background: color-mix(in oklab, var(--surface-2) 97%, transparent);
  }

  .progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 2px;
    pointer-events: none;
  }
</style>
