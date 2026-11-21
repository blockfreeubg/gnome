<!--
  One setting: label · description · control · reset-to-default. The control is labelled through context, so
  <Switch/>, <Select/>, <Slider/>… placed in `control` are announced with this row's label and description.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { LucideIcon } from '@lucide/svelte';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import { setFieldContext } from './field-context';
  import Icon from './Icon.svelte';
  import IconButton from './IconButton.svelte';

  interface Props {
    label: string;
    description?: string;
    /** Optional icon tile before the text (DESIGN.md §10 SettingRow). */
    icon?: LucideIcon;
    /** Shows the reset button when false. */
    isDefault?: boolean;
    onreset?: () => void;
    disabled?: boolean;
    error?: string | null;
    /** Stack the control under the text (wide controls). */
    stacked?: boolean;
    control: Snippet;
    children?: Snippet;
    class?: string;
  }

  let {
    label,
    description,
    icon,
    isDefault = true,
    onreset,
    disabled = false,
    error = null,
    stacked = false,
    control,
    children,
    class: className = '',
  }: Props = $props();

  const uid = $props.id();
  const labelId = `${uid}-label`;
  const descId = `${uid}-desc`;
  const errorId = `${uid}-error`;

  setFieldContext({
    controlId: `${uid}-control`,
    labelId,
    get describedBy() {
      const ids = [error ? errorId : null, description ? descId : null].filter(Boolean);
      return ids.length ? ids.join(' ') : undefined;
    },
    get invalid() {
      return !!error;
    },
    required: false,
    get disabled() {
      return disabled;
    },
  });
</script>

<div class="setting-row {className}" class:stacked class:disabled class:has-icon={!!icon}>
  {#if icon}<span class="icon-tile" aria-hidden="true"><Icon {icon} size={15} /></span>{/if}
  <div class="text">
    <label class="label" id={labelId} for="{uid}-control">{label}</label>
    {#if description}<p class="desc" id={descId}>{description}</p>{/if}
    {#if error}<p class="error" id={errorId}>{error}</p>{/if}
  </div>
  <div class="control">
    {#if onreset && !isDefault}
      <!-- Named after the setting: a page lists many of these buttons. -->
      <IconButton icon={RotateCcw} label={`Reset “${label}” to default`} size="sm" onclick={onreset} class="reset" />
    {/if}
    {@render control()}
  </div>
  {#if children}<div class="extra">{@render children()}</div>{/if}
</div>

<style>
  .setting-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    column-gap: var(--space-8);
    row-gap: var(--space-3);
    min-height: calc(3.7143rem * var(--density)); /* 52px */
    padding: calc(var(--space-3) * var(--density)) 0;
    border-bottom: 1px solid var(--hairline);
  }

  .stacked {
    grid-template-columns: 1fr;
  }

  /* novene settings row: a small monochrome tile in front of the text. */
  .has-icon {
    grid-template-columns: auto minmax(0, 1fr) auto;
    column-gap: var(--space-3);
  }

  .has-icon.stacked {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .has-icon.stacked .control,
  .has-icon .extra {
    grid-column: 2 / -1;
  }

  .has-icon .control {
    margin-left: var(--space-5);
  }

  .icon-tile {
    display: grid;
    place-items: center;
    align-self: start;
    width: 30px;
    height: 30px;
    border-radius: var(--radius);
    background: var(--selected);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
    color: var(--text);
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .label {
    font-size: 0.9286rem; /* 13px */
    font-weight: 500;
    line-height: var(--lh-snug);
    color: var(--text);
  }

  .desc {
    font-size: var(--text-sm);
    color: var(--text-3);
    line-height: 1.45;
    max-width: 60ch;
  }

  .error {
    font-size: var(--text-sm);
    color: var(--danger);
  }

  .control {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .stacked .control {
    justify-content: flex-start;
  }

  .extra {
    grid-column: 1 / -1;
  }

  .disabled .text {
    opacity: 0.55;
  }

  @media (max-width: 640px) {
    .setting-row {
      grid-template-columns: 1fr;
    }

    .has-icon {
      grid-template-columns: auto minmax(0, 1fr);
    }

    .has-icon .control {
      grid-column: 2 / -1;
      margin-left: 0;
    }

    .control {
      justify-content: flex-start;
    }

    /* A lone switch is small enough to stay on the label's row, at the end (novene's phone settings). */
    .setting-row:not(.stacked):has(> .control > :global(.switch-wrap:only-child)) {
      grid-template-columns: minmax(0, 1fr) auto;
      column-gap: var(--space-4);
    }

    .has-icon:not(.stacked):has(> .control > :global(.switch-wrap:only-child)) {
      grid-template-columns: auto minmax(0, 1fr) auto;
      column-gap: var(--space-3);
    }

    .setting-row:not(.stacked):has(> .control > :global(.switch-wrap:only-child)) > .control {
      grid-column: auto;
      justify-content: flex-end;
    }
  }
</style>
