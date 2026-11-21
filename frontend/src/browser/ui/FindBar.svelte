<!--
  Find in page (ENGINE-PROTOCOL §6.10): searches the tab's proxied documents through the engine host; Enter / Shift+
  Enter move to the next / previous match, Escape closes and removes the highlights.
-->
<script lang="ts">
  import CaseSensitive from '@lucide/svelte/icons/case-sensitive';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import X from '@lucide/svelte/icons/x';
  import IconButton from '../../components/IconButton.svelte';
  import { LIMITS } from '../../shared/engine-protocol';
  import { browser } from '../browser.svelte';

  let input = $state<HTMLInputElement>();
  let text = $state(browser.find.query);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const f = $derived(browser.find);

  $effect(() => {
    queueMicrotask(() => {
      input?.focus();
      input?.select();
    });
  });

  function changed(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void browser.findNext(text), 120);
  }

  function close(): void {
    void browser.findClear(true);
  }

  const count = $derived(!f.query ? '' : f.matches === 0 ? 'No matches' : `${f.active} of ${f.matches}${f.capped ? '+' : ''}`);
</script>

<div class="find" role="search" aria-label="Find in page">
  <input
    bind:this={input}
    bind:value={text}
    class="field"
    type="search"
    placeholder="Find in page"
    aria-label="Find in page"
    maxlength={LIMITS.maxFindQuery}
    oninput={changed}
    onkeydown={(ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void browser.findNext(text, ev.shiftKey);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        close();
      }
    }}
  />
  <span class="count" aria-live="polite">{count}</span>
  <IconButton
    icon={CaseSensitive}
    label="Match case"
    size="sm"
    pressed={f.caseSensitive}
    onclick={() => {
      browser.find.caseSensitive = !browser.find.caseSensitive;
      if (text) void browser.findNext(text);
    }}
  />
  <IconButton icon={ChevronUp} label="Previous match" size="sm" disabled={!f.matches} onclick={() => void browser.findNext(text, true)} />
  <IconButton icon={ChevronDown} label="Next match" size="sm" disabled={!f.matches} onclick={() => void browser.findNext(text)} />
  <IconButton icon={X} label="Close find bar" size="sm" onclick={close} />
</div>

<style>
  .find {
    position: absolute;
    top: 10px;
    right: var(--space-4);
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 5px 4px 16px;
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-pill);
    background: var(--glass-bg-dense);
    -webkit-backdrop-filter: var(--glass-filter);
    backdrop-filter: var(--glass-filter);
    box-shadow: var(--shadow-pop), var(--glass-inset);
  }

  .find:focus-within {
    border-color: var(--focus-border);
    box-shadow: var(--shadow-pop), 0 0 0 3px var(--focus-halo);
  }

  .field::placeholder {
    color: var(--text-3);
  }

  .field {
    width: 220px;
    height: 28px;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: var(--text-sm);
  }

  .field::-webkit-search-cancel-button {
    display: none;
  }

  .count {
    min-width: 72px;
    padding: 0 var(--space-2);
    color: var(--text-3);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }

  @media (max-width: 759px) {
    .find {
      left: var(--space-2);
      right: var(--space-2);
    }

    .field {
      flex: 1;
      width: auto;
    }
  }
</style>
