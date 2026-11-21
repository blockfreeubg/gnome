<!-- Game details (/games/:slug) — placeholder page until the games feature lands. -->
<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Gamepad2 from '@lucide/svelte/icons/gamepad-2';
  import Button from '../../components/Button.svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import PageHeader from '../../components/PageHeader.svelte';
  import type { PageProps } from '../../app/routes';

  let { params }: PageProps = $props();
</script>

<div class="page narrow">
  <PageHeader title="Game" description="Details, instructions and attribution for a single game." />
  <div class="card">
    <EmptyState
      icon={Gamepad2}
      title="Game details are not available yet"
      description={`Information about “${params.slug ?? ''}” — description, controls, publisher and the play button — will appear here.`}
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
