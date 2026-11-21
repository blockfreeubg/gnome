<!-- Page title (Montserrat 800) + one-line description + optional actions. The h1 can receive focus after navigation. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    description?: string;
    eyebrow?: string;
    actions?: Snippet;
    children?: Snippet;
    /** Draw a hairline under the header. */
    divider?: boolean;
    class?: string;
  }

  let { title, description, eyebrow, actions, children, divider = true, class: className = '' }: Props = $props();
</script>

<!-- A <div>, not <header>: in the browser layer (role="main" on a <div>, not a <main> element) a <header> would be
     exposed as a banner landmark nested inside main. -->
<div class="page-header {className}" class:divider>
  <div class="text">
    {#if eyebrow}<p class="eyebrow">{eyebrow}</p>{/if}
    <h1 class="title" tabindex="-1">{title}</h1>
    {#if description}<p class="desc">{description}</p>{/if}
    {#if children}{@render children()}{/if}
  </div>
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</div>

<style>
  .page-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4) var(--space-6);
    flex-wrap: wrap;
    padding-bottom: var(--space-6);
  }

  .divider {
    border-bottom: 1px solid var(--hairline);
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    max-width: 72ch;
  }

  .eyebrow {
    margin-bottom: 2px;
  }

  .title {
    font-family: var(--font-display);
    font-variation-settings: var(--display-variation);
    font-weight: var(--weight-display, 800);
    font-size: var(--text-2xl); /* 26px (DESIGN.md §4 page title) */
    letter-spacing: var(--tracking-display);
    line-height: var(--lh-display);
    color: var(--text);
    outline: none;
  }

  .desc {
    color: var(--text-3);
    font-size: 0.9286rem; /* 13px: one quiet line under the title */
    line-height: 1.5;
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
</style>
