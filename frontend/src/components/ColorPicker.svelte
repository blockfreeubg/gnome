<!--
  Color picker: preset swatches (radiogroup, roving focus), a hex field and the native color picker.
  `preset` is the selected preset id (null = custom). With `contrastAgainst`, shows the WCAG contrast ratio.
-->
<script lang="ts">
  import Pipette from '@lucide/svelte/icons/pipette';
  import Check from '@lucide/svelte/icons/check';
  import { contrastRatio, parseHex, toHex } from '../settings/color';
  import { tooltip } from './tooltip.svelte';

  interface Preset {
    id: string;
    label: string;
    value: string;
  }

  interface Props {
    value: string;
    preset?: string | null;
    presets: readonly Preset[];
    label: string;
    allowCustom?: boolean;
    /** Background to report contrast against (hex). */
    contrastAgainst?: string;
    minContrast?: number;
    onchange?: (value: string, preset: string | null) => void;
    class?: string;
  }

  let {
    value = $bindable('#9ff0c8'),
    preset = $bindable(null),
    presets,
    label,
    allowCustom = true,
    contrastAgainst,
    minContrast = 4.5,
    onchange,
    class: className = '',
  }: Props = $props();

  const uid = $props.id();
  let swatchEls: HTMLButtonElement[] = $state([]);
  /** Text in the hex field: follows `value`, and holds the user's edit until it is committed or `value` changes. */
  let hexText = $derived(value);
  let hexError = $state<string | null>(null);

  const selectedIndex = $derived(preset ? presets.findIndex((p) => p.id === preset) : -1);
  const ratio = $derived(contrastAgainst ? contrastRatio(value, contrastAgainst) : null);

  /** The check / pipette on a swatch: a dark ink on pale colors, a light one on deep colors (the light-theme presets). */
  function inkOn(hex: string): string {
    if (!parseHex(hex)) return '#111111';
    return contrastRatio(hex, '#111111') >= contrastRatio(hex, '#ffffff') ? '#111111' : '#ffffff';
  }

  function choosePreset(i: number, focus = false): void {
    const p = presets[i];
    if (!p) return;
    preset = p.id;
    value = p.value;
    onchange?.(value, preset);
    if (focus) swatchEls[i]?.focus();
  }

  function setCustom(hex: string): boolean {
    const rgb = parseHex(hex);
    if (!rgb) {
      hexError = 'Use a hex color like #9ff0c8.';
      return false;
    }
    hexError = null;
    value = toHex(rgb);
    preset = null;
    onchange?.(value, null);
    return true;
  }

  function onSwatchKey(ev: KeyboardEvent, i: number): void {
    const n = presets.length;
    let next = -1;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (i + 1) % n;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (i - 1 + n) % n;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = n - 1;
    if (next >= 0) {
      ev.preventDefault();
      choosePreset(next, true);
    }
  }
</script>

