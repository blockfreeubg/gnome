<!--
  A titled group of rows inside a section: an eyebrow title above a glass card that holds the note (if any) and the
  rows, separated by hairlines (DESIGN.md §12 Settings). The title is hidden in search results (rows from many groups
  mix). A group whose rows are all hidden (search, or features not in this build) is hidden with them; `keep` keeps a
  group that has no rows of its own (a note).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { getSettingsSearch } from './ctx';

  interface Props {
    title?: string;
    note?: Snippet;
    /** Show the group even without rows (it only holds a note). */
    keep?: boolean;
    /** No card around the rows (content that brings its own card, such as the account panel). */
    bare?: boolean;
    children?: Snippet;
  }

  let { title, note, keep = false, bare = false, children }: Props = $props();
  const search = getSettingsSearch();
</script>

<div class="group settings-group" class:searching={search.active} class:keep>
  {#if title && !search.active}<h3 class="eyebrow group-title">{title}</h3>{/if}
  <div class="card" class:bare data-field-well>
    {#if note && !search.active}<div class="note">{@render note()}</div>{/if}
    {@render children?.()}
  </div>
</div>

<style>
  .group {
    display: flex;
    flex-direction: column;
  }

  /* No visible rows: nothing to show (the note and title would stand alone). */
  :global(.settings-group:not(.keep):not(:has([data-row]))) {
    display: none;
  }

  /* Spacing between the groups that are shown (hidden ones in between do not count). */
  :global(
    .settings-group:is(.keep, :has([data-row])) ~ .settings-group:is(.keep, :has([data-row]))
  ) {
    margin-top: var(--space-6);
  }

  :global(.settings-group.searching:is(.keep, :has([data-row])) ~ .settings-group.searching:is(.keep, :has([data-row]))) {
    margin-top: var(--space-3);
  }

  .group-title {
    margin: 0 0 var(--space-2) var(--space-1);
  }

  .card {
    display: flex;
    flex-direction: column;
    padding: 0 var(--space-5);
    background: var(--glass-bg-card);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-xl);
    box-shadow: var(--glass-inset), var(--shadow-raise);
  }

  .card.bare {
    padding: 0;
    background: none;
    border: 0;
    box-shadow: none;
  }

  /* Rows are separated by hairlines; the card's edge closes the last one. */
  .card > :global(.row:last-child .setting-row) {
    border-bottom: 0;
  }

  .note {
    padding: var(--space-4) 0;
    font-size: var(--text-sm);
    color: var(--text-2);
    line-height: 1.55;
    max-width: 72ch;
  }

  .note:not(:last-child) {
    border-bottom: 1px solid var(--hairline);
  }

  .note :global(strong) {
    color: var(--text);
    font-weight: 600;
  }

  @media (max-width: 759px) {
    .card {
      padding: 0 var(--space-4);
      border-radius: var(--radius-lg);
    }
  }
</style>
