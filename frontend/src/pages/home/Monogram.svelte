<!--
  Letter tile for a site (no favicons are fetched: requesting icons from sites directly would bypass the proxy).
  Monochrome like the rest of the chrome (DESIGN.md §1): a neutral tile with the first letter in Montserrat.
  `glass` is the translucent tile used over the Home backdrop.
-->
<script lang="ts">
  import { monogram } from '../../lib/url';

  interface Props {
    url: string;
    title?: string | null;
    size?: number;
    glass?: boolean;
    class?: string;
  }

  let { url, title, size = 44, glass = false, class: className = '' }: Props = $props();

  const letter = $derived(monogram(title, url));
</script>

<span class="monogram {className}" class:glass style:--size="{size}px" aria-hidden="true">{letter}</span>

<style>
  .monogram {
    display: grid;
    place-items: center;
    width: var(--size);
    height: var(--size);
    flex: none;
    border-radius: min(var(--radius-lg), calc(var(--size) * 0.32));
    background: var(--surface-3);
    box-shadow: inset 0 0 0 1px var(--hairline);
    color: var(--text-2);
    font-family: var(--font-display);
    font-weight: 700;
    font-size: calc(var(--size) * 0.4);
    letter-spacing: -0.02em;
    line-height: 1;
    user-select: none;
    transition:
      background-color var(--t-1) var(--ease-out),
      box-shadow var(--t-1) var(--ease-out),
      color var(--t-1) var(--ease-out);
  }

  .glass {
    background: var(--glass-bg-card);
    -webkit-backdrop-filter: var(--glass-filter);
    backdrop-filter: var(--glass-filter);
    box-shadow:
      inset 0 0 0 1px var(--hairline-strong),
      var(--glass-inset),
      0 10px 24px -14px rgba(0, 0, 0, 0.7);
    color: var(--text);
  }
</style>
