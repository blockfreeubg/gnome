<script lang="ts">
  import Chip from '../../../components/Chip.svelte';
  import SegmentedControl from '../../../components/SegmentedControl.svelte';
  import Select from '../../../components/Select.svelte';
  import Skeleton from '../../../components/Skeleton.svelte';
  import Switch from '../../../components/Switch.svelte';
  import { server } from '../../../app/server.svelte';
  import { api } from '../../../lib/api';
  import type { Settings } from '../../../settings/schema';
  import { settings } from '../../../settings/store.svelte';
  import Group from '../Group.svelte';
  import Row from '../Row.svelte';

  type Games = Settings['games'];
  const S = 'games' as const;
  const g = $derived(settings.value.games);
  const set = <K extends keyof Games>(k: K, v: Games[K]): void => void settings.set(S, k, v);

  interface Category {
    slug: string;
    name: string;
    count: number;
  }
  let categories = $state<Category[] | null>(null);
  let loadError = $state<string | null>(null);

  $effect(() => {
    if (server.config && !server.config.features.games) return;
    const ctrl = new AbortController();
    api
      .get<{ categories: Category[] }>('/api/games/categories', { signal: ctrl.signal, timeoutMs: 8000 })
      .then((r) => {
        categories = Array.isArray(r?.categories) ? r.categories.filter((c) => typeof c.slug === 'string') : [];
        loadError = null;
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        loadError = err instanceof Error ? err.message : 'unavailable';
      });
    return () => ctrl.abort();
  });

  /** Known categories plus hidden slugs the server no longer lists (still removable). */
  const shown = $derived.by(() => {
    const list = (categories ?? []).map((c) => ({ slug: c.slug, name: c.name, count: c.count as number | undefined }));
    for (const slug of g.hiddenCategories) if (!list.some((c) => c.slug === slug)) list.push({ slug, name: slug, count: undefined });
    return list;
  });

  function toggle(slug: string): void {
    const hidden = g.hiddenCategories.includes(slug) ? g.hiddenCategories.filter((s) => s !== slug) : [...g.hiddenCategories, slug];
    set('hiddenCategories', hidden);
  }
</script>

<Group title="Catalog">
  <Row section={S} id="view">
    {#snippet control()}
      <SegmentedControl
        label="Catalog view"
        value={g.view}
        options={[
          { value: 'grid', label: 'Grid' },
          { value: 'list', label: 'List' },
        ]}
        onchange={(v) => set('view', v)}
      />
    {/snippet}
  </Row>
  <Row section={S} id="cardSize">
    {#snippet control()}
      <SegmentedControl
        label="Card size"
        value={g.cardSize}
        options={[
          { value: 'small', label: 'Small' },
          { value: 'medium', label: 'Medium' },
          { value: 'large', label: 'Large' },
        ]}
        onchange={(v) => set('cardSize', v)}
      />
    {/snippet}
  </Row>
  <Row section={S} id="defaultSort">
    {#snippet control()}
      <Select
        value={g.defaultSort}
        options={[
          { value: 'popular', label: 'Popular' },
          { value: 'trending', label: 'Trending' },
          { value: 'new', label: 'Newest' },
          { value: 'az', label: 'A to Z' },
        ]}
        onchange={(v) => set('defaultSort', v)}
      />
    {/snippet}
  </Row>
  <Row section={S} id="showMobileOnly">
    {#snippet control()}
      <Switch checked={g.showMobileOnly} onchange={(v) => set('showMobileOnly', v)} />
    {/snippet}
  </Row>
  <Row section={S} id="hiddenCategories" stacked>
    {#snippet control()}
      {#if server.config && !server.config.features.games}
        <p class="subtle text-sm">This server does not offer the games catalog.</p>
      {:else if categories === null && !loadError}
        <Skeleton height="28px" width="min(100%, 420px)" />
      {:else}
        {#if loadError && !shown.length}
          <p class="subtle text-sm">The category list could not be loaded from the server.</p>
        {/if}
        <div class="chips" role="group" aria-label="Categories (selected ones are hidden)">
          {#each shown as c (c.slug)}
            <Chip selected={g.hiddenCategories.includes(c.slug)} count={c.count} size="sm" onclick={() => toggle(c.slug)}>
              {g.hiddenCategories.includes(c.slug) ? 'Hidden: ' : ''}{c.name}
            </Chip>
          {/each}
        </div>
      {/if}
    {/snippet}
  </Row>
</Group>

<Group title="Playing">
  <Row section={S} id="fullscreenOnPlay">
    {#snippet control()}
      <Switch checked={g.fullscreenOnPlay} onchange={(v) => set('fullscreenOnPlay', v)} />
    {/snippet}
  </Row>
  <Row section={S} id="trackRecent">
    {#snippet control()}
      <Switch checked={g.trackRecent} onchange={(v) => set('trackRecent', v)} />
    {/snippet}
  </Row>
  <Row section={S} id="recentLimit" disabled={!g.trackRecent}>
    {#snippet control()}
      <Select
        value={String(g.recentLimit)}
        options={[10, 25, 50, 100, 200, 500]
          .concat([10, 25, 50, 100, 200, 500].includes(g.recentLimit) ? [] : [g.recentLimit])
          .map((n) => ({ value: String(n), label: `${n} games` }))}
        onchange={(v) => set('recentLimit', Number(v))}
      />
    {/snippet}
  </Row>
</Group>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
</style>
