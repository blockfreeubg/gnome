<!--
  Keyboard shortcut key caps, formatted for the platform (⌘ ⌥ ⇧ on Apple, Ctrl Alt Shift elsewhere).
  <Kbd combo="Mod+K" /> · <Kbd action="openSettings" /> (reads the user's binding) · <Kbd keys={['↑', '↓']} />
-->
<script lang="ts">
  import { bindingFor } from '../app/shortcuts';
  import { describeCombo, formatCombo } from '../lib/keys';
  import { isApplePlatform } from '../lib/platform';
  import type { ShortcutAction } from '../settings/schema';

  interface Props {
    combo?: string;
    action?: ShortcutAction;
    keys?: string[];
    size?: 'sm' | 'md';
    class?: string;
  }

  let { combo, action, keys, size = 'sm', class: className = '' }: Props = $props();

  const apple = isApplePlatform();
  const resolved = $derived(combo ?? (action ? bindingFor(action) : ''));
  const caps = $derived(keys ?? (resolved ? formatCombo(resolved, apple) : []));
  const label = $derived(keys ? keys.join(' ') : resolved ? describeCombo(resolved, apple) : '');
</script>

{#if caps.length}
  <!-- aria-label is not allowed on <kbd> (no role): screen readers get the spelled-out combo as hidden text. -->
  <kbd class="kbd {size} {className}" title={label}>
    <span class="sr-only">{label}</span>
    {#each caps as cap, i (i)}
      <span class="cap" aria-hidden="true">{cap}</span>
    {/each}
  </kbd>
{/if}

<style>
  .kbd {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1;
    color: var(--text-2);
    white-space: nowrap;
  }

  .cap {
    display: inline-grid;
    place-items: center;
    min-width: 1.6em;
    height: 1.6em;
    padding: 0 0.4em;
    border: 1px solid var(--hairline-strong);
    border-radius: min(var(--radius-sm), 6px);
    background: var(--surface-1);
    box-shadow: inset 0 -1px 0 var(--hairline);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .md {
    font-size: var(--text-sm);
  }
</style>
