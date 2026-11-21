<!--
  Square icon-only button. `label` is required: it is the accessible name and the tooltip text.
  `pressed` turns it into a toggle (aria-pressed). `shortcut`/`action` add key caps to the tooltip.
-->
<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import type { LucideIcon } from '@lucide/svelte';
  import type { ShortcutAction } from '../settings/schema';
  import type { Placement } from './floating';
  import Icon from './Icon.svelte';
  import Spinner from './Spinner.svelte';
  import { tooltip as tooltipAttachment } from './tooltip.svelte';

  interface Props extends Omit<HTMLButtonAttributes, 'class' | 'children'> {
    icon: LucideIcon;
    label: string;
    variant?: 'ghost' | 'secondary' | 'primary' | 'danger';
    size?: 'sm' | 'md' | 'lg';
    pressed?: boolean;
    loading?: boolean;
    tooltip?: boolean;
    tooltipPlacement?: Placement;
    shortcut?: string;
    action?: ShortcutAction;
    class?: string;
  }

  let {
    icon,
    label,
    variant = 'ghost',
    size = 'md',
    pressed,
    loading = false,
    tooltip = true,
    tooltipPlacement = 'top',
    shortcut,
    action,
    class: className = '',
    type = 'button',
    ...rest
  }: Props = $props();

  const iconSize = $derived(size === 'sm' ? 15 : size === 'lg' ? 20 : 18);
</script>

<button
  {...rest}
  {type}
  class="icon-btn {variant} {size} {className}"
  aria-label={label}
  aria-pressed={pressed === undefined ? undefined : pressed}
  aria-busy={loading ? 'true' : undefined}
  {@attach tooltipAttachment({
    text: label,
    placement: tooltipPlacement,
    disabled: !tooltip,
    ...(shortcut ? { shortcut } : {}),
    ...(action ? { action } : {}),
  })}
>
  {#if loading}
    <Spinner size={iconSize - 2} />
  {:else}
    <Icon {icon} size={iconSize} />
  {/if}
</button>

<style>
  .icon-btn {
    --size: var(--control-h);
    position: relative;
    display: inline-grid;
    place-items: center;
    width: var(--size);
    height: var(--size);
    flex: none;
    border-radius: var(--radius);
    border: 1px solid transparent;
    color: var(--text-2);
    transition:
      background-color var(--t-1) var(--ease-out),
      color var(--t-1) var(--ease-out),
      border-color var(--t-1) var(--ease-out),
      box-shadow var(--t-1) var(--ease-out),
      transform var(--t-1) var(--ease-out);
  }

  /* Invisible hit area of at least --hit-min (32px; 40px on touch screens). */
  .icon-btn::after {
    content: '';
    position: absolute;
    inset: min(0px, calc((var(--size) - var(--hit-min)) / 2));
  }

  .icon-btn:active:not(:disabled) {
    transform: scale(calc(1 - 0.04 * var(--motion-move)));
  }

  /* Small buttons live in dense chrome (tab strip, toolbar, rows): novene's 7px squares. */
  .sm {
    --size: var(--control-h-sm);
    border-radius: calc(var(--radius-sm) + 1px);
  }

  .lg {
    --size: var(--control-h-lg);
    border-radius: var(--radius-lg);
  }

  /* Idle chrome icons are quiet (--text-3, still ≥ 4.5:1); they light up on hover. */
  .ghost {
    color: var(--text-3);
  }

  .ghost:hover:not(:disabled) {
    background: var(--hover);
    color: var(--text);
  }

  .ghost:active:not(:disabled) {
    background: var(--press);
    color: var(--text);
  }

  .secondary {
    background: var(--surface-1);
    border-color: var(--hairline-strong);
    color: var(--text);
  }

  .secondary:hover:not(:disabled) {
    background: var(--surface-2);
    border-color: var(--field-border-hover);
  }

  .primary {
    background: var(--accent);
    color: var(--accent-ink);
    box-shadow: var(--shadow-accent);
  }

  .primary:hover:not(:disabled) {
    background: var(--accent-strong);
  }

  .danger {
    color: var(--danger);
  }

  .danger:hover:not(:disabled) {
    background: var(--danger-soft);
  }

  /* Toggled on: the monochrome "current" tile (a white tint in a rounded square, DESIGN.md §1.2). */
  .icon-btn[aria-pressed='true'] {
    color: var(--text);
    background: var(--selected);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
  }

  .primary[aria-pressed='true'] {
    color: var(--accent-ink);
    background: var(--accent-strong);
  }

  .icon-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  @media (forced-colors: active) {
    .icon-btn[aria-pressed='true'] {
      outline: 1px solid Highlight;
    }
  }
</style>
