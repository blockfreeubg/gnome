<!--
  The player (/play/:slug; docs/WAVE-C.md §5.3, D2, D24). The stage frames only GNOME's wrapper document
  `/play-frame/<slug>` (frameAttributes()); the wrapper holds the game's sandboxed frame. Before the first frame of a
  network loads in this browser, the stage shows the notice "Before you play" and nothing of the network loads until
  Play is pressed. The frame is created on mount (or on Play) and removed on unmount: leaving the page stops the game.
-->
<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Gamepad2 from '@lucide/svelte/icons/gamepad-2';
  import Heart from '@lucide/svelte/icons/heart';
  import Info from '@lucide/svelte/icons/info';
  import Maximize from '@lucide/svelte/icons/maximize';
  import Minimize from '@lucide/svelte/icons/minimize';
  import Play from '@lucide/svelte/icons/play';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Button from '../../components/Button.svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import Popover from '../../components/Popover.svelte';
  import Skeleton from '../../components/Skeleton.svelte';
  import type { PageProps } from '../../app/routes';
  import { settings } from '../../settings/store.svelte';
  import { gamesClient, linkHost, safeLink } from '../../games/api';
  import { onGamesChange } from '../../games/channel';
  import { noticeText, PLAYER_NOTE_DETAIL, playerNote, viaLine } from '../../games/copy';
  import { gameLibrary } from '../../games/library.svelte';
  import { allowedNetworks, allowNetwork } from '../../games/networks';
  import { frameAttributes, noticeNetwork, stageAspect } from '../../games/player';
  import { summaryOf } from '../../games/summary';
  import type { GameDetail, NetworkId } from '../../games/types';

  let { params }: PageProps = $props();

  const api = gamesClient();
  const lib = gameLibrary();
  const slug = $derived(params.slug ?? '');

  /** The click that opened this page (the detail page's Play) still counts while the browser's activation lasts. */
  const userActive = () => (navigator as { userActivation?: { isActive: boolean } }).userActivation?.isActive === true;

  let game = $state<GameDetail | null>(null);
  let gone = $state(false);
  let error = $state<string | null>(null);
  let attempt = $state(0);
  let allowed = $state<readonly NetworkId[]>(allowedNetworks());
  let started = $state(false);
  let recorded = false;
  let fullscreen = $state(false);
  let pressHint = $state(false);
  let noteOpen = $state(false);
  let stage = $state<HTMLElement>();
  let fsWrap = $state<HTMLElement>();
  let infoButton = $state<HTMLElement>();

  $effect(() => {
    const s = slug;
    void attempt;
    const ctrl = new AbortController();
    game = null;
    gone = false;
    error = null;
    started = false;
    recorded = false;
    api.game(s, { mobile: false, exclude: [] }, ctrl.signal).then(
      (p) => {
        if (ctrl.signal.aborted) return;
        if (p) game = p.game;
        else gone = true;
      },
      (err: unknown) => {
        if (!ctrl.signal.aborted) error = err instanceof Error ? err.message : 'The game could not be loaded.';
      },
    );
    return () => ctrl.abort();
  });

  const frame = $derived(game ? frameAttributes(game) : null);
  const network = $derived(game ? noticeNetwork(game) : null);
  const needsNotice = $derived(network !== null && !allowed.includes(network));
  const outHref = $derived(game ? safeLink(game.source_url) : null);
  const aspect = $derived(game ? stageAspect(game) : 16 / 9);
  const favorite = $derived(game ? lib.isFavorite(game.id) : false);

  // Without a notice to answer, the frame is created as soon as the game is known.
  $effect(() => {
    if (game && frame && !needsNotice && !started) void start(false);
  });

  async function start(gesture: boolean): Promise<void> {
    started = true;
    await tick();
    if (!settings.value.games.fullscreenOnPlay) return;
    if (gesture || userActive()) {
      void enterFullscreen();
    } else {
      pressHint = true;
      fsWrap?.querySelector('button')?.focus();
    }
  }

  function playAfterNotice(): void {
    if (!network) return;
    allowNetwork(network);
    allowed = allowedNetworks();
    void start(true);
  }

  async function enterFullscreen(): Promise<void> {
    if (!stage) return;
    try {
      await stage.requestFullscreen();
      pressHint = false;
      const o = game?.orientation;
      const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      if ((o === 'landscape' || o === 'portrait') && matchMedia('(pointer: coarse)').matches && orientation?.lock) {
        await orientation.lock(o).catch(() => undefined);
      }
    } catch {
      // Refused without a gesture: the button stays.
    }
  }

  function toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void enterFullscreen();
  }

  function onFrameLoad(): void {
    if (recorded || !game) return;
    recorded = true;
    void lib.recordPlay(summaryOf(game)).catch(() => undefined);
    void api.play(game.slug);
  }

  const onFsChange = () => (fullscreen = !!stage && document.fullscreenElement === stage);
  let offChange: (() => void) | undefined;
  onMount(() => {
    document.addEventListener('fullscreenchange', onFsChange);
    offChange = onGamesChange((kind) => {
      if (kind === 'networks') allowed = allowedNetworks();
    });
  });
  onDestroy(() => {
    document.removeEventListener('fullscreenchange', onFsChange);
    offChange?.();
    if (stage && document.fullscreenElement === stage) void document.exitFullscreen().catch(() => undefined);
  });
</script>

