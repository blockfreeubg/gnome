<!--
  Range slider on a native <input type=range> (arrow keys, PageUp/PageDown, Home/End). A value bubble follows the
  thumb while dragging or focused; `format` produces both the bubble text and aria-valuetext.
-->
<script lang="ts">
  import { getFieldContext } from './field-context';

  interface Props {
    value?: number;
    min?: number;
    max?: number;
    step?: number;
    label?: string;
    format?: (value: number) => string;
    disabled?: boolean;
    showValue?: boolean;
    id?: string;
    oninput?: (value: number) => void;
    /** Fires when the user commits a value (pointer released / key pressed). */
    onchange?: (value: number) => void;
    class?: string;
  }

  let {
    value = $bindable(0),
    min = 0,
    max = 100,
    step = 1,
    label,
    format = (v: number) => String(v),
    disabled = false,
    showValue = true,
    id,
    oninput,
    onchange,
    class: className = '',
  }: Props = $props();

  const field = getFieldContext();
  let active = $state(false);
  let focused = $state(false);

  const pct = $derived(max > min ? ((value - min) / (max - min)) * 100 : 0);
  const text = $derived(format(value));
</script>

<div class="slider {className}" class:disabled={disabled || field?.disabled}>
  <div class="track-wrap" style:--pct="{pct}%" style:--ratio={pct / 100}>
    <input
      type="range"
      id={id ?? field?.controlId}
      {min}
      {max}
      {step}
      bind:value
      disabled={disabled || field?.disabled}
      aria-label={field ? undefined : label}
      aria-labelledby={field && !label ? field.labelId : undefined}
      aria-describedby={field?.describedBy}
      aria-valuetext={text}
      oninput={() => oninput?.(value)}
      onchange={() => onchange?.(value)}
      onpointerdown={() => (active = true)}
      onpointerup={() => (active = false)}
      onpointercancel={() => (active = false)}
      onfocus={(ev) => (focused = (ev.currentTarget as HTMLElement).matches(':focus-visible'))}
      onblur={() => {
        focused = false;
        active = false;
      }}
    />
    {#if active || focused}
      <span class="bubble" aria-hidden="true">{text}</span>
    {/if}
  </div>
  {#if showValue}
    <output class="value" for={id ?? field?.controlId} aria-hidden="true">{text}</output>
  {/if}
</div>

<style>
  .slider {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 160px;
  }

  .track-wrap {
    --thumb: 16px;
    position: relative;
    flex: 1;
    display: flex;
    align-items: center;
    height: 24px;
  }

  input {
    width: 100%;
    height: 24px;
    margin: 0;
    background: transparent;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
  }

  input:focus-visible {
    outline: none;
  }

  /* Track */
  input::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: var(--radius-pill);
    background: linear-gradient(to right, var(--accent) var(--pct), var(--track-bg) var(--pct));
  }
  input::-moz-range-track {
    height: 4px;
    border-radius: var(--radius-pill);
    background: var(--track-bg);
  }
  input::-moz-range-progress {
    height: 4px;
    border-radius: var(--radius-pill);
    background: var(--accent);
  }

  /* Thumb: a white knob in the dark theme, the accent in the light one (DESIGN.md §10). */
  .track-wrap {
    --thumb-bg: var(--text);
    --thumb-ring: var(--bg);
    --track-bg: var(--surface-3);
  }

  :global(.theme-light) .track-wrap {
    --track-bg: var(--hairline-strong);
    --thumb-bg: var(--accent);
    --thumb-ring: var(--surface-2);
  }

  input::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: var(--thumb);
    height: var(--thumb);
    margin-top: calc((4px - var(--thumb)) / 2);
    border-radius: 50%;
    background: var(--thumb-bg);
    border: 0;
    box-shadow:
      0 0 0 3px var(--thumb-ring),
      var(--shadow-raise);
    transition:
      transform var(--t-1) var(--ease-out),
      box-shadow var(--t-2) var(--ease-out);
  }
  input::-moz-range-thumb {
    width: var(--thumb);
    height: var(--thumb);
    border-radius: 50%;
    background: var(--thumb-bg);
    border: 0;
    box-shadow:
      0 0 0 3px var(--thumb-ring),
      var(--shadow-raise);
    transition: box-shadow var(--t-2) var(--ease-out);
  }

  input:hover:not(:disabled)::-webkit-slider-thumb {
    transform: scale(calc(1 + 0.1 * var(--motion-move)));
  }

  /* Keyboard focus: the field halo around the knob plus the 2px focus ring. */
  input:focus-visible::-webkit-slider-thumb {
    box-shadow:
      0 0 0 3px var(--thumb-ring),
      0 0 0 5px var(--focus),
      0 0 0 9px var(--focus-halo);
  }
  input:focus-visible::-moz-range-thumb {
    box-shadow:
      0 0 0 3px var(--thumb-ring),
      0 0 0 5px var(--focus),
      0 0 0 9px var(--focus-halo);
  }

  /* Touch screens: a 40px tall input around the same 4px track (DESIGN.md §1.6). */
  @media (pointer: coarse) {
    .track-wrap,
    input {
      height: var(--hit-min);
    }
  }

  .bubble {
    position: absolute;
    bottom: calc(100% + 6px);
    left: calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--ratio));
    transform: translateX(-50%);
    padding: 4px 8px;
    border-radius: calc(var(--radius-sm) + 2px);
    background: var(--glass-bg-dense);
    -webkit-backdrop-filter: var(--glass-filter);
    backdrop-filter: var(--glass-filter);
    border: 1px solid var(--glass-border);
    box-shadow: var(--shadow-pop);
    color: var(--text);
    font-size: var(--text-xs);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    pointer-events: none;
  }

  .value {
    min-width: 3.5em;
    text-align: right;
    font-size: var(--text-sm);
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }

  .disabled {
    opacity: 0.5;
  }

  .disabled input {
    cursor: not-allowed;
  }
</style>
