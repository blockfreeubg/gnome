<!--
  The browser view's content area (DESIGN.md §11.1): the tab strip, toolbar and bookmarks bar are the shell's global
  chrome (app/Chrome.svelte). It holds the one engine iframe (created when a proxied tab first needs it) and, over it,
  GNOME's own layers: the new-tab page, the error overlay, the engine state, notices and the find bar.
-->
<script lang="ts">
  import ProgressBar from '../../components/ProgressBar.svelte';
  import { settings } from '../../settings/store.svelte';
  import { browser } from '../browser.svelte';
  import EngineState from './EngineState.svelte';
  import ErrorOverlay from './ErrorOverlay.svelte';
  import FindBar from './FindBar.svelte';
  import Notices from './Notices.svelte';
  import NewTabPage from './NewTabPage.svelte';

  const t = $derived(browser.model.active);
  const engineBusy = $derived(['idle', 'starting', 'connecting', 'failed', 'mismatch', 'unresponsive'].includes(browser.engineState));
  const showEngineState = $derived(!!t?.url && engineBusy && browser.visible);
  // browser.visible: `.engine-slot.shown { visibility: visible }` would otherwise override the inactive persistent
  // layer's `visibility: hidden` (app/Shell.svelte), and the live tab would paint under every GNOME page.
  const showFrame = $derived(!!t?.url && t.live && !showEngineState && browser.visible);
  /** A tab without an address shows Home over the shell's wallpaper (the content area stays see-through). */
  const newTabHome = $derived(!!t && !t.url && browser.visible && settings.value.browser.newTab === 'home');

  let slot = $state<HTMLElement>();

  $effect(() => {
    browser.setContainer(slot ?? null);
    return () => browser.setContainer(null);
  });
</script>

<div class="browser" class:see-through={newTabHome}>
  <div class="content" id="browser-content" role="tabpanel" aria-label={t ? (t.title || 'New tab') : 'Browser'}>
    <div class="engine-slot" class:shown={showFrame} bind:this={slot}></div>
    {#if t && !t.url && browser.visible}
      <NewTabPage />
    {/if}
    {#if showEngineState}
      <EngineState />
    {:else if t?.error && t.url}
      <ErrorOverlay tab={t} error={t.error} />
    {/if}
    {#if t?.url && t.discarded && !t.live && !showEngineState && !t.error}
      <div class="restoring" role="status"><ProgressBar label="Restoring tab" size="xs" /></div>
    {/if}
    {#if browser.find.open && t?.live}<FindBar />{/if}
    <Notices />
  </div>
</div>

<style>
  .browser {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }

  .content {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .browser.see-through {
    background: transparent;
  }

  .engine-slot {
    position: absolute;
    inset: 0;
    visibility: hidden;
  }

  .engine-slot.shown {
    visibility: visible;
  }

  .engine-slot :global(iframe.engine-frame) {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
    background: #fff;
    color-scheme: normal;
  }

  .restoring {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
  }
</style>