<div class="color-picker {className}">
  <div class="swatches" role="radiogroup" aria-label={label}>
    {#each presets as p, i (p.id)}
      <button
        bind:this={swatchEls[i]}
        type="button"
        role="radio"
        class="swatch"
        aria-checked={p.id === preset}
        aria-label={p.label}
        tabindex={p.id === preset || (selectedIndex < 0 && i === 0) ? 0 : -1}
        style:--swatch={p.value}
        style:--swatch-ink={inkOn(p.value)}
        onclick={() => choosePreset(i)}
        onkeydown={(ev) => onSwatchKey(ev, i)}
        {@attach tooltip(p.label)}
      >
        {#if p.id === preset}<Check size={14} strokeWidth={2.5} aria-hidden="true" />{/if}
      </button>
    {/each}
  </div>

  {#if allowCustom}
    <div class="custom">
      <label class="native" class:selected={preset === null} style:--swatch={value} style:--swatch-ink={inkOn(value)} {@attach tooltip('Pick a custom color')}>
        <input
          type="color"
          value={value}
          aria-label="{label}: custom color"
          oninput={(ev) => setCustom((ev.currentTarget as HTMLInputElement).value)}
        />
        <Pipette size={14} strokeWidth={1.75} aria-hidden="true" />
      </label>
      <input
        class="hex"
        type="text"
        inputmode="text"
        maxlength="7"
        spellcheck="false"
        autocomplete="off"
        aria-label="{label}: hex color"
        aria-invalid={hexError ? 'true' : undefined}
        aria-describedby={hexError ? `${uid}-hex-error` : undefined}
        bind:value={() => hexText, (v) => (hexText = v)}
        onkeydown={(ev) => {
          if (ev.key === 'Enter') setCustom(hexText);
        }}
        onblur={() => {
          if (hexText !== value) setCustom(hexText);
        }}
      />
      {#if ratio !== null}
        <span class="contrast" class:low={ratio < minContrast}>
          {ratio.toFixed(1)}:1{ratio < minContrast ? ' · adjusted for legibility' : ''}
        </span>
      {/if}
    </div>
    {#if hexError}<p class="error" id="{uid}-hex-error">{hexError}</p>{/if}
  {/if}
</div>

<style>
  .color-picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  /* Phones: the nine presets stay on one row in a full-width card (no lone swatch on a second row); the 32px pitch
     still clears WCAG 2.5.8 and every swatch keeps its 40px touch area. */
  @media (max-width: 480px) {
    .swatches {
      gap: 6px;
    }
  }

  .swatch,
  .native {
    --sw: 26px;
    position: relative;
    display: grid;
    place-items: center;
    width: var(--sw);
    height: var(--sw);
    border-radius: 50%;
    background: var(--swatch);
    color: color-mix(in oklab, var(--swatch) 18%, var(--swatch-ink, black));
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.2);
    transition:
      box-shadow var(--t-2) var(--ease-out),
      transform var(--t-1) var(--ease-out);
  }

  .swatch::after,
  .native::after {
    content: '';
    position: absolute;
    inset: min(0px, calc((var(--sw) - var(--hit-min)) / 2));
    border-radius: 50%;
  }

  .swatch:hover {
    transform: scale(calc(1 + 0.08 * var(--motion-move)));
  }

  /* Selected: a 2px --bg gap, then a 2px --text ring (monochrome, whatever the swatch color). */
  .swatch[aria-checked='true'],
  .native.selected {
    box-shadow:
      inset 0 0 0 1px rgba(0, 0, 0, 0.2),
      0 0 0 2px var(--bg),
      0 0 0 4px var(--text);
  }

  .swatch:focus-visible {
    outline-offset: 5px;
  }

  .custom {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .native {
    cursor: pointer;
    color: color-mix(in oklab, var(--swatch) 25%, var(--swatch-ink, black));
  }

  .native input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }

  .native:focus-within {
    outline: 2px solid var(--focus);
    outline-offset: 5px;
  }

  .hex {
    width: 104px;
    height: var(--control-h-sm);
    padding: 0 10px;
    border: 1px solid var(--hairline-strong);
    border-radius: calc(var(--radius) - 2px);
    background: var(--surface-1);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    text-transform: lowercase;
    outline: none;
    transition:
      border-color var(--t-1) var(--ease-out),
      box-shadow var(--t-2) var(--ease-out);
  }

  :global(:is(dialog, .glass-card, [data-field-well])) .hex {
    background: var(--field-bg);
    border-color: var(--field-border);
  }

  .hex:hover {
    border-color: var(--field-border-hover);
  }

  .hex:focus {
    border-color: var(--focus-border);
    box-shadow: 0 0 0 3px var(--focus-halo);
  }

  .hex[aria-invalid='true'] {
    border-color: var(--danger);
  }

  .hex[aria-invalid='true']:focus {
    box-shadow: 0 0 0 3px var(--danger-soft);
  }

  .contrast {
    font-size: var(--text-sm);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }

  .contrast.low {
    color: var(--warning);
  }

  .error {
    font-size: var(--text-sm);
    color: var(--danger);
  }

  @media (forced-colors: active) {
    .swatch,
    .native {
      forced-color-adjust: none;
    }

    .swatch[aria-checked='true'],
    .native.selected {
      outline: 2px solid Highlight;
      outline-offset: 2px;
    }
  }
</style>
