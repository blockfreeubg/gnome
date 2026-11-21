<!--
  Editable list of strings (start-up pages, Wisp servers, allowed sites): add with validation, remove, reorder-free.
  `hostChoice` adds an "Only this host" checkbox whose value `parse` receives (the content blocker's allowlist).
-->
<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import X from '@lucide/svelte/icons/x';
  import Button from '../../components/Button.svelte';
  import Checkbox from '../../components/Checkbox.svelte';
  import Field from '../../components/Field.svelte';
  import { getFieldContext } from '../../components/field-context';
  import IconButton from '../../components/IconButton.svelte';
  import Input from '../../components/Input.svelte';

  interface Props {
    items: readonly string[];
    /** Accessible name of the input ("Add a start-up page"). */
    inputLabel: string;
    placeholder?: string;
    addLabel?: string;
    emptyText: string;
    max: number;
    mono?: boolean;
    /** Returns the value to store, or an error message. */
    parse: (raw: string, opts: { onlyThisHost: boolean }) => { value: string } | { error: string };
    onchange: (items: string[]) => void;
    /** Show an "Only this host" checkbox (its value goes to `parse`). */
    hostChoice?: boolean;
  }

  let { items, inputLabel, placeholder, addLabel = 'Add', emptyText, max, mono = true, parse, onchange, hostChoice = false }: Props = $props();
  let onlyHost = $state(false);

  let draft = $state('');
  let error = $state<string | null>(null);
  /** The settings row this editor sits in is disabled: the list is shown but cannot be changed. */
  const row = getFieldContext();
  const locked = $derived(row?.disabled ?? false);

  function add(ev?: SubmitEvent): void {
    ev?.preventDefault();
    if (locked || !draft.trim()) return;
    const r = parse(draft, { onlyThisHost: onlyHost });
    if ('error' in r) {
      error = r.error;
      return;
    }
    if (items.includes(r.value)) {
      error = 'Already in the list.';
      return;
    }
    if (items.length >= max) {
      error = `The list can hold ${max} entries.`;
      return;
    }
    onchange([...items, r.value]);
    draft = '';
    onlyHost = false;
    error = null;
  }

  function remove(item: string): void {
    onchange(items.filter((i) => i !== item));
  }
</script>

<div class="list-editor">
  {#if items.length}
    <ul class="items">
      {#each items as item (item)}
        <li>
          <span class="value truncate" class:mono title={item}>{item}</span>
          <IconButton icon={X} label="Remove {item}" size="sm" disabled={locked} onclick={() => remove(item)} />
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">{emptyText}</p>
  {/if}
  <form class="add" onsubmit={add}>
    <Field label={inputLabel} hideLabel {error}>
      <Input bind:value={draft} {placeholder} {mono} size="sm" oninput={() => (error = null)} autocomplete="off" spellcheck={false} />
    </Field>
    <Button type="submit" size="sm" icon={Plus} disabled={locked || !draft.trim()}>{addLabel}</Button>
  </form>
  {#if hostChoice}
    <Checkbox label="Only this host (not its subdomains)" checked={onlyHost} disabled={locked} onchange={(v) => (onlyHost = v)} />
  {/if}
</div>

<style>
  .list-editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: 100%;
  }

  .items {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
  }

  .items li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 2px var(--space-1) 2px var(--space-3);
    min-height: 36px;
  }

  .items li + li {
    border-top: 1px solid var(--hairline);
  }

  .value {
    flex: 1;
    font-size: var(--text-sm);
  }

  .mono {
    font-family: var(--font-mono);
  }

  .empty {
    font-size: var(--text-sm);
    color: var(--text-3);
  }

  .add {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .add > :global(:first-child) {
    flex: 1;
    min-width: 0;
  }
</style>
