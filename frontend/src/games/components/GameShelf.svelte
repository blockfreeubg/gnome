<!-- A horizontal row of tiles with a heading and an optional "See all" link (a region named by its title, §3.3). -->
<script lang="ts">
  import type { GameSummary } from '../types';
  import GameTile from './GameTile.svelte';

  interface Props {
    title: string;
    games: readonly GameSummary[];
    proxyOrigin: string | null;
    width: number;
    seeAll?: string;
    unavailable?: ReadonlySet<number>;
    onremove?: (game: GameSummary) => void;
  }

  let { title, games, proxyOrigin, width, seeAll, unavailable, onremove }: Props = $props();
  const id = $props.id();
</script>

<section class="shelf" aria-labelledby="{id}-h">
  <div class="head">
    <h2 id="{id}-h">{title}</h2>
    {#if seeAll}<a class="all" href={seeAll} aria-label="See all: {title}">See all</a>{/if}
  </div>
  <ul class="row" role="list">
    {#each games as game (game.id)}
      <li>
        <GameTile
          {game}
          {proxyOrigin}
          {width}
          unavailable={unavailable?.has(game.id) ?? false}
          onremove={onremove ? () => onremove(game) : undefined}
        />
      </li>
    {/each}
  </ul>
</section>

<style>
  .shelf {
    margin-top: var(--space-8);
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  h2 {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 17px;
    letter-spacing: -0.02em;
  }
  .all {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-2);
    text-decoration: none;
  }
  .all:hover {
    color: var(--text);
  }
  .row {
    display: flex;
    gap: 14px;
    margin: 0;
    padding: 4px 2px 10px;
    list-style: none;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    scrollbar-width: thin;
  }
  li {
    flex: none;
    scroll-snap-align: start;
  }
</style>
