<!--
  App shell (DESIGN.md §9.1): the browser-first layout. The global chrome (tab strip, toolbar, bookmarks bar) runs
  across the top on every route; below it the slim rail (auto · expanded · compact · hidden, left/right) and the page
  stage (persistent layers such as the browser + the routed page scroller). Under 760px: the toolbar on top and the
  bottom bar. On Home (and a browser tab showing the new-tab page) the backdrop fills the window behind the glass
  chrome. Fullscreen hides the chrome; a strip at the top edge reveals it. Plus every overlay host (tooltips, toasts,
  dialogs, context menus, sheets, command palette, live regions).
-->
<script lang="ts">
  import { untrack, type Component } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import Tooltip from '../components/Tooltip.svelte';
  import { captureFocus } from '../components/focus';
  import { fade } from '../components/motion';
  import { browser } from '../browser/browser.svelte';
  import HomeBackground from '../pages/home/HomeBackground.svelte';
  import { settings } from '../settings/store.svelte';
  import Chrome from './Chrome.svelte';
  import CommandPalette from './CommandPalette.svelte';
  import MobileBar from './MobileBar.svelte';
  import Rail from './Rail.svelte';
  import RouteView from './RouteView.svelte';
  import Announcer from './overlays/Announcer.svelte';
  import ContextMenuHost from './overlays/ContextMenuHost.svelte';
  import DialogHost from './overlays/DialogHost.svelte';
  import SheetHost from './overlays/SheetHost.svelte';
  import ToastHost from './overlays/ToastHost.svelte';
  import { router } from './router.svelte';
  import { matchRoute, type PersistentPageProps, type RouteDef } from './routes';
  import { shell } from './shell.svelte';

  const mobile = new MediaQuery('max-width: 759px');
  const narrow = new MediaQuery('max-width: 1099px');
  /** Query passed to hidden persistent pages (one instance, so their props do not change on every navigation). */
  const EMPTY_QUERY = new URLSearchParams();

  // Until the router commits the first page (its chunk is still loading), lay the shell out for the route in the
  // address bar: a cold load of /browse must not paint the expanded rail and the page scroller first and then jump
  // to the compact rail (a layout shift of the whole stage).
  const initialRoute: RouteDef = matchRoute(location.pathname).route;

  const appearance = $derived(settings.value.appearance);
  const currentRoute = $derived(router.current?.route ?? initialRoute);
  const onPersistent = $derived(currentRoute.persistent ?? false);
  const onBrowser = $derived(currentRoute.id === 'browse');
  const backdrop = $derived(
    !shell.immersive &&
      (currentRoute.id === 'home' ||
        (onBrowser && !!browser.model.active && !browser.model.active.url && settings.value.browser.newTab === 'home')),
  );
  const railMode = $derived.by((): 'expanded' | 'compact' | 'hidden' | 'mobile' => {
    if (mobile.current) return 'mobile';
    const s = appearance.sidebar;
    if (s === 'auto') return onPersistent || narrow.current ? 'compact' : 'expanded';
    return s;
  });

  $effect(() => {
    shell.backdrop = backdrop;
  });

  // Fullscreen (shell.immersive): the chrome slides away; the pointer at the top edge brings it back.
  let reveal = $state(false);
  /** Height of the chrome (the hidden rail's overlay opens below it). */
  let chromeH = $state(0);
  $effect(() => {
    if (!shell.immersive) reveal = false;
  });

  $effect(() => {
    shell.railMode = railMode;
    if (railMode !== 'hidden') shell.railOverlay = false;
  });

  let scroller = $state<HTMLElement>();
  $effect(() => {
    router.setScroller(scroller ?? null);
  });

  // Hidden rail: reveal as an overlay from the screen edge. Only real pointer movement in the edge strip counts:
  // browsers also fire pointerenter when content appears under a resting cursor (e.g. one parked at the screen edge
  // while a page loads), which must not pop the rail open.
  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  /** The overlay was revealed by the pointer (edge strip) rather than the keyboard (toggleSidebar, palette). */
  let revealedByPointer = false;
  function edgeMove(ev: PointerEvent): void {
    if (ev.pointerType === 'touch' || revealTimer || shell.railOverlay) return;
    revealTimer = setTimeout(() => {
      revealTimer = null;
      revealedByPointer = true;
      shell.railOverlay = true;
    }, 140);
  }
  function edgeLeave(): void {
    if (revealTimer) clearTimeout(revealTimer);
    revealTimer = null;
  }
  function overlayLeave(): void {
    if (revealTimer) clearTimeout(revealTimer);
    revealTimer = setTimeout(() => {
      revealTimer = null;
      shell.railOverlay = false;
    }, 280);
  }
  function overlayEnter(): void {
    if (revealTimer) clearTimeout(revealTimer);
    revealTimer = null;
  }

  let railOverlayEl = $state<HTMLElement>();
  /** Where focus goes back to when an overlay opened from the keyboard closes with focus still inside it. */
  let overlayRestore: (() => void) | null = null;

  /**
   * Attachment on the overlay. A press anywhere else closes it (it may have been opened from the keyboard). Opened
   * from the keyboard, focus moves into the rail (the active item); Tab-ing out of it closes it.
   */
  function overlayBehaviour(node: HTMLElement): () => void {
    const byPointer = revealedByPointer;
    revealedByPointer = false;
    overlayRestore = byPointer ? null : captureFocus();
    if (!byPointer) {
      queueMicrotask(() => {
        const target = node.querySelector<HTMLElement>('[aria-current="page"]') ?? node.querySelector<HTMLElement>('a[href], button');
        target?.focus({ preventScroll: true });
      });
    }
    const onDown = (ev: PointerEvent): void => {
      if (!node.contains(ev.target as Node)) shell.railOverlay = false;
    };
    const onFocusOut = (ev: FocusEvent): void => {
      const next = ev.relatedTarget as Node | null;
      if (next && !node.contains(next)) shell.railOverlay = false;
    };
    document.addEventListener('pointerdown', onDown, true);
    node.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      node.removeEventListener('focusout', onFocusOut);
    };
  }

  // Closing with focus still inside the overlay (Escape, the toggle shortcut again): focus returns to where it was.
  // A pre-effect, so it runs before the closing overlay turns inert for its exit transition (which drops focus).
  $effect.pre(() => {
    if (shell.railOverlay) return;
    const el = untrack(() => railOverlayEl);
    if (el && overlayRestore && el.contains(document.activeElement)) overlayRestore();
    overlayRestore = null;
  });

  /** A rail item in the overlay was activated: the router moves focus to the new page once it has rendered. */
  function overlayNavigate(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && railOverlayEl?.contains(active)) active.blur();
    shell.railOverlay = false;
  }
