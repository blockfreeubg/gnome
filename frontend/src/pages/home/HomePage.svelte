<!--
  Home, also the browser's new-tab page (docs/DESIGN.md §9.3): over the backdrop chosen in Settings → Appearance →
  Home background, the monochrome mark beside the GNOME wordmark, the rounded search / address box, the quick links,
  and two quiet glass panels with recently visited sites (history) and favorites (bookmarks). A "Customize" pill opens
  the Home background setting.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import ImageIcon from '@lucide/svelte/icons/image';
  import StarOff from '@lucide/svelte/icons/star-off';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Icon from '../../components/Icon.svelte';
  import SectionHeader from '../../components/SectionHeader.svelte';
  import type { MenuItem } from '../../components/menu';
  import { toast } from '../../app/overlays/toast.svelte';
  import type { PageProps } from '../../app/routes';
  import { shell } from '../../app/shell.svelte';
  import { settings } from '../../settings/store.svelte';
  import { resolveBackground } from './background';
  import { loadFavorites, loadRecent, removeFromHistory, setFavorite, type SiteEntry } from './data';
  import HomeBackground from './HomeBackground.svelte';
  import HomeMark from './HomeMark.svelte';
  import HomeSearch from './HomeSearch.svelte';
  import QuickLinks from './QuickLinks.svelte';
  import SiteList from './SiteList.svelte';

  let {}: PageProps = $props();

  /** Rows per panel: the panels stay a quiet footnote to the search box. */
  const PANEL_ROWS = 5;

  /**
   * A backdrop the user supplied (color, gradient, image) can be anything, bright pictures on the dark theme included:
   * the hero then sits on a stronger scrim and its labels use the primary text color (DESIGN.md §3, text on pictures).
   */
  const customBackdrop = $derived(['color', 'gradient', 'image'].includes(resolveBackground(settings.value.appearance.homeBackground).kind));

  let recent = $state<SiteEntry[]>([]);
  let favorites = $state<SiteEntry[]>([]);
  let loaded = $state(false);

  async function refresh(): Promise<void> {
    const [r, f] = await Promise.all([loadRecent(PANEL_ROWS), loadFavorites(PANEL_ROWS)]);
    recent = r;
    favorites = f;
    loaded = true;
  }

  // The height of the scroll container Home lives in (the page scroller, or the browser's new-tab layer): the first
  // screen is the hero, and the backdrop stays put while the panels scroll over it.
  let root = $state<HTMLElement>();
  let stageHeight = $state<number | null>(null);

  function scrollParent(node: HTMLElement): HTMLElement | null {
    for (let el = node.parentElement; el; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') return el;
    }
    return null;
  }

  onMount(() => {
    void refresh();
    const scroller = root ? scrollParent(root) : null;
    const ro = scroller ? new ResizeObserver(() => (stageHeight = scroller.clientHeight)) : null;
    if (scroller) {
      stageHeight = scroller.clientHeight;
      ro?.observe(scroller);
    }
    // History and bookmarks change while browsing in other views/tabs; refresh when Home becomes visible again.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      ro?.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
    };
  });

  function recentExtra(entry: SiteEntry): MenuItem[] {
    return [
      {
        label: 'Remove from history',
        icon: Trash2,
        danger: true,
        onSelect: async () => {
          try {
            const n = await removeFromHistory(entry.url);
            await refresh();
            toast.success(n === 1 ? 'Removed 1 visit from history' : `Removed ${n} visits from history`);
          } catch {
            toast.error('Could not update history', { description: 'Local storage is unavailable.' });
          }
        },
      },
    ];
  }

  function favoriteExtra(entry: SiteEntry): MenuItem[] {
    if (!entry.bookmarkId || !entry.favorite) return [];
    const id = entry.bookmarkId;
    return [
      {
        label: 'Remove from favorites',
        icon: StarOff,
        onSelect: async () => {
          try {
            await setFavorite(id, false);
            await refresh();
          } catch {
            toast.error('Could not update bookmarks', { description: 'Local storage is unavailable.' });
          }
        },
      },
    ];
  }
</script>

