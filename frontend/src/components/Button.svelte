<!--
  Button: primary · secondary · ghost · danger · inverse · outline; sm · md · lg; loading state (keeps its width,
  announces busy). DESIGN.md §10: primary = the accent action (one per view), inverse = the high-contrast neutral
  action (white on dark, ink on light), outline = the quiet tertiary action.
  Renders an <a> when `href` is set (internal links are handled by the router).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
  import type { LucideIcon } from '@lucide/svelte';
  import Icon from './Icon.svelte';
  import Spinner from './Spinner.svelte';

  interface Props extends Omit<HTMLButtonAttributes, 'class' | 'children'> {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'inverse' | 'outline';
    size?: 'sm' | 'md' | 'lg';
    icon?: LucideIcon;
    iconEnd?: LucideIcon;
    loading?: boolean;
    full?: boolean;
    href?: string;
    target?: string;
    rel?: string;
    class?: string;
    children?: Snippet;
  }

  let {
    variant = 'secondary',
    size = 'md',
    icon,
    iconEnd,
    loading = false,
    full = false,
    href,
    target,
    rel,
    class: className = '',
    children,
    onclick,
    disabled,
    type = 'button',
    ...rest
  }: Props = $props();

  const iconSize = $derived(size === 'sm' ? 14 : size === 'lg' ? 18 : 16);

  function handleClick(ev: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }): void {
    if (loading) {
      ev.preventDefault();
      return;
    }
    onclick?.(ev);
  }

  function handleLinkClick(ev: MouseEvent & { currentTarget: EventTarget & HTMLAnchorElement }): void {
    if (loading || disabled) {
      ev.preventDefault();
      return;
    }
    // Same handler contract as the <button> variant (the event target type differs only nominally).
    onclick?.(ev as unknown as MouseEvent & { currentTarget: EventTarget & HTMLButtonElement });
  }
</script>

{#snippet content()}
  {#if loading}
    <Spinner size={iconSize} />
  {:else if icon}
    <Icon {icon} size={iconSize} />
  {/if}
  {#if children}<span class="label">{@render children()}</span>{/if}
  {#if iconEnd && !loading}<Icon icon={iconEnd} size={iconSize} />{/if}
{/snippet}

{#if href !== undefined}
  <a
    {...rest as HTMLAnchorAttributes}
    href={disabled ? undefined : href}
    {target}
    rel={rel ?? (target === '_blank' ? 'noopener noreferrer' : undefined)}
    class="btn {variant} {size} {className}"
    class:full
    role={disabled ? 'link' : undefined}
    aria-disabled={disabled || loading ? 'true' : undefined}
    aria-busy={loading ? 'true' : undefined}
    onclick={handleLinkClick}
  >
    {@render content()}
  </a>
{:else}
  <button
    {...rest}
    {type}
    {disabled}
    class="btn {variant} {size} {className}"
    class:full
    aria-busy={loading ? 'true' : undefined}
    aria-disabled={loading ? 'true' : undefined}
    onclick={handleClick}
  >
    {@render content()}
  </button>
{/if}

<style>
  .btn {
    --btn-h: var(--control-h);
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    height: var(--btn-h);
    padding: 0 calc(var(--control-px) + 2px);
    border: 1px solid transparent;
    border-radius: var(--radius);
    font-size: 0.9286rem; /* 13px */
    font-weight: 600;
    letter-spacing: -0.005em;
    line-height: 1;
    white-space: nowrap;
    user-select: none;
    text-decoration: none;
    cursor: pointer;
    transition:
      background-color var(--t-1) var(--ease-out),
      border-color var(--t-1) var(--ease-out),
      color var(--t-1) var(--ease-out),
      box-shadow var(--t-2) var(--ease-out),
      transform var(--t-1) var(--ease-out);
  }

  .btn:focus-visible {
    outline-offset: 3px;
  }

  /* Invisible hit area at least --hit-min tall (32px; 40px on touch screens). */
  .btn::after {
    content: '';
    position: absolute;
    inset: min(0px, calc((var(--btn-h) - var(--hit-min)) / 2)) 0;
  }

  .btn:active:not(:disabled):not([aria-disabled='true']) {
    transform: scale(var(--press-scale));
  }

  .label {
    display: inline-flex;
    align-items: center;
  }

  .full {
    width: 100%;
  }

  .sm {
    --btn-h: var(--control-h-sm);
    padding: 0 var(--control-px);
    font-size: var(--text-sm);
    gap: 6px;
  }

  .lg {
    --btn-h: var(--control-h-lg);
    padding: 0 calc(var(--control-px) + 8px);
    border-radius: var(--radius-lg);
    font-size: var(--text-md);
  }

  /* ── primary: the accent action (ivy "Sign in") ── */
  .primary {
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 700;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.22),
      var(--shadow-accent);
  }
  .primary:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--accent-strong);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.22),
      0 10px 30px color-mix(in oklab, var(--accent) 26%, transparent);
  }

  /* ── secondary: a raised neutral control ── */
  .secondary {
    background: var(--surface-1);
    border-color: var(--hairline-strong);
    color: var(--text);
  }
  .secondary:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--surface-2);
    border-color: var(--field-border-hover);
  }
  .secondary:active:not(:disabled):not([aria-disabled='true']) {
    background: var(--surface-3);
  }

  /* ── ghost: chrome and toolbars ── */
  .ghost {
    background: transparent;
    color: var(--text-2);
  }
  .ghost:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--hover);
    color: var(--text);
  }
  .ghost:active:not(:disabled):not([aria-disabled='true']) {
    background: var(--press);
  }

  /* ── inverse: the high-contrast neutral action (ivy's white button; ink in the light theme) ── */
  .inverse {
    background: var(--text);
    color: var(--bg);
    box-shadow: 0 6px 18px -8px rgba(0, 0, 0, 0.5);
  }
  .inverse:hover:not(:disabled):not([aria-disabled='true']) {
    background: color-mix(in oklab, var(--text) 88%, var(--bg));
  }

  /* ── outline: the quiet tertiary action (ivy "Continue as guest") ── */
  .outline {
    background: transparent;
    border-color: var(--hairline-strong);
    color: var(--text);
  }
  .outline:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--hover);
    border-color: var(--field-border-hover);
  }
  .outline:active:not(:disabled):not([aria-disabled='true']) {
    background: var(--press);
  }

  /* ── danger ── */
  .danger {
    background: var(--danger);
    color: var(--danger-ink);
    font-weight: 700;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.16),
      0 8px 24px color-mix(in oklab, var(--danger) 16%, transparent);
  }
  .danger:hover:not(:disabled):not([aria-disabled='true']) {
    background: color-mix(in oklab, var(--danger) 88%, var(--text));
  }

  :global(.no-gpu-effects) .primary,
  :global(.no-gpu-effects) .danger,
  :global(.no-gpu-effects) .inverse {
    box-shadow: none;
  }

  .btn:disabled,
  .btn[aria-disabled='true'] {
    opacity: 0.4;
    box-shadow: none;
    cursor: not-allowed;
  }

  .btn[aria-busy='true'] {
    cursor: progress;
    opacity: 0.85;
  }

  @media (forced-colors: active) {
    .btn {
      border-color: ButtonText;
    }
  }
</style>
