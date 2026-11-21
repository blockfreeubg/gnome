<!-- One optional color override: native picker swatch + hex field + "use the theme color". null = theme default. -->
<script lang="ts">
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import Field from '../../components/Field.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import Input from '../../components/Input.svelte';
  import { parseHex, toHex } from '../../settings/color';

  interface Props {
    label: string;
    value: string | null;
    /** Theme color shown while no override is set. */
    fallback: string;
    warning?: string | null;
    onchange: (value: string | null) => void;
  }

  let { label, value, fallback, warning = null, onchange }: Props = $props();

  const uid = $props.id();
  let text = $derived(value ?? '');
  let error = $state<string | null>(null);

  function commit(): void {
    const t = text.trim();
    if (!t) {
      error = null;
      if (value !== null) onchange(null);
      return;
    }
    const rgb = parseHex(t);
    if (!rgb) {
      error = 'Use a hex color like #141414.';
      return;
    }
    error = null;
    onchange(toHex(rgb));
  }
</script>

<div class="slot">
  <label class="swatch" style:--c={value ?? fallback} class:unset={value === null}>
    <input
      type="color"
      value={value ?? fallback}
      aria-label="{label}: pick a color"
      oninput={(e) => onchange((e.currentTarget as HTMLInputElement).value)}
    />
  </label>
  <Field {label} error={error ?? warning} id="{uid}-hex">
    <Input
      bind:value={text}
      placeholder="Theme ({fallback})"
      mono
      size="sm"
      maxlength={7}
      spellcheck={false}
      autocomplete="off"
      onchange={commit}
      onkeydown={(e) => e.key === 'Enter' && commit()}
    />
  </Field>
  {#if value !== null}
    <IconButton icon={Undo2} label="Use the theme’s {label.toLowerCase()} color" size="sm" onclick={() => onchange(null)} />
  {/if}
</div>

<style>
  .slot {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: end;
    gap: var(--space-2);
  }

  .swatch {
    position: relative;
    width: calc(var(--control-h) * 0.9);
    height: calc(var(--control-h) * 0.9);
    margin-bottom: 1px;
    border-radius: var(--radius-sm);
    background: var(--c);
    border: 1px solid var(--hairline-strong);
    cursor: pointer;
  }

  .swatch.unset {
    background:
      linear-gradient(135deg, transparent 46%, var(--hairline-strong) 46% 54%, transparent 54%),
      var(--c);
  }

  .swatch:focus-within {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }

  .swatch input {
    position: absolute;
    inset: 0;
    opacity: 0;
    width: 100%;
    height: 100%;
    cursor: pointer;
  }
</style>
