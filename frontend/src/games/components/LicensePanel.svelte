<!-- The License region of an open-source game (§5.1): SPDX license, the copyright line, source code, license text, the
     pinned commit. Links only through safeLink/licenseLink; anything else is shown as text. -->
<script lang="ts">
  import { licenseLink, safeLink } from '../api';
  import type { GameDetail } from '../types';

  interface Props {
    game: GameDetail;
    proxyOrigin: string | null;
  }

  let { game, proxyOrigin }: Props = $props();
  const id = $props.id();
  const repo = $derived(safeLink(game.oss?.repository ?? null));
  const licenseHref = $derived(licenseLink(game, proxyOrigin));
  /** "MIT · Copyright (c) 2014 …" → the copyright part. */
  const copyright = $derived(game.attribution.includes(' · ') ? game.attribution.slice(game.attribution.indexOf(' · ') + 3) : game.attribution);
</script>

<section class="panel" aria-labelledby="{id}-h">
  <h2 id="{id}-h">License</h2>
  <dl>
    <dt>License</dt>
    <dd>{game.license ?? 'Not stated'}</dd>
    <dt>Copyright</dt>
    <dd>{copyright}</dd>
    {#if game.oss?.commit}
      <dt>Commit</dt>
      <dd class="mono">{game.oss.commit}</dd>
    {/if}
  </dl>
  <p class="links">
    {#if repo}<a href={repo} target="_blank" rel="noopener noreferrer">Source code</a>{:else if game.oss?.repository}<span>{game.oss.repository}</span>{/if}
    {#if licenseHref}<a href={licenseHref} target="_blank" rel="noopener noreferrer">License text</a>{/if}
  </p>
</section>

<style>
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 6px 16px;
    margin: 0;
    font-size: 13px;
  }
  dt {
    color: var(--text-3);
  }
  dd {
    margin: 0;
    color: var(--text-2);
    overflow-wrap: anywhere;
  }
  .mono {
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .links {
    display: flex;
    gap: 16px;
    margin: 12px 0 0;
    font-size: 13px;
  }
</style>
