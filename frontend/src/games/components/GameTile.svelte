<!--
  One game in a grid or shelf (DESIGN §12 "Games"): a square glass tile with the thumbnail and the title, a link to
  the game's page. Link-out games (itch.io, js13kGames) carry their badge; their page offers "Open on <host>".
  `unavailable`: a favorite or recent entry the server no longer lists — greyed, with Remove instead of a link.
-->
<script lang="ts">
  import { linkOutBadge, tileName } from '../copy';
  import type { GameSummary } from '../types';
  import GameThumb from './GameThumb.svelte';

  interface Props {
    game: GameSummary;
    proxyOrigin: string | null;
    width: number;
    unavailable?: boolean;
    onremove?: () => void;
    /** Grid cells handle keyboard focus themselves: their links are not tab stops. */
    tabindex?: number;
  }

  let { game, proxyOrigin, width, unavailable = false, onremove, tabindex }: Props = $props();
  const badge = $derived(linkOutBadge(game));
  const thumb = $derived(Math.round(width * 0.52));
</script>

{#if unavailable}
  <div class="tile gone" style:width="{width}px" style:height="{width}px">
    <GameThumb {game} {proxyOrigin} size={thumb} />
    <span class="title">{game.title}</span>
    <span class="note">No longer available</span>
    {#if onremove}<button type="button" class="remove" onclick={onremove} aria-label="Remove {game.title}">Remove</button>{/if}
  </div>
{:else}
  <a class="tile" href="/games/{encodeURIComponent(game.slug)}" style:width="{width}px" style:height="{width}px" aria-label={tileName(game)} {tabindex}>
    <GameThumb {game} {proxyOrigin} size={thumb} />
    <span class="title">{game.title}</span>
    {#if badge}<span class="badge">{badge}</span>{/if}
  </a>
{/if}

<style>
  .tile {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 12px;
    box-sizing: border-box;
    background: var(--glass-bg-card);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-xl);
    box-shadow: var(--glass-inset);
    color: var(--text);
    text-decoration: none;
    transition:
      transform var(--motion-move, 160ms) var(--ease-out, ease),
      border-color var(--motion-move, 160ms);
  }
  a.tile:hover {
    transform: translateY(-2px);
    border-color: var(--hairline-strong);
  }
  a.tile:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 3px;
  }
  .title {
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1.3;
    text-align: center;
    max-width: 100%;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .badge {
    position: absolute;
    top: 8px;
    right: 8px;
    font-size: 10.5px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    color: var(--text-2);
  }
  .gone {
    opacity: 0.55;
  }
  .note {
    font-size: 11.5px;
    color: var(--text-3);
  }
  .remove {
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
    background: transparent;
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius);
    padding: 3px 10px;
    cursor: pointer;
  }
  .remove:hover {
    background: var(--hover);
    color: var(--text);
  }
  @media (prefers-reduced-motion: reduce) {
    .tile {
      transition: none;
    }
    a.tile:hover {
      transform: none;
    }
  }
</style>
