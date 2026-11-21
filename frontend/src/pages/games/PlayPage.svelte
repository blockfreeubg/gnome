<!-- Game player (/play/:slug) — placeholder page until the games feature lands. -->
<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Play from '@lucide/svelte/icons/play';
  import Button from '../../components/Button.svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import PageHeader from '../../components/PageHeader.svelte';
  import type { PageProps } from '../../app/routes';

  let { params }: PageProps = $props();
</script>

<div class="page">
  <PageHeader title="Play" description="Games run here in a sandboxed player with fullscreen support." />
  <div class="card">
    <EmptyState
      icon={Play}
      title="The player is not available yet"
      description={`“${params.slug ?? ''}” will load here from the publisher's official embed.`}
    >
      {#snippet actions()}
        <Button href="/games" variant="outline" icon={ArrowLeft}>All games</Button>
      {/snippet}
    </EmptyState>
  </div>
</div>

<style>
  /* Placeholder until the feature lands: one glass card (DESIGN.md §9.4) holding an honest empty state. */
  .card {
    margin-top: var(--space-6);
    background: var(--glass-bg-card);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-xl);
    box-shadow: var(--glass-inset), var(--shadow-raise);
  }

  @media (max-width: 759px) {
    .card {
      margin-top: var(--space-4);
    }
  }
</style>
