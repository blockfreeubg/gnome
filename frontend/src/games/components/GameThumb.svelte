<!-- A game's thumbnail (only URLs thumbnailSrc accepts) or a monogram placeholder on error or without one. -->
<script lang="ts">
  import { thumbnailSrc } from '../api';
  import type { GameSummary } from '../types';

  interface Props {
    game: GameSummary;
    proxyOrigin: string | null;
    size: number;
    class?: string;
  }

  let { game, proxyOrigin, size, class: className = '' }: Props = $props();
  let failed = $state(false);
  const src = $derived(thumbnailSrc(game, proxyOrigin));
  const letter = $derived((game.title.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase());
  $effect(() => {
    void src;
    failed = false;
  });
</script>

<span class="thumb {className}" style:width="{size}px" style:height="{size}px" aria-hidden="true">
  {#if src && !failed}
    <img {src} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror={() => (failed = true)} />
  {:else}
    <span class="mono" style:font-size="{Math.round(size * 0.42)}px">{letter}</span>
  {/if}
</span>

<style>
  .thumb {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-radius: calc(var(--radius-xl) + 2px);
    background: var(--surface-2);
    border: 1px solid var(--hairline);
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .mono {
    font-family: var(--font-display);
    font-weight: 800;
    color: var(--text-3);
    letter-spacing: -0.03em;
  }
</style>
