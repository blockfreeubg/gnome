<!--
  Letter tile for a page in the library lists. No favicons are fetched: requesting icons from sites directly would
  bypass the proxy and reveal the user's address. Monochrome (DESIGN.md v2): a neutral tile with the first letter.
-->
<script lang="ts">
  import { monogram } from '../../lib/url';

  interface Props {
    url: string;
    title?: string | null;
    size?: number;
  }

  let { url, title, size = 32 }: Props = $props();

  const letter = $derived(monogram(title, url));
</script>

<span class="tile" style:--size="{size}px" aria-hidden="true">{letter}</span>

<style>
  .tile {
    display: grid;
    place-items: center;
    width: var(--size);
    height: var(--size);
    flex: none;
    border-radius: calc(var(--radius) - 2px);
    background: var(--surface-3);
    box-shadow: inset 0 0 0 1px var(--hairline);
    color: var(--text-2);
    font-family: var(--font-display);
    font-weight: 700;
    font-size: calc(var(--size) * 0.42);
    line-height: 1;
    user-select: none;
  }
</style>
