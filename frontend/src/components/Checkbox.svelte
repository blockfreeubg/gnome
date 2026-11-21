<!-- Native checkbox (keyboard + forms for free) with a custom box; supports indeterminate and a description. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';
  import Check from '@lucide/svelte/icons/check';
  import Minus from '@lucide/svelte/icons/minus';
  import { getFieldContext } from './field-context';

  interface Props extends Omit<HTMLInputAttributes, 'type' | 'class' | 'checked' | 'onchange'> {
    checked?: boolean;
    indeterminate?: boolean;
    label?: string;
    description?: string;
    onchange?: (checked: boolean) => void;
    class?: string;
    children?: Snippet;
  }

  let {
    checked = $bindable(false),
    indeterminate = $bindable(false),
    label,
    description,
    onchange,
    disabled,
    class: className = '',
    children,
    ...rest
  }: Props = $props();

  const uid = $props.id();
  // In a Field / SettingRow, a checkbox without its own text is labelled (for/id) and described by the row.
  const field = getFieldContext();
  const ownText = $derived(!!(label || children));
  const isDisabled = $derived(disabled || (field?.disabled ?? false));
</script>

<label class="checkbox {className}" class:disabled={isDisabled}>
  <span class="box-wrap">
    <input
      {...rest}
      type="checkbox"
      id={rest.id ?? (ownText ? undefined : field?.controlId)}
      bind:checked
      bind:indeterminate
      disabled={isDisabled}
      aria-describedby={description ? `${uid}-desc` : (rest['aria-describedby'] ?? (ownText ? undefined : field?.describedBy))}
      onchange={() => onchange?.(checked)}
    />
    <span class="box" aria-hidden="true">
      {#if indeterminate}
        <Minus size={13} strokeWidth={3} />
      {:else if checked}
        <Check size={13} strokeWidth={3} />
      {/if}
    </span>
  </span>
  {#if label || children || description}
    <span class="text">
      {#if children}{@render children()}{:else if label}<span class="label">{label}</span>{/if}
      {#if description}<span class="desc" id="{uid}-desc">{description}</span>{/if}
    </span>
  {/if}
</label>

<style>
  .checkbox {
    --box: 17px;
    display: inline-flex;
    align-items: flex-start;
    gap: 10px;
    cursor: pointer;
    user-select: none;
  }

  .box-wrap {
    position: relative;
    display: inline-grid;
    flex: none;
    width: var(--box);
    height: var(--box);
    margin-top: 1px;
  }

  /* Invisible hit area of at least --hit-min around the box (inside the label, so it toggles too). */
  .box-wrap::after {
    content: '';
    position: absolute;
    inset: calc((var(--box) - var(--hit-min)) / 2);
  }

  input {
    position: absolute;
    inset: 0;
    margin: 0;
    opacity: 0;
    cursor: inherit;
  }

  .box {
    display: grid;
    place-items: center;
    width: var(--box);
    height: var(--box);
    border-radius: min(var(--radius-sm), 6px);
    /* WCAG 1.4.11: the empty box is the only sign of the control, so its edge keeps 3:1 on every surface. */
    --control-edge: color-mix(in oklab, var(--text-3) 75%, transparent);
    border: 1.5px solid var(--control-edge);
    background: var(--field-bg);
    color: var(--accent-ink);
    transition:
      background-color var(--t-1) var(--ease-out),
      border-color var(--t-1) var(--ease-out),
      box-shadow var(--t-2) var(--ease-out);
  }

  input:checked + .box,
  input:indeterminate + .box {
    background: var(--accent);
    border-color: var(--accent);
    box-shadow: 0 2px 10px color-mix(in oklab, var(--accent) 22%, transparent);
  }

  input:focus-visible + .box {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }

  .checkbox:hover:not(.disabled) input:not(:checked):not(:indeterminate) + .box {
    border-color: var(--text-3);
  }

  .checkbox:hover:not(.disabled) input:checked + .box {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    line-height: 1.4;
  }

  .label {
    font-size: 0.9286rem;
    font-weight: 500;
    color: var(--text);
  }

  .desc {
    font-size: var(--text-sm);
    color: var(--text-3);
  }

  .disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (forced-colors: active) {
    .box {
      border-color: CanvasText;
    }

    input:checked + .box,
    input:indeterminate + .box {
      background: Highlight;
      color: HighlightText;
    }
  }
</style>