</script>

<svelte:window
  onkeydown={(ev) => {
    if (ev.key === 'Escape' && shell.railOverlay) shell.railOverlay = false;
  }}
/>

<div
  class="shell"
  data-rail={shell.immersive ? 'hidden' : railMode}
  data-side={appearance.sidebarPosition}
  class:immersive={shell.immersive}
  class:reveal
  class:backdrop
  style:--chrome-h="{chromeH}px"
>
  <a class="skip-link" href="#main-content" data-router="off" onclick={(ev) => {
    ev.preventDefault();
    // On the browser view the page scroller is hidden: skip into the visible persistent layer instead.
    const target = onPersistent ? document.querySelector<HTMLElement>('.layer.active') : scroller;
    if (!target) return;
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.focus();
  }}>Skip to content</a>

  {#if backdrop}
    <div class="backdrop-slot"><HomeBackground background={appearance.homeBackground} /></div>
  {/if}

  {#if shell.immersive}
    <div class="edge-top" aria-hidden="true" onpointerenter={() => (reveal = true)}></div>
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions (pointer-only: hides the fullscreen chrome again) -->
  <header class="chrome-slot" bind:clientHeight={chromeH} aria-label="Browser controls" onpointerleave={() => shell.immersive && (reveal = false)}>
    <Chrome mobile={railMode === 'mobile'} {onBrowser} />
  </header>

  {#if !shell.immersive && (railMode === 'expanded' || railMode === 'compact')}
    <div class="rail-slot">
      <Rail mode={railMode} side={appearance.sidebarPosition} />
    </div>
  {/if}

  {#if !shell.immersive && railMode === 'hidden'}
    <div class="edge-reveal" aria-hidden="true" onpointermove={edgeMove} onpointerleave={edgeLeave}></div>
    {#if shell.railOverlay}
      <div
        bind:this={railOverlayEl}
        class="rail-overlay"
        role="presentation"
        onpointerleave={overlayLeave}
        onpointerenter={overlayEnter}
        transition:fade={{ duration: 160 }}
        {@attach overlayBehaviour}
      >
        <Rail mode="overlay" side={appearance.sidebarPosition} onnavigate={overlayNavigate} />
      </div>
    {/if}
  {/if}

  <div class="stage">
    {#each router.persistent as p (p.route.id)}
      {@const Page = p.component as Component<PersistentPageProps>}
      {@const active = router.current?.route.id === p.route.id}
      <!-- The visible layer is the page's main landmark (the page scroller below is hidden while it is shown). -->
      <div
        class="layer"
        class:active
        role={active ? 'main' : undefined}
        inert={!active}
        aria-hidden={active ? undefined : 'true'}
        {@attach (el) => router.setLayer(p.route.id, el)}
      >
        <Page {active} params={active ? (router.current?.params ?? {}) : {}} query={active ? (router.current?.query ?? EMPTY_QUERY) : EMPTY_QUERY} />
      </div>
    {/each}

    <main id="main-content" class="page-scroller" tabindex="-1" bind:this={scroller} hidden={onPersistent}>
      <RouteView />
    </main>
  </div>

  {#if !shell.immersive && railMode === 'mobile'}
    <div class="bar-slot"><MobileBar /></div>
  {/if}
</div>

<Tooltip />
<ToastHost />
<DialogHost />
<ContextMenuHost />
<SheetHost />
<CommandPalette />
<Announcer />

<style>
  .shell {
    --rail-w: 0px;
    position: relative;
    display: grid;
    grid-template-columns: var(--rail-w) minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-areas:
      'chrome chrome'
      'rail stage';
    height: 100dvh;
    width: 100%;
    overflow: hidden;
    background: var(--bg);
    isolation: isolate;
  }

  .shell[data-rail='expanded'] {
    --rail-w: var(--rail-w-expanded);
  }

  .shell[data-rail='compact'] {
    --rail-w: var(--rail-w-compact);
  }

  .shell[data-side='right'] {
    grid-template-columns: minmax(0, 1fr) var(--rail-w);
    grid-template-areas:
      'chrome chrome'
      'stage rail';
  }

  .shell[data-rail='mobile'] {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-areas: 'chrome' 'stage' 'bar';
  }

  .shell[data-rail='hidden'] {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: 'chrome' 'stage';
  }

  /* Home's backdrop behind everything, chrome included (the chrome and rail are glass). */
  .backdrop-slot {
    position: absolute;
    inset: 0;
    z-index: -1;
    pointer-events: none;
  }

  .chrome-slot {
    grid-area: chrome;
    position: relative;
    z-index: calc(var(--z-rail) + 1);
    min-width: 0;
  }

  .rail-slot {
    grid-area: rail;
    min-height: 0;
    z-index: var(--z-rail);
  }

  .bar-slot {
    grid-area: bar;
  }

  .stage {
    grid-area: stage;
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    view-transition-name: gnome-page;
  }

  .page-scroller {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-gutter: stable;
    outline: none;
  }

  /* Over the backdrop the scrollbar gutter must not paint a --bg strip over the picture. */
  .backdrop .page-scroller {
    scrollbar-color: var(--scrollbar-thumb) transparent;
  }

  .layer {
    position: absolute;
    inset: 0;
    outline: none; /* focus target of the skip link (programmatic focus, like the page scroller) */
  }

  .layer:not(.active) {
    visibility: hidden;
    pointer-events: none;
  }

  /* Fullscreen: the chrome leaves the layout and slides away; a strip at the top edge brings it back. */
  .immersive .chrome-slot {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: var(--z-overlay);
    transform: translateY(-100%);
    transition: transform var(--t-3) var(--ease-out);
    box-shadow: var(--shadow-pop);
  }

  .immersive.reveal .chrome-slot {
    transform: none;
  }

  .immersive {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    grid-template-areas: 'stage';
  }

  .edge-top {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 6px;
    z-index: var(--z-overlay);
  }

  /* Beside the stage only (the rail opens below the chrome): the window's top-left corner is the tab strip's mark. */
  .edge-reveal {
    position: fixed;
    top: var(--chrome-h, 0px);
    bottom: 0;
    width: 8px;
    z-index: var(--z-overlay);
  }

  .shell[data-side='left'] .edge-reveal {
    left: 0;
  }

  .shell[data-side='right'] .edge-reveal {
    right: 0;
  }

  .rail-overlay {
    position: fixed;
    top: calc(var(--chrome-h, 0px) + 8px);
    bottom: 8px;
    z-index: var(--z-overlay);
    border-radius: var(--radius-xl);
    overflow: hidden;
    box-shadow: var(--shadow-pop);
  }

  .shell[data-side='left'] .rail-overlay {
    left: 8px;
  }

  .shell[data-side='right'] .rail-overlay {
    right: 8px;
  }

  .skip-link {
    position: fixed;
    top: 8px;
    left: 8px;
    z-index: var(--z-progress);
    padding: 8px 14px;
    border-radius: var(--radius);
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 600;
    transform: translateY(-200%);
    transition: transform var(--t-2) var(--ease-out);
  }

  .skip-link:focus-visible {
    transform: none;
  }
</style>
