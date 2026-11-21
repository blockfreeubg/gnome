<!--
  Interactive chip: a toggle filter (`selected` → aria-pressed) and/or removable (separate remove button).
  For static labels use Tag.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { LucideIcon } from '@lucide/svelte';
  import X from '@lucide/svelte/icons/x';
  import Icon from './Icon.svelte';

  interface Props {
    selected?: boolean;
    /** Render as a toggle (aria-pressed). Defaults to true when `selected` is provided. */
    toggle?: boolean;
    removable?: boolean;
    removeLabel?: string;
    icon?: LucideIcon;
    count?: number;
    size?: 'sm' | 'md';
    disabled?: boolean;
    onclick?: (ev: MouseEvent) => void;
    onremove?: () => void;
    class?: string;
    children: Snippet;
  }

  let {
    selected,
    toggle,
    removable = false,
    removeLabel = 'Remove',
    icon,
    count,
    size = 'md',
    disabled = false,
    onclick,
    onremove,
    class: className = '',
    children,
  }: Props = $props();

  const isToggle = $derived(toggle ?? selected !== undefined);
</script>

<span class="chip {size} {className}" class:selected class:disabled class:removable>
  <button
    type="button"
    class="main"
    aria-pressed={isToggle ? !!selected : undefined}
    {disabled}
    {onclick}
  >
    {#if icon}<Icon {icon} size={14} />{/if}
    <span class="text">{@render children()}</span>
    {#if count !== undefined}<span class="count">{count}</span>{/if}
  </button>
  {#if removable}
    <button type="button" class="remove" aria-label={removeLabel} {disabled} onclick={() => onremove?.()}>
      <X size={12} strokeWidth={2} aria-hidden="true" />
    </button>
  {/if}
</span>

<style>
  .chip {
    --h: calc(1.95rem * var(--density));
    display: inline-flex;
    align-items: center;
    height: var(--h);
    border-radius: var(--radius-pill);
    border: 1px solid var(--hairline-strong);
    background: var(--surface-1);
    color: var(--text-2);
    transition:
      background-color var(--t-1) var(--ease-out),
      border-color var(--t-1) var(--ease-out),
      color var(--t-1) var(--ease-out);
  }

  .sm {
    --h: calc(1.65rem * var(--density));
    font-size: var(--text-sm);
  }

  .main {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 100%;
    padding: 0 12px;
    border-radius: inherit;
    font-weight: 500;
    white-space: nowrap;
  }

  /* Invisible hit area at least --hit-min tall (the chip's border sits outside the button). */
  .main::after {
    content: '';
    position: absolute;
    inset: min(0px, calc((100% - var(--hit-min)) / 2)) 0;
  }

  .removable .main {
    padding-right: 4px;
  }

  .chip:hover:not(.disabled) {
    color: var(--text);
    border-color: var(--field-border-hover);
    background: var(--surface-2);
  }

  /* Text in --accent-strong: the accent itself drops under 4.5:1 on its own tint in the light theme. */
  .selected {
    background: var(--accent-soft);
    border-color: color-mix(in oklab, var(--accent) 45%, transparent);
    color: var(--accent-strong);
  }

  .selected:hover:not(.disabled) {
    background: color-mix(in oklab, var(--accent) 20%, transparent);
    border-color: color-mix(in oklab, var(--accent) 70%, transparent);
    color: var(--accent-strong);
  }

  .main:focus-visible,
  .remove:focus-visible {
    outline-offset: 1px;
  }

  .count {
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .remove {
    display: grid;
    place-items: center;
    width: 24px; /* WCAG 2.5.8 minimum target; 40px on touch screens (below) */
    height: 24px;
    margin-right: 2px;
    border-radius: 50%;
    color: inherit;
    opacity: 0.7;
  }

  .remove:hover {
    opacity: 1;
    background: var(--hover);
  }

  .disabled {
    opacity: 0.45;
  }

  .disabled button {
    cursor: not-allowed;
  }

  /* Touch screens: 40px targets (DESIGN.md §1.6); the remove button becomes a full square target. */
  @media (pointer: coarse) {
    .chip,
    .sm {
      --h: var(--hit-min);
    }

    .remove {
      width: var(--hit-min);
      height: var(--hit-min);
      margin-right: 0;
    }
  }
</style>
