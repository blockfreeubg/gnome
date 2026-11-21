<!-- Bottom navigation under 760px: the mobile destinations plus a "More" sheet. -->
<script lang="ts">
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Icon from '../components/Icon.svelte';
  import { openSheet } from './overlays/sheets.svelte';
  import { router } from './router.svelte';
  import { mobileNav, pathFor } from './routes';
  import MoreSheet from './MoreSheet.svelte';

  const nav = $derived(mobileNav());
  const items = $derived(nav.bar);
  /** Highlighted only for destinations that live in the sheet (not for pages outside the navigation, e.g. a 404). */
  const moreActive = $derived(nav.more.some((r) => router.isActive(r.id)));
  let moreOpen = $state(false);

  function openMore(): void {
    moreOpen = true;
    openSheet(MoreSheet, {}, { title: 'More', side: 'bottom', onclose: () => (moreOpen = false) });
  }
</script>

<nav class="mobile-bar" aria-label="Primary">
  <ul role="list">
    {#each items as r (r.id)}
      {@const active = router.isActive(r.id)}
      <li>
        <a href={pathFor(r.id)} class="tab" aria-current={active ? 'page' : undefined}>
          <Icon icon={r.nav.icon} size={20} />
          <span>{r.nav.label}</span>
        </a>
      </li>
    {/each}
    <li>
      <button type="button" class="tab" class:active={moreActive} aria-haspopup="dialog" aria-expanded={moreOpen} onclick={openMore}>
        <Icon icon={Ellipsis} size={20} />
        <span>More</span>
      </button>
    </li>
  </ul>
</nav>

<style>
  .mobile-bar {
    position: relative;
    z-index: var(--z-rail);
    height: calc(var(--bottom-bar-h) + var(--safe-bottom));
    padding-bottom: var(--safe-bottom);
    background: var(--chrome-bg);
    -webkit-backdrop-filter: var(--chrome-filter);
    backdrop-filter: var(--chrome-filter);
    border-top: 1px solid var(--hairline);
  }

  ul {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    height: var(--bottom-bar-h);
    margin: 0;
    padding: 0 4px;
  }

  .tab {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    width: 100%;
    height: 100%;
    color: var(--text-3);
    font-size: var(--text-xs); /* follows Settings → Appearance → Font size */
    font-weight: 500;
    letter-spacing: 0.01em;
    transition: color var(--t-1) var(--ease-out);
  }

  /* The icon sits in a rounded tile; the current destination fills it (monochrome, DESIGN.md §9.2). */
  .tab :global(svg) {
    box-sizing: content-box;
    padding: 4px 14px;
    border-radius: var(--radius-pill);
    transition:
      background-color var(--t-1) var(--ease-out),
      box-shadow var(--t-1) var(--ease-out);
  }

  .tab:hover {
    color: var(--text-2);
  }

  .tab[aria-current='page'],
  .tab.active {
    color: var(--text);
  }

  .tab[aria-current='page'] :global(svg),
  .tab.active :global(svg) {
    background: var(--selected);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
  }

  .tab:focus-visible {
    outline-offset: -4px;
    border-radius: var(--radius);
  }
</style>
