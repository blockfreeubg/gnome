<!--
  Label + control + help/error. Controls inside (Input, Textarea, Select, Switch, …) pick up the ids through
  context, so the label, help and error are announced with the control.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { getFieldContext, setFieldContext } from './field-context';

  interface Props {
    label: string;
    help?: string;
    error?: string | null;
    required?: boolean;
    disabled?: boolean;
    /** Visually hide the label (it stays accessible). */
    hideLabel?: boolean;
    id?: string;
    class?: string;
    /** End-aligned content in the label row, e.g. a "Forgot code?" link (ivy). */
    aside?: Snippet;
    children: Snippet;
  }

  let {
    label,
    help,
    error = null,
    required = false,
    disabled = false,
    hideLabel = false,
    id,
    class: className = '',
    aside,
    children,
  }: Props = $props();

  const uid = $props.id();
  /** A Field inside a disabled SettingRow or Field is disabled with it. */
  const parent = getFieldContext();
  const controlId = $derived(id ?? `${uid}-control`);
  const labelId = `${uid}-label`;
  const helpId = `${uid}-help`;
  const errorId = `${uid}-error`;

  setFieldContext({
    get controlId() {
      return controlId;
    },
    labelId,
    get describedBy() {
      const ids = [error ? errorId : null, help ? helpId : null].filter(Boolean);
      return ids.length ? ids.join(' ') : undefined;
    },
    get invalid() {
      return !!error;
    },
    get required() {
      return required;
    },
    get disabled() {
      return disabled || (parent?.disabled ?? false);
    },
  });
</script>

<div class="field {className}" class:invalid={!!error} class:disabled>
  {#if aside && !hideLabel}
    <div class="label-row">
      <label for={controlId} id={labelId}>
        {label}
        {#if required}<span class="req" aria-hidden="true">*</span>{/if}
      </label>
      <span class="aside">{@render aside()}</span>
    </div>
  {:else}
    <label for={controlId} id={labelId} class:sr-only={hideLabel}>
      {label}
      {#if required}<span class="req" aria-hidden="true">*</span>{/if}
    </label>
  {/if}
  {@render children()}
  <!-- No whitespace between the blocks: an empty region must match :empty (no stray gap under the control). -->
  <div class="messages" aria-live="polite">{#if error}<p id={errorId} class="error">{error}</p>{/if}{#if help}<p id={helpId} class="help">{help}</p>{/if}</div>
</div>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 7px;
    min-width: 0;
  }

  /* ivy's small bold labels */
  label {
    font-size: var(--text-sm);
    font-weight: 600;
    letter-spacing: 0.005em;
    color: var(--text-2);
  }

  .label-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .aside {
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .req {
    color: var(--accent);
    margin-left: 2px;
  }

  .messages {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  /* An empty live region stays rendered (so a new error is announced) but takes no room: cancel the flex gap. */
  .messages:empty {
    margin-top: -7px;
  }

  .help,
  .error {
    font-size: var(--text-sm);
    line-height: 1.4;
  }

  .help {
    color: var(--text-3);
  }

  .error {
    color: var(--danger);
    font-weight: 500;
  }

  .disabled label {
    opacity: 0.6;
  }
</style>
