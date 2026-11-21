<!--
  Renders the current (non-persistent) page. Without the View Transitions API the swap cross-fades: both pages
  share one grid cell while the old one fades out and the new one fades in with a 6px rise.
-->
<script lang="ts">
  import type { Component } from 'svelte';
  import { fade, fadeRise } from '../components/motion';
  import { router } from './router.svelte';
  import type { PageProps } from './routes';

  const cur = $derived(router.current);
</script>

<div class="route-stack">
  {#if cur && cur.component}
    {@const Page = cur.component as Component<PageProps>}
    {#key `${cur.pageKey}#${router.reloads}`}
      <div
        class="route"
        in:fadeRise={{ duration: router.transition === 'crossfade' ? 240 : 0, delay: router.transition === 'crossfade' ? 40 : 0 }}
        out:fade={{ duration: router.transition === 'crossfade' ? 120 : 0 }}
      >
        <Page params={cur.params} query={cur.query} />
      </div>
    {/key}
  {/if}
</div>

<style>
  .route-stack {
    display: grid;
    min-height: 100%;
  }

  .route {
    grid-area: 1 / 1;
    min-width: 0;
  }
</style>
