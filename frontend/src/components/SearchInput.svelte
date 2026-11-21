<!-- Search field: magnifier, clear button, Escape clears, optional shortcut hint while empty. -->
<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import Search from '@lucide/svelte/icons/search';
  import X from '@lucide/svelte/icons/x';
  import type { ShortcutAction } from '../settings/schema';
  import Input from './Input.svelte';
  import Kbd from './Kbd.svelte';

  interface Props extends Omit<HTMLInputAttributes, 'size' | 'class' | 'value' | 'type'> {
    value?: string;
    size?: 'sm' | 'md' | 'lg';
    label?: string;
    shortcut?: string;
    action?: ShortcutAction;
    /** Sunken "well" look, as inside cards and dialogs (applied there automatically). */
    well?: boolean;
    element?: HTMLInputElement;
    onclear?: () => void;
    class?: string;
  }

  let {
    value = $bindable(''),
    size = 'md',
    label = 'Search',
    shortcut,
    action,
    element = $bindable(),
    onclear,
    class: className = '',
    placeholder = 'Search',
    onkeydown,
    ...rest
  }: Props = $props();

  let focused = $state(false);

  function clear(): void {
    value = '';
    onclear?.();
    element?.focus();
  }
</script>

<Input
  {...rest}
  bind:value
  bind:element
  type="search"
  {size}
  icon={Search}
  {placeholder}
  aria-label={rest['aria-label'] ?? label}
  autocomplete="off"
  spellcheck="false"
  class="search-input {className}"
  onfocus={(ev) => {
    focused = true;
    rest.onfocus?.(ev);
  }}
  onblur={(ev) => {
    focused = false;
    rest.onblur?.(ev);
  }}
  onkeydown={(ev) => {
    if (ev.key === 'Escape' && value) {
      ev.preventDefault();
      ev.stopPropagation();
      clear();
    }
    onkeydown?.(ev);
  }}
>
  {#snippet trailing()}
    {#if value}
      <button type="button" class="clear" aria-label="Clear search" onclick={clear}>
        <X size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    {:else if !focused && (shortcut || action)}
      <Kbd combo={shortcut} {action} />
    {/if}
  {/snippet}
</Input>

<style>
  .clear {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    color: var(--text-3);
    transition:
      color var(--t-1) var(--ease-out),
      background-color var(--t-1) var(--ease-out);
  }

  .clear:hover {
    color: var(--text);
    background: var(--press);
  }

  :global(.search-input input::-webkit-search-cancel-button) {
    display: none;
  }
</style>
