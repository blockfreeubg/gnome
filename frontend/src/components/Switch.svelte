<!--
  On/off switch (role="switch"). Name it with `label` (visible), `aria-label`, or by placing it in a Field /
  SettingRow (labelled through context).
-->
<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { getFieldContext } from './field-context';

  interface Props extends Omit<HTMLButtonAttributes, 'class' | 'onchange' | 'children'> {
    checked?: boolean;
    label?: string;
    size?: 'sm' | 'md';
    onchange?: (checked: boolean) => void;
    class?: string;
  }

  let { checked = $bindable(false), label, size = 'md', onchange, disabled, id, class: className = '', ...rest }: Props = $props();

  const field = getFieldContext();
  const uid = $props.id();

  function toggle(): void {
    if (disabled || field?.disabled) return;
    checked = !checked;
    onchange?.(checked);
  }
</script>

<span class="switch-wrap {className}" class:disabled={disabled || field?.disabled}>
  <button
    {...rest}
    type="button"
    role="switch"
    id={id ?? field?.controlId}
    class="switch {size}"
    aria-checked={checked}
    aria-labelledby={rest['aria-label'] ? undefined : label ? `${uid}-label` : field?.labelId}
    aria-describedby={rest['aria-describedby'] ?? field?.describedBy}
    disabled={disabled || field?.disabled}
    onclick={toggle}
  >
    <span class="thumb" aria-hidden="true"></span>
  </button>
  {#if label}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <span class="text" id="{uid}-label" onclick={toggle}>{label}</span>
  {/if}
</span>

<style>
  .switch-wrap {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
  }

  .switch {
    --w: 40px;
    --h: 24px;
    --pad: 3px;
    position: relative;
    flex: none;
    width: var(--w);
    height: var(--h);
    border-radius: var(--radius-pill);
    background: var(--field-bg);
    box-shadow: inset 0 0 0 1px var(--field-border-hover);
    transition:
      background-color var(--t-2) var(--ease-out),
      box-shadow var(--t-2) var(--ease-out);
  }

  .sm {
    --w: 32px;
    --h: 18px;
    --pad: 2px;
  }

  /* Invisible hit area of at least --hit-min (32px; 40px on touch screens). */
  .switch::after {
    content: '';
    position: absolute;
    inset: min(0px, calc((var(--h) - var(--hit-min)) / 2)) min(0px, calc((var(--w) - var(--hit-min)) / 2));
    border-radius: var(--radius-pill);
  }

  .switch:focus-visible {
    outline-offset: 3px;
  }

  .thumb {
    position: absolute;
    top: var(--pad);
    left: var(--pad);
    width: calc(var(--h) - 2 * var(--pad));
    height: calc(var(--h) - 2 * var(--pad));
    border-radius: 50%;
    background: var(--text-3);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
    /* The knob slides (160ms); without movement it only changes color. */
    transition:
      transform calc(var(--t-2) * var(--motion-move)) var(--ease-out),
      background-color var(--t-2) var(--ease-out);
  }

  .switch:hover:not(:disabled) .thumb {
    background: var(--text-2);
  }

  .switch[aria-checked='true'] {
    background: var(--accent);
    box-shadow:
      inset 0 0 0 1px color-mix(in oklab, var(--accent) 80%, var(--accent-ink)),
      0 2px 12px color-mix(in oklab, var(--accent) 22%, transparent);
  }

  .switch[aria-checked='true'] .thumb {
    transform: translateX(calc(var(--w) - var(--h)));
    background: var(--accent-ink);
  }

  .switch[aria-checked='true']:hover:not(:disabled) {
    background: var(--accent-strong);
  }

  .switch[aria-checked='true']:hover:not(:disabled) .thumb {
    background: var(--accent-ink);
  }

  :global(.no-gpu-effects) .switch[aria-checked='true'] {
    box-shadow: none;
  }

  .text {
    font-size: 0.9286rem;
    font-weight: 500;
    color: var(--text);
    cursor: pointer;
    user-select: none;
  }

  .disabled {
    opacity: 0.5;
  }

  .disabled .switch,
  .disabled .text {
    cursor: not-allowed;
  }

  @media (forced-colors: active) {
    .switch {
      border: 1px solid CanvasText;
    }

    .thumb {
      background: CanvasText;
    }

    .switch[aria-checked='true'] {
      background: Highlight;
    }

    .switch[aria-checked='true'] .thumb {
      background: HighlightText;
    }
  }
</style>
