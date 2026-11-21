<!-- 404 for unknown client routes: a centered card (DESIGN.md §12) with the mark, the path and the ways out. -->
<script lang="ts">
  import Globe from '@lucide/svelte/icons/globe';
  import House from '@lucide/svelte/icons/house';
  import Search from '@lucide/svelte/icons/search';
  import Button from '../../components/Button.svelte';
  import Logo from '../../components/Logo.svelte';
  import { shell } from '../../app/shell.svelte';
  import type { PageProps } from '../../app/routes';

  let { params }: PageProps = $props();

  const path = $derived(params.wildcard || '');
</script>

<div class="page notfound">
  <section class="card" aria-labelledby="notfound-title">
    <span class="mark"><Logo size={40} decorative /></span>
    <p class="code">404</p>
    <h1 id="notfound-title" class="title" tabindex="-1">Page not found</h1>
    <p class="desc">This page does not exist{path ? ':' : '.'}</p>
    {#if path}<p class="path" title={path}>{path}</p>{/if}
    <div class="actions">
      <Button href="/" variant="primary" size="lg" icon={House}>Go home</Button>
      <Button href="/browse" variant="outline" size="lg" icon={Globe}>Open the browser</Button>
    </div>
    <button type="button" class="link" onclick={() => shell.openPalette()}>
      <Search size={14} strokeWidth={1.75} aria-hidden="true" />Search GNOME
    </button>
  </section>
</div>

<style>
  .notfound {
    min-height: min(78vh, 760px);
    display: grid;
    place-items: center;
  }

  /* ivy card: 400px, glass, 24px radius, big soft shadow. */
  .card {
    width: min(400px, 100%);
    display: flex;
    flex-direction: column;
    align-items: stretch;
    padding: 32px 28px 26px;
    background: var(--glass-bg-card);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-2xl);
    box-shadow: var(--glass-inset), var(--shadow-card);
  }

  .mark {
    display: flex;
    margin-bottom: var(--space-5);
    color: var(--text);
  }

  .code {
    margin: 0 0 var(--space-1);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: var(--tracking-eyebrow);
    color: var(--text-3);
  }

  .title {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 800;
    font-size: 24px;
    letter-spacing: -0.03em;
    line-height: 1.15;
    color: var(--text);
    outline: none;
  }

  .desc {
    margin: var(--space-2) 0 0;
    color: var(--text-3);
    font-size: 13px;
    font-weight: 500;
  }

  .path {
    margin: var(--space-3) 0 0;
    padding: 10px 12px;
    border-radius: calc(var(--radius) + 3px);
    background: var(--field-bg);
    border: 1px solid var(--field-border);
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-top: var(--space-6);
  }

  .actions :global(.btn) {
    width: 100%;
    justify-content: center;
  }

  .link {
    align-self: center;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: var(--space-4);
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    color: var(--accent);
    font-size: 13px;
    font-weight: 600;
  }

  .link:hover {
    color: var(--accent-strong);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  @media (max-width: 759px) {
    .card {
      padding: 24px 20px;
    }
  }
</style>