<div class="page play">
  {#if error}
    <div class="card">
      <EmptyState icon={Gamepad2} title="The game could not be loaded" description={error}>
        {#snippet actions()}
          <Button variant="outline" icon={RotateCcw} onclick={() => attempt++}>Try again</Button>
        {/snippet}
      </EmptyState>
    </div>
  {:else if gone}
    <div class="card">
      <EmptyState icon={Gamepad2} title="This game is not available" description="It may have been removed from this server's catalog.">
        {#snippet actions()}
          <Button href="/games" variant="outline" icon={ArrowLeft}>All games</Button>
        {/snippet}
      </EmptyState>
    </div>
  {:else if !game}
    <div class="head" aria-hidden="true"><Skeleton width="30%" height="28px" /></div>
    <div class="card stage-card"><Skeleton height="420px" radius="var(--radius-xl)" /></div>
  {:else}
    <header class="head">
      <div class="title-block">
        <h1 tabindex="-1">{game.title}</h1>
        <p class="via">{viaLine(game)}</p>
      </div>
      <div class="controls">
        <span class="fs" bind:this={fsWrap}>
          <Button variant="outline" icon={fullscreen ? Minimize : Maximize} disabled={!started || !frame} onclick={toggleFullscreen}
            >{fullscreen ? 'Exit fullscreen' : 'Fullscreen'}</Button
          >
        </span>
        <Button variant="outline" icon={Heart} aria-pressed={favorite} onclick={() => game && void lib.toggleFavorite(summaryOf(game))}
          >{favorite ? 'Remove from favorites' : 'Add to favorites'}</Button
        >
        <Button href="/games/{encodeURIComponent(game.slug)}" variant="ghost">Game details</Button>
      </div>
    </header>
    {#if pressHint}<p class="hint" role="status">Press Fullscreen to play in fullscreen</p>{/if}

    <div class="card stage-card">
      <div
        class="stage"
        class:fullscreen
        bind:this={stage}
        style:aspect-ratio={String(aspect)}
        style:--aspect={String(aspect)}
      >
        {#if !frame}
          <div class="message">
            <p>This game is not played on this server.</p>
            {#if outHref}<Button href={outHref} target="_blank" rel="noopener noreferrer" variant="primary" iconEnd={ExternalLink}>Open on {linkHost(outHref)}</Button>{/if}
          </div>
        {:else if needsNotice && network && !started}
          <section class="notice" aria-labelledby="notice-h">
            <h2 id="notice-h">Before you play</h2>
            <p>{noticeText(network)}</p>
            <Button variant="primary" size="lg" icon={Play} onclick={playAfterNotice}>Play</Button>
          </section>
        {:else if started}
          <iframe
            src={frame.src}
            title={frame.title}
            allow={frame.allow}
            allowfullscreen={frame.allowfullscreen}
            loading="eager"
            onload={onFrameLoad}
          ></iframe>
        {/if}
      </div>
    </div>

    <div class="below">
      <p class="note">
        <span>{playerNote(game)}</span>
        {#if game.source === 'oss'}
          <span class="license">{game.attribution}</span>
        {:else}
          <span bind:this={infoButton} class="info-anchor">
            <IconButton icon={Info} label="About this note" size="sm" onclick={() => (noteOpen = !noteOpen)} />
          </span>
        {/if}
      </p>
      {#if outHref}
        <a class="out" href={outHref} target="_blank" rel="noopener noreferrer">Problems? Open on {linkHost(outHref)}</a>
      {/if}
    </div>
    <Popover bind:open={noteOpen} anchor={infoButton} label="About this note" placement="bottom-start" width="320px">
      <p class="pop">{PLAYER_NOTE_DETAIL}</p>
    </Popover>
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
  .head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  h1 {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 800;
    font-size: 26px;
    letter-spacing: -0.03em;
  }
  h1:focus {
    outline: none;
  }
  .via {
    margin: 4px 0 0;
    font-size: 13px;
    color: var(--text-3);
  }
  .controls {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .fs {
    display: contents;
  }
  .hint {
    margin: 10px 0 0;
    font-size: 13px;
    color: var(--text-2);
  }
  .stage-card {
    padding: 10px;
  }
  .stage {
    position: relative;
    /* The frame fills the column, never taller than the visible area under the chrome and the header. */
    width: min(100%, calc((100dvh - 300px) * var(--aspect)));
    max-height: calc(100dvh - 300px);
    min-height: 240px;
    margin: 0 auto;
    border-radius: var(--radius-lg);
    overflow: hidden;
    background: #000;
  }
  .stage.fullscreen,
  .stage:fullscreen {
    width: 100vw;
    max-height: none;
    height: 100vh;
    border-radius: 0;
    aspect-ratio: auto !important;
  }
  iframe {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
  }
  .notice,
  .message {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: var(--space-6);
    text-align: center;
    background: var(--surface-1);
    color: var(--text);
  }
  .notice h2 {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 800;
    font-size: 20px;
    letter-spacing: -0.02em;
  }
  .notice p,
  .message p {
    margin: 0;
    max-width: 52ch;
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--text-2);
  }
  .below {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 12px;
    font-size: 12.5px;
  }
  .note {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: var(--text-3);
  }
  .license {
    color: var(--text-3);
  }
  .license::before {
    content: '· ';
  }
  .out {
    color: var(--text-2);
  }
  .pop {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-2);
  }
  @media (max-width: 759px) {
    .stage-card {
      margin-left: calc(-1 * var(--page-pad-x));
      margin-right: calc(-1 * var(--page-pad-x));
      border-radius: 0;
      border-left: 0;
      border-right: 0;
      padding: 0;
    }
    .stage {
      width: min(100%, calc((100dvh - 220px) * var(--aspect)));
      max-height: calc(100dvh - 220px);
      border-radius: 0;
    }
  }
</style>
