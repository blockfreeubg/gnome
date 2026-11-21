<!-- Radio group built on native radios (arrow keys move and select within the group). -->
<script lang="ts" generics="T extends string">
  import { getFieldContext } from './field-context';

  interface Option {
    value: T;
    label: string;
    description?: string;
    disabled?: boolean;
  }

  interface Props {
    value: T;
    options: readonly Option[];
    /** Accessible group name (or use labelledby). */
    label?: string;
    labelledby?: string;
    orientation?: 'vertical' | 'horizontal';
    name?: string;
    disabled?: boolean;
    onchange?: (value: T) => void;
    class?: string;
  }

  let {
    value = $bindable(),
    options,
    label,
    labelledby,
    orientation = 'vertical',
    name,
    disabled = false,
    onchange,
    class: className = '',
  }: Props = $props();

  const uid = $props.id();
  const groupName = $derived(name ?? `${uid}-radio`);
  // Inside a Field / SettingRow without its own label, the group is named and described by the row.
  const field = getFieldContext();
  const isDisabled = $derived(disabled || (field?.disabled ?? false));
</script>

<div
  class="radio-group {orientation} {className}"
  role="radiogroup"
  aria-label={labelledby ? undefined : label}
  aria-labelledby={labelledby ?? (label ? undefined : field?.labelId)}
  aria-describedby={field?.describedBy}
  aria-disabled={isDisabled ? 'true' : undefined}
>
  {#each options as opt (opt.value)}
    <label class="radio" class:disabled={isDisabled || opt.disabled}>
      <input
        type="radio"
        name={groupName}
        value={opt.value}
        checked={value === opt.value}
        disabled={isDisabled || opt.disabled}
        aria-describedby={opt.description ? `${uid}-${opt.value}-desc` : undefined}
        onchange={() => {
          value = opt.value;
          onchange?.(opt.value);
        }}
      />
      <span class="dot" aria-hidden="true"></span>
      <span class="text">
        <span class="label">{opt.label}</span>
        {#if opt.description}<span class="desc" id="{uid}-{opt.value}-desc">{opt.description}</span>{/if}
      </span>
    </label>
  {/each}
</div>

<style>
  .radio-group {
    display: flex;
    gap: var(--space-3);
  }

  .vertical {
    flex-direction: column;
  }

  .horizontal {
    flex-wrap: wrap;
    gap: var(--space-4);
  }

  .radio {
    position: relative;
    display: inline-flex;
    align-items: flex-start;
    gap: 10px;
    cursor: pointer;
  }

  input {
    position: absolute;
    width: 17px;
    height: 17px;
    margin: 1px 0 0;
    opacity: 0;
    cursor: inherit;
  }

  /* Invisible hit area of at least --hit-min around the dot (inside the label, so it selects too). */
  .radio::before {
    content: '';
    position: absolute;
    top: calc(9.5px - var(--hit-min) / 2);
    left: calc(8.5px - var(--hit-min) / 2);
    width: var(--hit-min);
    height: var(--hit-min);
  }

  @media (pointer: coarse) {
    .radio {
      min-height: var(--hit-min);
      align-items: center;
    }

    .radio::before {
      top: calc(50% - var(--hit-min) / 2);
    }

    input,
    .dot {
      margin-top: 0;
    }
  }

  .dot {
    flex: none;
    width: 17px;
    height: 17px;
    margin-top: 1px;
    border-radius: 50%;
    /* WCAG 1.4.11: the empty ring is the only sign of the control, so its edge keeps 3:1 on every surface. */
    --control-edge: color-mix(in oklab, var(--text-3) 75%, transparent);
    border: 1.5px solid var(--control-edge);
    background: var(--field-bg);
    transition:
      border-color var(--t-1) var(--ease-out),
      box-shadow var(--t-2) var(--ease-out),
      background-color var(--t-1) var(--ease-out);
  }

  input:checked + .dot {
    border-color: var(--accent);
    background: var(--accent-ink);
    box-shadow:
      inset 0 0 0 4px var(--accent),
      0 2px 10px color-mix(in oklab, var(--accent) 22%, transparent);
  }

  input:focus-visible + .dot {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }

  .radio:hover:not(.disabled) input:not(:checked) + .dot {
    border-color: var(--text-3);
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
    .dot {
      border-color: CanvasText;
    }

    input:checked + .dot {
      background: HighlightText;
      box-shadow: inset 0 0 0 4px Highlight;
    }
  }
</style>