<div class="home" class:custom-backdrop={customBackdrop} bind:this={root} style:--stage-h={stageHeight ? `${stageHeight}px` : undefined}>
  <!-- The shell paints the backdrop behind the whole window, chrome included, when it can (shell.backdrop). -->
  {#if !shell.backdrop}
    <div class="backdrop-pin">
      <HomeBackground background={settings.value.appearance.homeBackground} />
    </div>
  {/if}

  <div class="first">
    <section class="hero" aria-labelledby="home-title">
      <div class="brand">
        <HomeMark size={52} class="brand-mark" />
        <h1 id="home-title" class="wordmark" tabindex="-1">GNOME</h1>
      </div>
      <HomeSearch />
      <QuickLinks />
    </section>
  </div>

  <div class="panels" aria-busy={!loaded}>
    <section class="panel" aria-labelledby="home-recent">
      <SectionHeader id="home-recent" title="Recently visited">
        {#snippet actions()}<a class="more" href="/history">History</a>{/snippet}
      </SectionHeader>
      {#if recent.length}
        <SiteList entries={recent} label="Recently visited" showTime extraItems={recentExtra} />
      {:else}
        <!-- Reserves its line while IndexedDB is read, so nothing below jumps. -->
        <p class="quiet" class:pending={!loaded}>Sites you visit in the browser show up here.</p>
      {/if}
    </section>

    <section class="panel" aria-labelledby="home-favorites">
      <SectionHeader id="home-favorites" title="Favorites">
        {#snippet actions()}<a class="more" href="/bookmarks">Bookmarks</a>{/snippet}
      </SectionHeader>
      {#if favorites.length}
        <SiteList entries={favorites} label="Favorites" extraItems={favoriteExtra} />
      {:else}
        <p class="quiet" class:pending={!loaded}>Bookmark a page and mark it as a favorite to keep it here.</p>
      {/if}
    </section>
  </div>

  <div class="foot">
    <a class="customize" href="/settings/appearance#homeBackground">
      <Icon icon={ImageIcon} size={15} />
      <span>Customize</span>
    </a>
  </div>
</div>

<style>
  .home {
    /* The first screen is the hero; the panels' headers peek in under it so the page reads as scrollable. */
    --peek: 76px;
    --stage: var(--stage-h, calc(100svh - 96px));
    --first-h: max(420px, calc(var(--stage) - var(--peek)));
    position: relative;
    min-height: 100%;
    padding-bottom: var(--space-6);
    isolation: isolate;
  }

  /* The backdrop fills the visible stage and stays put while the panels scroll over it. */
  .backdrop-pin {
    position: sticky;
    top: 0;
    z-index: 0;
    height: var(--stage);
    margin-bottom: calc(-1 * var(--stage));
    pointer-events: none;
  }

  .first {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    min-height: var(--first-h);
    padding: 0 var(--page-pad-x);
    /* The hero's dimmed pool reaches past the sides: it must not widen the page (no horizontal scroll). */
    overflow-x: clip;
  }

  /* The hero's center sits a little above the middle of the first screen (≈ 40% of the stage, DESIGN.md §9.3). */
  .first::before,
  .first::after {
    content: '';
    min-height: 32px;
  }

  .first::before {
    flex: 4 1 0;
  }

  .first::after {
    flex: 5 1 0;
  }

  .hero {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    max-width: 640px;
  }

  /*
   * The hero's own dimmed area: a soft pool of the page color behind the mark, the search box and the quick-link
   * labels, so text over any picture keeps its contrast (DESIGN.md §3). Invisible on plain backgrounds.
   */
  .hero::before {
    content: '';
    position: absolute;
    inset: -110px -200px -80px;
    z-index: -1;
    pointer-events: none;
    background: radial-gradient(closest-side, color-mix(in oklab, var(--bg) 48%, transparent), transparent);
  }

  /*
   * Over a backdrop the user supplied the pool becomes an even scrim with a feathered edge: a blurred box that stays
   * solid past the quick-link labels and the options button. Labels switch to the primary text color and the search
   * pill gets denser, so text keeps 4.5:1 on any picture at any dim setting.
   */
  .custom-backdrop {
    --home-label: var(--text);
    --home-pill: 84%;
  }

  .custom-backdrop .hero::before {
    inset: -72px -84px -60px;
    border-radius: 96px;
    background: color-mix(in oklab, var(--bg) 68%, transparent);
    filter: blur(30px);
  }

  .brand {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    color: var(--text);
  }

  .brand :global(.brand-mark) {
    /* Optical alignment: the hat makes the mark look lower than the wordmark's cap height. */
    transform: translateY(-3px);
  }

  .wordmark {
    margin: 0;
    font-family: var(--font-display);
    font-weight: var(--weight-wordmark);
    font-size: clamp(2.6rem, 4.6vw, 3.43rem);
    letter-spacing: var(--tracking-wordmark);
    line-height: 1;
    color: var(--text);
    outline: none;
  }

  .hero :global(.home-search) {
    margin-top: 26px;
  }

  .hero :global(.quick) {
    margin-top: 30px;
  }

  .panels {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: start;
    gap: var(--space-4);
    width: calc(100% - 2 * var(--page-pad-x));
    max-width: 920px;
    margin: 0 auto;
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding: 12px 12px 8px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-xl);
    background: var(--glass-bg-card);
    -webkit-backdrop-filter: var(--glass-filter);
    backdrop-filter: var(--glass-filter);
    box-shadow: var(--glass-inset), var(--shadow-raise);
  }

  .panel :global(.section-header) {
    min-height: 26px;
    align-items: center;
    padding: 0 4px;
  }

  .more {
    padding: 2px 6px;
    margin-right: -6px;
    border-radius: var(--radius-sm);
    color: var(--text-3);
    font-size: var(--text-sm);
    font-weight: 500;
    letter-spacing: 0;
    text-transform: none;
    text-decoration: none;
    transition: color var(--t-1) var(--ease-out);
  }

  .more:hover {
    color: var(--text);
  }

  .quiet {
    margin: 0;
    padding: 8px 4px 10px;
    color: var(--text-2);
    font-size: var(--text-sm);
  }

  .quiet.pending {
    visibility: hidden;
  }

  /* "Customize": bottom-right of the first screen, above the panels (novene's pill position). */
  .foot {
    position: absolute;
    z-index: 2;
    top: calc(var(--first-h) - 52px);
    right: var(--space-5);
  }

  .customize {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 34px;
    padding: 0 14px 0 12px;
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-pill);
    background: color-mix(in oklab, var(--bg) 80%, transparent);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
    color: var(--text-2);
    font-size: 0.9286rem;
    font-weight: 600;
    text-decoration: none;
    transition:
      color var(--t-1) var(--ease-out),
      border-color var(--t-1) var(--ease-out),
      background-color var(--t-1) var(--ease-out);
  }

  .customize:hover {
    color: var(--text);
    border-color: color-mix(in oklab, var(--text) 30%, transparent);
    background: color-mix(in oklab, var(--bg) 90%, transparent);
  }

  .customize:active {
    transform: scale(var(--press-scale));
  }

  :global(.reduce-transparency) .customize,
  :global(.no-gpu-effects) .customize {
    background: var(--surface-1);
  }

  /* Up to tablet width the panels stack and the pill moves to the end of the page. */
  @media (max-width: 860px) {
    .panels {
      grid-template-columns: minmax(0, 1fr);
      max-width: 560px;
      gap: var(--space-3);
    }

    .foot {
      position: static;
      display: flex;
      justify-content: center;
      padding-top: var(--space-5);
    }
  }

  /* Phones: the same first screen with a smaller hero; the first panel's header peeks in above the bottom bar. */
  @media (max-width: 759px) {
    .home {
      --peek: 64px;
      --first-h: max(380px, calc(var(--stage) - var(--peek)));
    }

    .first {
      padding: 0 16px;
    }

    .first::before,
    .first::after {
      min-height: 24px;
    }

    .panels {
      width: calc(100% - 32px);
    }

    .brand {
      gap: 10px;
    }

    .brand :global(.brand-mark) {
      --mark-h: 40px !important;
      transform: translateY(-2px);
    }

    .wordmark {
      font-size: 2.45rem;
    }

    .hero :global(.home-search) {
      margin-top: 20px;
    }

    .hero :global(.quick) {
      margin-top: 22px;
    }

    .hero::before {
      inset: -64px -40px -48px;
    }

    .custom-backdrop .hero::before {
      inset: -60px -60px -52px;
      border-radius: 72px;
      filter: blur(24px);
    }
  }
</style>
