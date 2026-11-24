<!--
  Game details (/games/:slug; docs/WAVE-C.md §5.1): title, network, Play (or "Open on <host>" for games this server
  does not frame), favorites, facts, description, instructions, the license of open-source games and related games.
  Every link to another site goes through safeLink() (https only, rel="noopener noreferrer", new tab).
-->
<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Gamepad2 from '@lucide/svelte/icons/gamepad-2';
  import Heart from '@lucide/svelte/icons/heart';
  import Play from '@lucide/svelte/icons/play';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Button from '../../components/Button.svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import Skeleton from '../../components/Skeleton.svelte';
  import type { PageProps } from '../../app/routes';
  import { server } from '../../app/server.svelte';
  import { settings } from '../../settings/store.svelte';
  import { filterFromSettings, gamesClient, linkHost, safeLink } from '../../games/api';
  import { FLAG_WORDS, ORIENTATION_WORDS, viaLine } from '../../games/copy';
  import { gameLibrary } from '../../games/library.svelte';
  import { frameAttributes } from '../../games/player';
  import type { GamePage } from '../../games/types';
  import GameShelf from '../../games/components/GameShelf.svelte';
  import GameThumb from '../../games/components/GameThumb.svelte';
  import LicensePanel from '../../games/components/LicensePanel.svelte';
  import { summaryOf } from '../../games/summary';

  let { params }: PageProps = $props();

  const api = gamesClient();
  const lib = gameLibrary();
  const proxyOrigin = $derived(server.config?.proxy.origin ?? null);
  const slug = $derived(params.slug ?? '');

  let page = $state<GamePage | null>(null);
  let gone = $state(false);
  let error = $state<string | null>(null);
  let attempt = $state(0);

  $effect(() => {
    const s = slug;
    void attempt;
    const games = settings.value.games;
    const ctrl = new AbortController();
    page = null;
    gone = false;
    error = null;
    (async () => {
      let known: string[] | null = null;
      try {
        known = (await api.categories(ctrl.signal)).map((c) => c.slug);
      } catch {
        known = null; // related games without the hidden categories filter
      }
      const p = await api.game(s, filterFromSettings(games, known), ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (p) page = p;
      else gone = true;
    })().catch((err: unknown) => {
      if (!ctrl.signal.aborted) error = err instanceof Error ? err.message : 'Games could not be loaded.';
    });
    return () => ctrl.abort();
  });

  const game = $derived(page?.game ?? null);
  const playable = $derived(game ? frameAttributes(game) !== null : false);
  const outHref = $derived(game ? safeLink(game.source_url) : null);
  const devHref = $derived(game ? safeLink(game.developer_url) : null);
  const favorite = $derived(game ? lib.isFavorite(game.id) : false);
  const facts = $derived.by(() => {
    if (!game) return [] as string[];
    const out: string[] = [];
    if (game.mobile) out.push('Works on touch screens');
    if (game.orientation && game.orientation !== 'any') out.push(ORIENTATION_WORDS[game.orientation]);
    for (const f of game.flags) out.push(FLAG_WORDS[f]);
    return out;
  });
</script>

<div class="page detail">
  {#if error}
    <div class="card">
      <EmptyState icon={Gamepad2} title="Games could not be loaded" description={error}>
        {#snippet actions()}
          <Button variant="outline" icon={RotateCcw} onclick={() => attempt++}>Try again</Button>
        {/snippet}
      </EmptyState>
    </div>
  {:else if gone}
    <div class="card">
      <EmptyState icon={Gamepad2} title="This game is not available" description="It may have been removed from this server's catalog." headingLevel={2}>
        {#snippet actions()}
          <Button href="/games" variant="outline" icon={ArrowLeft}>All games</Button>
        {/snippet}
      </EmptyState>
    </div>
  {:else if !game}
    <div class="hero card" aria-hidden="true">
      <Skeleton width="132px" height="132px" radius="var(--radius-xl)" />
      <div class="hero-text"><Skeleton width="40%" height="28px" /><Skeleton width="25%" /><Skeleton width="60%" height="40px" /></div>
    </div>
  {:else}
    <header class="hero card">
      <GameThumb game={summaryOf(game)} {proxyOrigin} size={132} />
      <div class="hero-text">
        <h1 tabindex="-1">{game.title}</h1>
        <p class="via">
          {viaLine(game)}{#if game.developer}
            · by {#if devHref}<a href={devHref} target="_blank" rel="noopener noreferrer">{game.developer}</a>{:else}{game.developer}{/if}{/if}
        </p>
        <div class="actions">
          {#if playable}
            <Button href="/play/{encodeURIComponent(game.slug)}" variant="primary" size="lg" icon={Play}>Play</Button>
          {:else if outHref}
            <Button href={outHref} target="_blank" rel="noopener noreferrer" variant="primary" size="lg" iconEnd={ExternalLink}>Open on {linkHost(outHref)}</Button>
          {:else}
            <p class="muted">This game cannot be played on this server.</p>
          {/if}
          <Button
            variant="outline"
            size="lg"
            icon={Heart}
            aria-pressed={favorite}
            onclick={() => void lib.toggleFavorite(summaryOf(game))}>{favorite ? 'Remove from favorites' : 'Add to favorites'}</Button
          >
        </div>
        {#if game.categories.length || facts.length}
          <ul class="chips" aria-label="Facts">
            {#each game.categories as c (c)}<li><a class="chip" href="/games?category={encodeURIComponent(c)}">{c.charAt(0).toUpperCase() + c.slice(1)}</a></li>{/each}
            {#each facts as f (f)}<li><span class="chip plain">{f}</span></li>{/each}
          </ul>
        {/if}
      </div>
    </header>

    {#if game.description}
      <section class="card section" aria-labelledby="about-h">
        <h2 id="about-h">About this game</h2>
        <p class="text">{game.description}</p>
      </section>
    {/if}
    {#if game.instructions}
      <section class="card section" aria-labelledby="how-h">
        <h2 id="how-h">How to play</h2>
        <p class="text">{game.instructions}</p>
      </section>
    {/if}
    {#if game.tags.length}
      <section class="card section" aria-labelledby="tags-h">
        <h2 id="tags-h">Tags</h2>
        <ul class="chips">
          {#each game.tags as t (t)}<li><a class="chip" href="/games?tag={encodeURIComponent(t)}">{t}</a></li>{/each}
        </ul>
      </section>
    {/if}
    {#if game.source === 'oss'}
      <div class="card section"><LicensePanel {game} {proxyOrigin} /></div>
    {/if}
    {#if page && page.related.length}
      <GameShelf title="More like this" games={page.related} {proxyOrigin} width={150} />
    {/if}
  {/if}
</div>

<style>
  .card {
    margin-top: var(--space-6);
    background: var(--glass-bg-card);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-xl);
    box-shadow: var(--glass-inset), var(--shadow-raise);
  }
  .hero {
    display: flex;
    gap: var(--space-6);
    padding: var(--space-6);
    align-items: flex-start;
  }
  .hero-text {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    flex: 1;
  }
  h1 {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 800;
    font-size: 26px;
    letter-spacing: -0.03em;
    overflow-wrap: anywhere;
  }
  h1:focus {
    outline: none;
  }
  .via {
    margin: 0;
    font-size: 13px;
    color: var(--text-3);
  }
  .via a {
    color: var(--text-2);
  }
  .actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 6px;
  }
  .muted {
    color: var(--text-3);
    font-size: 13px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 4px 0 0;
    padding: 0;
    list-style: none;
  }
  .chip {
    display: inline-block;
    font-size: 12px;
    font-weight: 500;
    padding: 3px 10px;
    border-radius: 999px;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    color: var(--text-2);
    text-decoration: none;
  }
  a.chip:hover {
    color: var(--text);
    border-color: var(--hairline-strong);
  }
  .section {
    padding: var(--space-5) var(--space-6);
  }
  .section h2,
  .section :global(h2) {
    margin: 0 0 10px;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 16px;
    letter-spacing: -0.02em;
  }
  .text {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.6;
    color: var(--text-2);
    white-space: pre-line;
  }
  @media (max-width: 759px) {
    .hero {
      flex-direction: column;
      padding: var(--space-5);
    }
    .actions > :global(*) {
      flex: 1 1 auto;
    }
  }
</style>
