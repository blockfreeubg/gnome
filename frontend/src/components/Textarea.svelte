<!-- Multi-line text input; grows with its content up to `maxRows` when `autosize` is on. -->
<script lang="ts">
  import type { HTMLTextareaAttributes } from 'svelte/elements';
  import { getFieldContext } from './field-context';

  interface Props extends Omit<HTMLTextareaAttributes, 'class' | 'value'> {
    value?: string;
    invalid?: boolean;
    autosize?: boolean;
    minRows?: number;
    maxRows?: number;
    mono?: boolean;
    /** Sunken "well" look (--field-bg), as inside cards and dialogs (applied there automatically). */
    well?: boolean;
    element?: HTMLTextAreaElement;
    class?: string;
  }

  let {
    value = $bindable(''),
    invalid = false,
    autosize = true,
    minRows = 3,
    maxRows = 12,
    mono = false,
    well = false,
    element = $bindable(),
    class: className = '',
    id,
    ...rest
  }: Props = $props();

  const field = getFieldContext();
  const isInvalid = $derived(invalid || (field?.invalid ?? false));

  // Fallback autosize for browsers without `field-sizing: content`.
  const nativeSizing = typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content');

  $effect(() => {
    void value;
    if (!autosize || nativeSizing || !element) return;
    const el = element;
    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || 20;
    const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    el.style.height = 'auto';
    const max = line * maxRows + pad + border;
    el.style.height = `${Math.min(el.scrollHeight + border, max)}px`;
  });
</script>

<textarea
  {...rest}
  bind:this={element}
  bind:value
  id={id ?? field?.controlId}
  class="textarea {className}"
  class:mono
  class:autosize
  class:well
  class:invalid={isInvalid}
  rows={minRows}
  style:--min-rows={minRows}
  style:--max-rows={maxRows}
  aria-describedby={rest['aria-describedby'] ?? field?.describedBy}
  aria-invalid={isInvalid ? 'true' : undefined}
  required={rest.required ?? field?.required}
  disabled={rest.disabled ?? field?.disabled}
></textarea>

<style>
  .textarea {
    --f-bg: var(--surface-1);
    --f-border: var(--hairline-strong);
    width: 100%;
    padding: 9px var(--control-px);
    border: 1px solid var(--f-border);
    border-radius: var(--radius);
    background: var(--f-bg);
    color: var(--text);
    line-height: 1.5;
    resize: vertical;
    outline: none;
    transition:
      border-color var(--t-1) var(--ease-out),
      box-shadow var(--t-2) var(--ease-out);
  }

  /* Wells: inside cards and dialogs the field sits a step below the surface (ivy). */
  .well,
  :global(:is(dialog, .glass-card, [data-field-well])) .textarea {
    --f-bg: var(--field-bg);
    --f-border: var(--field-border);
    border-radius: calc(var(--radius) + 3px);
  }

  .autosize {
    field-sizing: content;
    resize: none;
    min-height: calc(var(--min-rows) * 1.5em + 20px);
    max-height: calc(var(--max-rows) * 1.5em + 20px);
  }

  .textarea:hover:not(:disabled) {
    border-color: var(--field-border-hover);
  }

  .textarea:focus {
    border-color: var(--focus-border);
    box-shadow: 0 0 0 3px var(--focus-halo);
  }

  .invalid {
    border-color: color-mix(in oklab, var(--danger) 75%, transparent);
  }

  .invalid:focus {
    border-color: var(--danger);
    box-shadow: 0 0 0 3px var(--danger-soft);
  }

  .textarea::placeholder {
    color: var(--text-3);
    opacity: 1;
  }

  .mono {
    font-family: var(--font-mono);
    font-size: 0.93em;
  }

  .textarea:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (forced-colors: active) {
    .textarea {
      border-color: FieldText;
    }
  }
</style>
