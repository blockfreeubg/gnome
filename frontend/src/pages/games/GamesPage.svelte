<!-- Games catalog — placeholder page until the games feature lands. -->
<script lang="ts">
  import Gamepad2 from '@lucide/svelte/icons/gamepad-2';
  import Settings2 from '@lucide/svelte/icons/settings-2';
  import Button from '../../components/Button.svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import PageHeader from '../../components/PageHeader.svelte';
  import type { PageProps } from '../../app/routes';

  let {}: PageProps = $props();
</script>

<div class="page">
  <PageHeader title="Games" description="Free web games from licensed publishers, ready to play in the browser." />
  <div class="card">
    <EmptyState
      icon={Gamepad2}
      title="No games to show yet"
      description="Search, categories, trending and new releases, your favorites and recently played games will be listed here."
    >
      {#snippet actions()}
        <Button href="/settings/games" variant="outline" icon={Settings2}>Games settings</Button>
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
