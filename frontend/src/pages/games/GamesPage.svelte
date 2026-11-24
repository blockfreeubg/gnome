<!--
  Games catalog (/games; docs/WAVE-C.md §5.1, DESIGN §12 "Games"). The URL keeps q, category, tag and sort (replace
  navigation, so Back leaves the page). Without search, category, tag or a chosen sort: the shelves, then All games.
  Listings honour Settings → Games (touch screens only, hidden categories; the server applies them, D11).
-->
<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import Gamepad2 from '@lucide/svelte/icons/gamepad-2';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import SearchX from '@lucide/svelte/icons/search-x';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Button from '../../components/Button.svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import PageHeader from '../../components/PageHeader.svelte';
  import SearchInput from '../../components/SearchInput.svelte';
  import Select from '../../components/Select.svelte';
  import Skeleton from '../../components/Skeleton.svelte';
  import VirtualGrid from '../../components/VirtualGrid.svelte';
  import VirtualList from '../../components/VirtualList.svelte';
  import { navigate } from '../../app/router.svelte';
  import type { PageProps } from '../../app/routes';
  import { server } from '../../app/server.svelte';
  import { settings } from '../../settings/store.svelte';
  import { filterFromSettings, gamesClient } from '../../games/api';
  import { CatalogView } from '../../games/catalog.svelte';
  import { onGamesChange } from '../../games/channel';
  import { allowedNetworksLine, countText, emptyReason, linkOutBadge, statusLine, tileName, viaLine } from '../../games/copy';
  import { gameLibrary, snapshotOf } from '../../games/library.svelte';
  import { allowedNetworks, forgetNetworks } from '../../games/networks';
  import type { GameCategory, GameSections, GameSort, GameSummary, GamesStatus, NetworkId } from '../../games/types';
  import GameShelf from '../../games/components/GameShelf.svelte';
  import GameThumb from '../../games/components/GameThumb.svelte';
  import GameTile from '../../games/components/GameTile.svelte';

  let { query }: PageProps = $props();

  const api = gamesClient();
  const lib = gameLibrary();
  const SIZES = { small: 150, medium: 185, large: 230 } as const;
  const SORTS: ReadonlySet<string> = new Set<GameSort>(['relevance', 'popular', 'trending', 'new', 'featured', 'az']);

  const proxyOrigin = $derived(server.config?.proxy.origin ?? null);
  /** Before /api/config answered, assume the catalog exists (the requests tell). */
  const enabled = $derived(server.config ? server.config.features.games : true);

  const q = $derived(query.get('q') ?? '');
  const category = $derived(query.get('category') ?? '');
  const tag = $derived(query.get('tag') ?? '');
  const sortParam = $derived.by(() => {
    const s = query.get('sort') ?? '';
    return SORTS.has(s) ? (s as GameSort) : null;
  });
  const browsing = $derived(!q && !category && !tag);
  const showShelves = $derived(browsing && !sortParam);
  const sort = $derived<GameSort>(sortParam && (sortParam !== 'relevance' || q) ? sortParam : q ? 'relevance' : settings.value.games.defaultSort);

  let status = $state<GamesStatus | null>(null);
  let categories = $state<GameCategory[] | null>(null);
  let sections = $state<GameSections | null>(null);
  let loadError = $state<string | null>(null);
  let allowed = $state<readonly NetworkId[]>(allowedNetworks());
  let searchText = $state(untrack(() => query.get('q') ?? ''));
  let width = $state(0);

  const known = $derived(categories ? categories.map((c) => c.slug) : null);
  const filter = $derived(filterFromSettings(settings.value.games, known));
  const hidden = $derived(new Set(filter.exclude));
  const categoryName = $derived(categories?.find((c) => c.slug === category)?.name ?? category);

  const view = new CatalogView(api, () => filter);

  // Tile width: the card-size setting, at least two columns on phones (gap 14px).
  const tileWidth = $derived.by(() => {
    const want = SIZES[settings.value.games.cardSize] ?? 185;
    return width > 0 ? Math.max(110, Math.min(want, Math.floor((width - 14) / 2))) : want;
  });

  const gridLabel = $derived(q || tag ? 'Search results' : category ? `${categoryName} games` : 'All games');

  // The listing: restarts when the URL's filters, the sort or the settings filter change.
  $effect(() => {
    const next = {
      ...(q ? { q } : {}),
      ...(category ? { category } : {}),
      ...(tag ? { tag } : {}),
      sort,
      ...(browsing ? {} : { include_link_out: true }),
    };
    void filter.mobile;
    void filter.exclude.join(',');
    if (!enabled) return;
    untrack(() => (view.query = next));
  });

  // Shelves: one sections request for the current filter.
  $effect(() => {
    if (!showShelves || !enabled) return;
    const f = { mobile: filter.mobile, exclude: [...filter.exclude] };
    const ctrl = new AbortController();
    api.sections(f, ctrl.signal).then(
      (s) => (sections = s),
      (err: unknown) => {
        if (!ctrl.signal.aborted) loadError = err instanceof Error ? err.message : 'Games could not be loaded.';
      },
    );
    return () => ctrl.abort();
  });

  // The search field writes `q` 250 ms after the last keystroke; a changed URL (Clear search, Back) writes the field.
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const current = q;
    untrack(() => {
      if (searchText.trim() !== current) searchText = current;
    });
  });
  function onSearchInput(): void {
    clearTimeout(timer);
    timer = setTimeout(() => setParams({ q: searchText.trim() || null, sort: null }), 250);
  }

  function setParams(changes: Record<string, string | null>): void {
    const next = new URLSearchParams(query);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const qs = next.toString();
    void navigate(`/games${qs ? `?${qs}` : ''}`, { replace: true });
  }

  function clearSearch(): void {
    clearTimeout(timer);
    searchText = '';
    void navigate('/games', { replace: true });
  }

  async function loadMeta(): Promise<void> {
    loadError = null;
    try {
      const [s, c] = await Promise.all([api.status(), api.categories()]);
      status = s;
      categories = c;
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Games could not be loaded.';
    }
  }

  function retry(): void {
    void loadMeta();
    if (view.state === 'error') view.retry();
    if (showShelves && !sections) {
      api.sections({ mobile: filter.mobile, exclude: [...filter.exclude] }).then(
        (s) => (sections = s),
        () => undefined,
      );
    }
  }

  const favorites = $derived(lib.favorites.map((f) => snapshotOf(f)).filter((g): g is GameSummary => g !== null));
  const recent = $derived(lib.recent.map((r) => snapshotOf(r)).filter((g): g is GameSummary => g !== null));

  const categoryOptions = $derived([
    { value: '', label: 'All categories' },
    ...(categories ?? []).filter((c) => !hidden.has(c.slug)).map((c) => ({ value: c.slug, label: `${c.name} (${c.count})` })),
  ]);
  const sortOptions = $derived([
    ...(q ? [{ value: 'relevance', label: 'Best match' }] : []),
    { value: 'popular', label: 'Popular' },
    { value: 'trending', label: 'Trending' },
    { value: 'new', label: 'New' },
    { value: 'az', label: 'A–Z' },
    { value: 'featured', label: 'Featured' },
  ]);

  const empty = $derived(status !== null && status.listed === 0);
  const noMatch = $derived(!browsing && view.state === 'done' && view.total === 0);
  const failed = $derived(loadError !== null || view.state === 'error');
  const hiddenCount = $derived(filter.exclude.length);

  let offChange: (() => void) | undefined;
  onMount(() => {
    void loadMeta();
    void lib.refresh(api).catch(() => undefined);
    offChange = onGamesChange((kind) => {
      if (kind === 'networks') allowed = allowedNetworks();
    });
  });
  onDestroy(() => {
    clearTimeout(timer);
    offChange?.();
    view.dispose();
  });
