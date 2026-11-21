<!--
  Text input with optional leading icon and trailing content. Inside a Field it is labelled automatically.
  DESIGN.md §10: on pages and chrome a raised field (--surface-1); inside cards and dialogs (or with `well`) an ivy
  well one step below the card (--field-bg). `size="lg"` is the 44px card field. Focus = accent border + 3px halo.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';
  import type { LucideIcon } from '@lucide/svelte';
  import { getFieldContext } from './field-context';
  import Icon from './Icon.svelte';

  interface Props extends Omit<HTMLInputAttributes, 'size' | 'class' | 'value'> {
    value?: string;
    size?: 'sm' | 'md' | 'lg';
    invalid?: boolean;
    icon?: LucideIcon;
    trailing?: Snippet;
    mono?: boolean;
    /** Sunken "well" look (--field-bg), as inside cards and dialogs (applied there automatically). */
    well?: boolean;
    element?: HTMLInputElement;
    class?: string;
  }

  let {
    value = $bindable(''),
    size = 'md',
    invalid = false,
    icon,
    trailing,
    mono = false,
    well = false,
    element = $bindable(),
    class: className = '',
    id,
    type = 'text',
    ...rest
  }: Props = $props();

  const field = getFieldContext();
  const isInvalid = $derived(invalid || (field?.invalid ?? false));
</script>

<div class="input {size} {className}" class:invalid={isInvalid} class:well class:has-icon={!!icon} class:disabled={rest.disabled || field?.disabled}>
  {#if icon}<span class="lead"><Icon {icon} size={size === 'lg' ? 18 : 16} /></span>{/if}
  <input
    {...rest}
    bind:this={element}
    bind:value
    {type}
    id={id ?? field?.controlId}
    class:mono
    aria-describedby={rest['aria-describedby'] ?? field?.describedBy}
    aria-invalid={isInvalid ? 'true' : undefined}
    required={rest.required ?? field?.required}
    disabled={rest.disabled ?? field?.disabled}
  />
  {#if trailing}<span class="trail">{@render trailing()}</span>{/if}
</div>

<style>
  .input {
    --h: var(--control-h);
    --f-bg: var(--surface-1);
    --f-border: var(--hairline-strong);
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    height: var(--h);
    padding: 0 var(--control-px);
    border: 1px solid var(--f-border);
    border-radius: var(--radius);
    background: var(--f-bg);
    color: var(--text);
    transition:
      border-color var(--t-1) var(--ease-out),
      box-shadow var(--t-2) var(--ease-out),
      background-color var(--t-1) var(--ease-out);
  }

  /* Wells: inside cards and dialogs the field sits a step below the surface (ivy). */
  .well,
  :global(:is(dialog, .glass-card, [data-field-well])) .input {
    --f-bg: var(--field-bg);
    --f-border: var(--field-border);
  }

  .input:hover:not(.disabled) {
    border-color: var(--field-border-hover);
  }

  .input:focus-within {
    border-color: var(--focus-border);
    box-shadow: 0 0 0 3px var(--focus-halo);
  }

  .input.invalid {
    border-color: color-mix(in oklab, var(--danger) 75%, transparent);
  }

  .input.invalid:focus-within {
    border-color: var(--danger);
    box-shadow: 0 0 0 3px var(--danger-soft);
  }

  .sm {
    --h: var(--control-h-sm);
    gap: 6px;
    padding: 0 calc(var(--control-px) - 3px);
    border-radius: calc(var(--radius) - 2px);
    font-size: var(--text-sm);
  }

  /* The card field (ivy): 44px+, a softer 13px corner, 15px text. */
  .lg {
    --h: max(var(--control-h-lg), calc(3.2857rem * var(--density)));
    gap: 10px;
    padding: 0 calc(var(--control-px) + 2px);
    border-radius: calc(var(--radius) + 3px);
    font-size: 1.0714rem;
    font-weight: 500;
  }

  input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    background: transparent;
    outline: none;
    color: inherit;
    font-weight: inherit;
  }

  input::placeholder {
    color: var(--text-3);
    opacity: 1;
  }

  input.mono {
    font-family: var(--font-mono);
    font-size: 0.93em;
  }

  .lead {
    display: grid;
    color: var(--text-3);
    transition: color var(--t-1) var(--ease-out);
  }

  .input:focus-within .lead {
    color: var(--text-2);
  }

  .trail {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-right: calc(var(--control-px) * -0.5);
    color: var(--text-3);
  }

  .disabled {
    opacity: 0.5;
  }

  .disabled input {
    cursor: not-allowed;
  }

  @media (forced-colors: active) {
    .input {
      border-color: FieldText;
    }

    .input:focus-within {
      outline: 2px solid Highlight;
    }
  }
</style>
