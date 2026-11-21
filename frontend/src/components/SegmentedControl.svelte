<!--
  Segmented control (radiogroup semantics, roving tabindex). Arrow keys move and select; Home/End jump.
  The selection indicator slides between segments.
-->
<script lang="ts" generics="T extends string">
  import type { LucideIcon } from '@lucide/svelte';
  import { getFieldContext } from './field-context';
  import Icon from './Icon.svelte';
  import { tooltip } from './tooltip.svelte';

  interface Option {
    value: T;
    label: string;
    icon?: LucideIcon;
    disabled?: boolean;
  }

  interface Props {
    value: T;
    options: readonly Option[];
    label?: string;
    labelledby?: string;
    size?: 'sm' | 'md';
    /** Show icons only (labels become tooltips + accessible names). */
    iconOnly?: boolean;
    full?: boolean;
    disabled?: boolean;
    onchange?: (value: T) => void;
    class?: string;
  }

  let {
    value = $bindable(),
    options,
    label,
    labelledby,
    size = 'md',
    iconOnly = false,
    full = false,
    disabled = false,
    onchange,
    class: className = '',
  }: Props = $props();

  // Inside a Field / SettingRow without its own label, the group is named and described by the row.
  const field = getFieldContext();
  const isDisabled = $derived(disabled || (field?.disabled ?? false));

  let buttons: HTMLButtonElement[] = $state([]);
  let indicator = $state({ x: 0, w: 0, ready: false });

  const selectedIndex = $derived(options.findIndex((o) => o.value === value));

  function select(i: number, focus = false): void {
    const opt = options[i];
    if (!opt || opt.disabled || isDisabled) return;
    if (opt.value !== value) {
      value = opt.value;
      onchange?.(opt.value);
    }
    if (focus) buttons[i]?.focus();
  }

  function onKeydown(ev: KeyboardEvent, i: number): void {
    const n = options.length;
    const step = (from: number, dir: 1 | -1): number => {
      for (let k = 1; k <= n; k++) {
        const j = (((from + dir * k) % n) + n) % n;
        if (!options[j]?.disabled) return j;
      }
      return from;
    };
    let next = -1;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = step(i, 1);
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = step(i, -1);
    else if (ev.key === 'Home') next = step(-1, 1);
    else if (ev.key === 'End') next = step(n, -1);
    if (next >= 0) {
      ev.preventDefault();
      select(next, true);
    }
  }

  $effect(() => {
    const el = buttons[selectedIndex];
    if (!el) {
      indicator = { x: 0, w: 0, ready: false };
      return;
    }
    const update = (): void => {
      indicator = { x: el.offsetLeft, w: el.offsetWidth, ready: true };
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  });
</script>

<div
  class="segmented {size} {className}"
  class:full
  class:disabled={isDisabled}
  role="radiogroup"
  aria-label={labelledby ? undefined : label}
  aria-labelledby={labelledby ?? (label ? undefined : field?.labelId)}
  aria-describedby={field?.describedBy}
>
  {#if indicator.ready}
    <span class="indicator" aria-hidden="true" style:transform="translateX({indicator.x}px)" style:width="{indicator.w}px"></span>
  {/if}
  {#each options as opt, i (opt.value)}
    <button
      bind:this={buttons[i]}
      type="button"
      role="radio"
      class="segment"
      class:icon-only={iconOnly && !!opt.icon}
      aria-checked={opt.value === value}
      aria-label={iconOnly && opt.icon ? opt.label : undefined}
      tabindex={opt.value === value || (selectedIndex < 0 && i === 0) ? 0 : -1}
      disabled={isDisabled || opt.disabled}
      onclick={() => select(i)}
      onkeydown={(ev) => onKeydown(ev, i)}
      {@attach tooltip({ text: opt.label, disabled: !(iconOnly && opt.icon) })}
    >
      {#if opt.icon}<Icon icon={opt.icon} size={size === 'sm' ? 14 : 16} />{/if}
      {#if !(iconOnly && opt.icon)}<span>{opt.label}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .segmented {
    --h: var(--control-h);
    --inner-r: calc(var(--radius) - 3px);
    position: relative;
    display: inline-flex;
    align-items: stretch;
    height: var(--h);
    padding: 3px;
    gap: 2px;
    border-radius: var(--radius);
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--hairline);
    isolation: isolate;
  }

  :global(:is(dialog, .glass-card, [data-field-well])) .segmented {
    background: var(--field-bg);
    box-shadow: inset 0 0 0 1px var(--field-border);
  }

  .sm {
    --h: var(--control-h-sm);
    padding: 2px;
  }

  .full {
    display: flex;
    width: 100%;
  }

  .full .segment {
    flex: 1;
  }

  /* The current segment: the monochrome "current" tile (white tint + faint ring, DESIGN.md §1.2). */
  .indicator {
    position: absolute;
    top: 3px;
    bottom: 3px;
    left: 0;
    z-index: -1;
    border-radius: var(--inner-r);
    background: var(--selected);
    box-shadow:
      inset 0 0 0 1px var(--selected-ring),
      0 1px 2px rgba(0, 0, 0, 0.16);
    transition:
      transform var(--t-2) var(--ease-out),
      width var(--t-2) var(--ease-out);
  }

  .sm .indicator {
    top: 2px;
    bottom: 2px;
  }

  .segment {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 calc(var(--control-px) - 1px);
    border-radius: var(--inner-r);
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-2);
    white-space: nowrap;
    transition: color var(--t-1) var(--ease-out);
  }

  /* Invisible hit area at least --hit-min tall (the segments sit inside the control's padding). */
  .segment::after {
    content: '';
    position: absolute;
    inset: min(0px, calc((100% - var(--hit-min)) / 2)) 0;
  }

  .segment.icon-only {
    padding: 0;
    aspect-ratio: 1;
  }

  .segment:hover:not(:disabled) {
    color: var(--text);
  }

  .segment[aria-checked='true'] {
    color: var(--text);
    font-weight: 600;
  }

  .segment:focus-visible {
    outline-offset: 0;
  }

  .disabled,
  .segment:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (forced-colors: active) {
    .segment[aria-checked='true'] {
      outline: 2px solid Highlight;
      outline-offset: -2px;
    }
  }
</style>
