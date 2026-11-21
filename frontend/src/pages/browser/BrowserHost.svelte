<!--
  Browser host — the persistent layer for /browse (stays mounted while other pages are shown, so tabs and the
  engine iframe survive navigation). It starts the browser (src/browser/browser.svelte.ts: tabs, the engine client,
  the BrowserBridge), tells it whether the view is visible, and honours /browse?url=<address> links.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { navigate } from '../../app/router.svelte';
  import type { PersistentPageProps } from '../../app/routes';
  import { browser, startBrowser } from '../../browser/browser.svelte';
  import BrowserView from '../../browser/ui/BrowserView.svelte';
  import { normalizeLinkUrl } from '../../lib/url';

  let { active, query }: PersistentPageProps = $props();

  void startBrowser();
  // The library (history visits, downloads) is up before the first page commits, also on a /browse deep link that
  // mounts this view before main.ts's idle callback ran (initLibrary() is idempotent).
  void import('../../library').then((m) => m.initLibrary());

  $effect(() => {
    browser.setVisible(active);
  });

  // /browse?url=… deep links (links elsewhere in GNOME, opened with middle-click / "open in new tab"). The parameter
  // is dropped from the address (replace, so Back does not reopen it) and the page opens in a new, focused tab.
  $effect(() => {
    if (!active) return;
    const raw = query.get('url');
    if (!raw) return;
    untrack(() => {
      const href = normalizeLinkUrl(raw);
      void navigate('/browse', { replace: true });
      if (href) void startBrowser().then(() => browser.openUrl(href, { newTab: true }));
    });
  });

  // An empty browser view shows a new tab, like a browser window never has zero tabs.
  $effect(() => {
    if (!active) return;
    void startBrowser().then(() => {
      if (browser.model.tabs.length === 0) untrack(() => browser.newTab());
    });
  });
</script>

<div class="host">
  <BrowserView />
</div>

<style>
  .host {
    position: absolute;
    inset: 0;
  }
</style>
