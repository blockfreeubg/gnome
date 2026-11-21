<!--
  A row in a hairline-separated list: leading visual, title, subtitle, trailing meta/actions.
  Interactive when given `href` (link) or `onclick` (button); trailing actions stay separate controls.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    subtitle?: string;
    meta?: string;
    href?: string;
    onclick?: (ev: MouseEvent) => void;
    oncontextmenu?: (ev: MouseEvent) => void;
    active?: boolean;
    divider?: boolean;
    monoSubtitle?: boolean;
    leading?: Snippet;
    trailing?: Snippet;
    class?: string;
  }

  let {
    title,
    subtitle,
    meta,
    href,
    onclick,
    oncontextmenu,
    active = false,
    divider = true,
    monoSubtitle = false,
    leading,
    trailing,
    class: className = '',
  }: Props = $props();
</script>

{#snippet body()}
  {#if leading}<span class="leading">{@render leading()}</span>{/if}
  <span class="text">
    <span class="title">{title}</span>
    {#if subtitle}<span class="subtitle" class:mono={monoSubtitle}>{subtitle}</span>{/if}
  </span>
  {#if meta}<span class="meta">{meta}</span>{/if}
{/snippet}

<div class="row {className}" class:divider class:active class:interactive={!!href || !!onclick}>
  {#if href}
    <a class="main" {href} {onclick} {oncontextmenu} aria-current={active ? 'true' : undefined}>{@render body()}</a>
  {:else if onclick}
    <button type="button" class="main" {onclick} {oncontextmenu} aria-current={active ? 'true' : undefined}>{@render body()}</button>
  {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="main" {oncontextmenu}>{@render body()}</div>
  {/if}
  {#if trailing}<span class="trailing">{@render trailing()}</span>{/if}
</div>

<style>
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--row-h);
  }

  .row.divider:not(:first-child)::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 1px;
    background: var(--hairline);
  }

  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: calc(var(--pad-y) + 2px) var(--space-2);
    margin: 0 calc(var(--space-2) * -1);
    border-radius: var(--radius);
    text-align: left;
    color: inherit;
    text-decoration: none;
    transition: background-color var(--t-1) var(--ease-out);
  }

  .interactive .main:hover {
    background: var(--hover);
  }

  .interactive .main:focus-visible {
    outline-offset: -2px;
  }

  /* The current row is monochrome like the rail (DESIGN.md §1.2): a white tint in a rounded box. */
  .active .main {
    background: var(--selected);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
  }

  .interactive.active .main:hover {
    background: var(--selected);
  }

  .leading {
    display: grid;
    place-items: center;
    flex: none;
    color: var(--text-3);
  }

  .interactive .main:hover .leading,
  .active .leading {
    color: var(--text);
  }

  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .title,
  .subtitle {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title {
    color: var(--text);
    font-size: 0.9286rem; /* 13px */
    font-weight: 500;
  }

  .subtitle {
    font-size: var(--text-sm);
    color: var(--text-3);
  }

  .subtitle.mono {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .meta {
    flex: none;
    font-size: var(--text-sm);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .trailing {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }
</style>
