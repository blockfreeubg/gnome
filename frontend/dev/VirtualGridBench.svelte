<!--
  VirtualGrid benchmark (dev/QA only): `count` catalog-style cards in a page scroller, like the Games page will use
  (scroller="parent"). Exposes `window.__bench` so scripts/visual-qa.mjs can measure mount time and scroll frames.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import VirtualGrid from '../src/components/VirtualGrid.svelte';

  interface Props {
    count: number;
  }

  let { count }: Props = $props();

  const started = performance.now();
  const items = $derived(
    Array.from({ length: count }, (_, i) => ({ id: i, title: `Game ${i + 1}`, category: ['Arcade', 'Puzzle', 'Racing', 'Sports'][i % 4] })),
  );
  let activeIndex = $state(-1);
  let activated = $state('');
  let scroller = $state<HTMLElement>();

  onMount(() => {
    requestAnimationFrame(() => {
      (window as unknown as { __bench: unknown }).__bench = {
        mountMs: performance.now() - started,
        count,
        scroller,
      };
    });
  });
</script>

<div class="page-scroller" bind:this={scroller}>
  <div class="page">
    <h1 class="title" tabindex="-1">VirtualGrid · {count.toLocaleString('en')} cards</h1>
    <p class="note">Last activated: <output id="activated">{activated}</output></p>
    <VirtualGrid
      {items}
      minItemWidth={180}
      itemHeight={(w) => Math.round((w * 9) / 16) + 46}
      gap={16}
      getKey={(it) => it.id}
      label="Games"
      bind:activeIndex
      onactivate={(it) => (activated = it.title)}
    >
      {#snippet item(it, s)}
        <article class="card" class:active={s.active}>
          <div class="thumb"><span>{it.category}</span></div>
          <h2>{it.title}</h2>
          <p>{it.category}</p>
        </article>
      {/snippet}
    </VirtualGrid>
  </div>
</div>

<style>
  :global(body) {
    overflow: hidden;
  }

  .page-scroller {
    position: fixed;
    inset: 0;
    overflow-y: auto;
  }

  .title {
    font-family: var(--font-display);
    font-size: var(--text-2xl);
    margin-bottom: var(--space-2);
  }

  .note {
    color: var(--text-2);
    margin-bottom: var(--space-6);
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    height: 100%;
  }

  .thumb {
    flex: 1;
    display: grid;
    place-items: end start;
    padding: 8px;
    border-radius: var(--radius);
    border: 1px solid var(--hairline);
    background: linear-gradient(135deg, var(--surface-2), var(--surface-1));
    color: var(--text-3);
    font-size: var(--text-xs);
  }

  .card.active .thumb {
    border-color: var(--accent);
  }

  h2 {
    font-size: var(--text-md);
    font-weight: 560;
  }

  p {
    font-size: var(--text-sm);
    color: var(--text-3);
  }
</style>
