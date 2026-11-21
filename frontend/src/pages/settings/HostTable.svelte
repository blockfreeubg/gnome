<!--
  Host-keyed rules (per-site overrides, cookie rules, site permissions): one row per host with its own controls.
  `siteRules` (the content blocker's editors, WAVE-B3 §7.1): a bare host typed in is stored as `*.<host>` unless
  "Only this host" is ticked (hosts.ts siteRuleKeyFromInput); the site-permission editor keeps the host as typed.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Button from '../../components/Button.svelte';
  import Checkbox from '../../components/Checkbox.svelte';
  import Field from '../../components/Field.svelte';
  import { getFieldContext } from '../../components/field-context';
  import IconButton from '../../components/IconButton.svelte';
  import Input from '../../components/Input.svelte';
  import { normalizeHostInput, siteRuleKeyFromInput, sortHosts } from './hosts';

  interface Props {
    hosts: Iterable<string>;
    inputLabel: string;
    emptyText: string;
    max: number;
    onadd: (host: string) => void;
    onremove: (host: string) => void;
    cell: Snippet<[string]>;
    /** Store a bare host as `*.<host>`, with an "Only this host" choice (the content blocker's site rules). */
    siteRules?: boolean;
  }

  let { hosts, inputLabel, emptyText, max, onadd, onremove, cell, siteRules = false }: Props = $props();
  let onlyHost = $state(false);

  const sorted = $derived(sortHosts(hosts));
  let draft = $state('');
  let error = $state<string | null>(null);
  /** The settings row this table sits in is disabled: rules are shown but cannot be changed. */
  const row = getFieldContext();
  const locked = $derived(row?.disabled ?? false);

  function add(ev: SubmitEvent): void {
    ev.preventDefault();
    if (locked) return;
    const host = siteRules ? siteRuleKeyFromInput(draft, onlyHost) : normalizeHostInput(draft);
    if (!host) {
      error = 'Enter a host name such as example.com.';
      return;
    }
    if (sorted.includes(host)) {
      error = `${host} already has a rule.`;
      return;
    }
    if (sorted.length >= max) {
      error = `Up to ${max} sites.`;
      return;
    }
    onadd(host);
    draft = '';
    onlyHost = false;
    error = null;
  }
</script>

<div class="host-table">
  {#if sorted.length}
    <ul class="rows">
      {#each sorted as host (host)}
        <li>
          <span class="host truncate" title={host}>{host}</span>
          <div class="cell">{@render cell(host)}</div>
          <IconButton icon={Trash2} label="Remove the rule for {host}" size="sm" disabled={locked} onclick={() => onremove(host)} />
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">{emptyText}</p>
  {/if}
  <form class="add" onsubmit={add}>
    <Field label={inputLabel} hideLabel {error}>
      <Input bind:value={draft} placeholder="example.com" mono size="sm" oninput={() => (error = null)} autocomplete="off" spellcheck={false} />
    </Field>
    <Button type="submit" size="sm" icon={Plus} disabled={locked || !draft.trim()}>Add site</Button>
  </form>
  {#if siteRules}
    <Checkbox label="Only this host (not its subdomains)" checked={onlyHost} disabled={locked} onchange={(v) => (onlyHost = v)} />
  {/if}
</div>

<style>
  .host-table {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: 100%;
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
  }

  .rows li {
    display: grid;
    grid-template-columns: minmax(8rem, 1fr) auto auto;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-1) var(--space-1) var(--space-1) var(--space-3);
    min-height: 40px;
  }

  .rows li + li {
    border-top: 1px solid var(--hairline);
  }

  .host {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  .cell {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
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

  @media (max-width: 640px) {
    .rows li {
      grid-template-columns: 1fr auto;
    }

    .cell {
      grid-column: 1 / -1;
      grid-row: 2;
      justify-content: flex-start;
      padding-bottom: var(--space-2);
    }
  }
</style>