</script>

<div class="page games">
  <PageHeader title="Games" description={status ? statusLine(status) : 'Free web games from licensed publishers.'} />
  <div bind:clientWidth={width}>

  {#if !enabled}
    <div class="card">
      <EmptyState icon={Gamepad2} title="Games are not available on this server" description="This server's operator has not enabled a game catalog." />
    </div>
  {:else if empty}
    <div class="card">
      <EmptyState icon={Gamepad2} title="No games yet" description={emptyReason(status)} />
    </div>
  {:else}
    {#if allowed.length}
      <p class="networks">
        <span>{allowedNetworksLine(allowed)}</span>
        <Button size="sm" variant="outline" onclick={() => forgetNetworks()}>Forget</Button>
      </p>
    {/if}

    <div class="toolbar">
      <SearchInput
        class="search"
        size="md"
        label="Search games"
        placeholder="Search games"
        bind:value={searchText}
        oninput={onSearchInput}
        onclear={clearSearch}
      />
      <div class="selects">
        <Select label="Category" value={category} options={categoryOptions} onchange={(v: string) => setParams({ category: v || null, tag: null })} />
        <Select label="Sort" value={sort} options={sortOptions} onchange={(v: string) => setParams({ sort: v })} />
      </div>
    </div>
    <div class="meta">
      {#if view.total !== null}<p role="status" class="count">{countText(view.total, !browsing)}</p>{:else}<p role="status" class="count"></p>{/if}
      {#if filter.mobile}<a class="filter" href="/settings/games">Touch screens only</a>{/if}
      {#if hiddenCount}<a class="filter" href="/settings/games">{hiddenCount === 1 ? '1 hidden category' : `${hiddenCount} hidden categories`}</a>{/if}
      {#if tag}<span class="filter tag">Tag: {tag}</span>{/if}
    </div>

    {#if failed}
      <div class="card alert">
        <EmptyState icon={TriangleAlert} size="sm" title="Games could not be loaded" description={loadError ?? view.error ?? ''}>
          {#snippet actions()}
            <Button variant="outline" icon={RotateCcw} onclick={retry}>Try again</Button>
          {/snippet}
        </EmptyState>
      </div>
    {/if}

    {#if showShelves}
      {#if lib.ready && favorites.length}
        <GameShelf title="Favorites" games={favorites} {proxyOrigin} width={tileWidth} unavailable={lib.unavailable} onremove={(g) => void lib.removeFavorite(g.id)} />
      {/if}
      {#if lib.ready && recent.length}
        <GameShelf title="Recently played" games={recent} {proxyOrigin} width={tileWidth} unavailable={lib.unavailable} onremove={(g) => void lib.removeRecent(g.id)} />
      {/if}
      {#if sections}
        {#if sections.featured.length}<GameShelf title="Featured" games={sections.featured} {proxyOrigin} width={tileWidth} seeAll="/games?sort=featured" />{/if}
        {#if sections.trending.length}<GameShelf title="Trending" games={sections.trending} {proxyOrigin} width={tileWidth} seeAll="/games?sort=trending" />{/if}
        {#if sections.popular.length}<GameShelf title="Popular" games={sections.popular} {proxyOrigin} width={tileWidth} seeAll="/games?sort=popular" />{/if}
        {#if sections.new.length}<GameShelf title="Recently added" games={sections.new} {proxyOrigin} width={tileWidth} seeAll="/games?sort=new" />{/if}
      {:else if !failed}
        <!-- One placeholder per section shelf (featured, trending, popular, new), sized like GameShelf, so the
             grid title below does not move when the sections arrive. -->
        {#each { length: 4 } as _, s (s)}
          <div class="shelf-skeleton" aria-hidden="true">
            <div class="shelf-skeleton-head"><Skeleton width="120px" height="14px" /></div>
            <div class="shelf-skeleton-row">
              {#each { length: 6 } as _, i (i)}<Skeleton width="{tileWidth}px" height="{tileWidth}px" radius="var(--radius-xl)" />{/each}
            </div>
          </div>
        {/each}
      {/if}
      <h2 class="grid-title">All games</h2>
    {/if}

    {#if noMatch}
      <div class="card">
        <EmptyState icon={SearchX} title="No games match" description="Try other words, another category or fewer filters.">
          {#snippet actions()}
            <Button variant="outline" onclick={clearSearch}>Clear search</Button>
          {/snippet}
        </EmptyState>
      </div>
    {:else if view.state === 'loading' && view.items.length === 0}
      <div class="skeleton-grid" style:grid-template-columns="repeat(auto-fill, minmax({tileWidth}px, 1fr))" aria-hidden="true">
        {#each { length: 12 } as _, i (i)}<Skeleton height="{tileWidth}px" radius="var(--radius-xl)" />{/each}
      </div>
    {:else if settings.value.games.view === 'list'}
      <VirtualList
        items={view.items}
        itemHeight={60}
        role="list"
        label={gridLabel}
        scroller="parent"
        getKey={(g) => g.id}
        onEndReached={() => view.loadMore()}
        onactivate={(g) => void navigate(`/games/${encodeURIComponent(g.slug)}`)}
      >
        {#snippet item(game)}
          <a class="row" href="/games/{encodeURIComponent(game.slug)}" aria-label={tileName(game)} tabindex="-1">
            <GameThumb {game} {proxyOrigin} size={40} />
            <span class="row-text">
              <span class="row-title">{game.title}</span>
              <span class="row-via">{viaLine(game)}{linkOutBadge(game) ? ` · ${linkOutBadge(game)}` : ''}</span>
            </span>
          </a>
        {/snippet}
      </VirtualList>
    {:else}
      <VirtualGrid
        items={view.items}
        minItemWidth={tileWidth}
        itemHeight={(w) => w}
        gap={14}
        label={gridLabel}
        scroller="parent"
        getKey={(g) => g.id}
        onEndReached={() => view.loadMore()}
        onactivate={(g) => void navigate(`/games/${encodeURIComponent(g.slug)}`)}
      >
        {#snippet item(game, ctx)}
          <GameTile {game} {proxyOrigin} width={ctx.width} tabindex={-1} />
        {/snippet}
      </VirtualGrid>
    {/if}
    {#if view.state === 'more'}<p class="more" aria-hidden="true">Loading more games…</p>{/if}
  {/if}
  </div>
</div>

<style>
  .card {
    margin-top: var(--space-6);
    background: var(--glass-bg-card);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-xl);
    box-shadow: var(--glass-inset), var(--shadow-raise);
  }
  .card.alert {
    margin-bottom: var(--space-4);
  }
  .networks {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin: var(--space-4) 0 0;
    font-size: 13px;
    color: var(--text-2);
  }
  .toolbar {
    display: flex;
    gap: 10px;
    margin-top: var(--space-6);
    align-items: center;
  }
  .toolbar :global(.search) {
    flex: 1 1 auto;
    min-width: 0;
  }
  .toolbar :global(input),
  .toolbar :global([role='combobox']) {
    min-height: 38px;
    border-radius: var(--radius-lg);
  }
  .selects {
    display: flex;
    gap: 10px;
    flex: none;
  }
  .selects :global([role='combobox']) {
    min-width: 170px;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    margin-top: 10px;
    min-height: 20px;
    font-size: 13px;
  }
  .count {
    margin: 0;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .filter {
    color: var(--text-2);
    font-size: 12.5px;
  }
  a.filter:hover {
    color: var(--text);
  }
  .grid-title {
    margin: var(--space-10) 0 12px;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 17px;
    letter-spacing: -0.02em;
  }
  .shelf-skeleton {
    margin-top: var(--space-8);
  }
  /* GameShelf's head: one 17px line at --lh-snug, then 12px. */
  .shelf-skeleton-head {
    display: flex;
    align-items: center;
    height: calc(17px * var(--lh-snug));
    margin-bottom: 12px;
  }
  /* GameShelf's row: 4px 2px 10px padding around square tiles. */
  .shelf-skeleton-row {
    display: flex;
    gap: 14px;
    padding: 4px 2px 10px;
    overflow: hidden;
  }
  .skeleton-grid {
    display: grid;
    gap: 14px;
    margin-top: var(--space-4);
  }
  .more {
    text-align: center;
    color: var(--text-3);
    font-size: 12.5px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 100%;
    padding: 0 10px;
    color: var(--text);
    text-decoration: none;
    border-radius: var(--radius);
  }
  .row:hover {
    background: var(--hover);
  }
  .row-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .row-title {
    font-size: 13.5px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row-via {
    font-size: 12px;
    color: var(--text-3);
  }
  @media (max-width: 759px) {
    .toolbar {
      flex-direction: column;
      align-items: stretch;
    }
    .selects > :global(*) {
      flex: 1 1 0;
      min-width: 0;
    }
    .selects :global([role='combobox']) {
      min-width: 0;
      width: 100%;
    }
  }
</style>
