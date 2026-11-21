<!-- Section heading: small eyebrow style (default) or a display title, with optional description and actions. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    description?: string;
    variant?: 'eyebrow' | 'title';
    level?: 2 | 3 | 4;
    id?: string;
    actions?: Snippet;
    class?: string;
  }

  let { title, description, variant = 'eyebrow', level = 2, id, actions, class: className = '' }: Props = $props();
</script>

<div class="section-header {variant} {className}">
  <div class="text">
    <svelte:element this={`h${level}`} {id} class="heading">{title}</svelte:element>
    {#if description}<p class="desc">{description}</p>{/if}
  </div>
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</div>

<style>
  .section-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    min-height: 28px;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .eyebrow .heading {
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: var(--tracking-eyebrow);
    text-transform: uppercase;
    color: var(--text-3);
  }

  .title .heading {
    font-family: var(--font-display);
    font-variation-settings: var(--display-variation);
    font-weight: var(--weight-heading, 700);
    font-size: 1.2857rem; /* 18px */
    letter-spacing: var(--tracking-heading);
    line-height: var(--lh-display);
  }

  .desc {
    color: var(--text-3);
    font-size: var(--text-sm);
    line-height: 1.45;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }
</style>
