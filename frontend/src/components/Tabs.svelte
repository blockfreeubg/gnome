<!--
  In-page tabs (WAI-ARIA tabs, automatic activation). ←/→ move and select, Home/End jump.
  The 2px accent indicator slides under the selected tab.

  <Tabs {tabs} bind:value label="Library">{#snippet panel(id)}…{/snippet}</Tabs>
-->
<script lang="ts" generics="T extends string">
  import type { Snippet } from 'svelte';
  import type { LucideIcon } from '@lucide/svelte';
  import Icon from './Icon.svelte';

  interface Tab {
    id: T;
    label: string;
    icon?: LucideIcon;
    count?: number;
    disabled?: boolean;
  }

  interface Props {
    tabs: readonly Tab[];
    value: T;
    label: string;
    panel?: Snippet<[T]>;
    onchange?: (id: T) => void;
    class?: string;
  }

  let { tabs, value = $bindable(), label, panel, onchange, class: className = '' }: Props = $props();

  const uid = $props.id();
  let tabEls: HTMLButtonElement[] = $state([]);
  let indicator = $state({ x: 0, w: 0, ready: false });
  const index = $derived(tabs.findIndex((t) => t.id === value));

  function select(i: number, focus: boolean): void {
    const t = tabs[i];
    if (!t || t.disabled) return;
    if (t.id !== value) {
      value = t.id;
      onchange?.(t.id);
    }
    if (focus) tabEls[i]?.focus();
  }

  function onKeydown(ev: KeyboardEvent, i: number): void {
    const n = tabs.length;
    const next = (from: number, dir: 1 | -1): number => {
      for (let k = 1; k <= n; k++) {
        const j = (((from + dir * k) % n) + n) % n;
        if (!tabs[j]?.disabled) return j;
      }
      return from;
    };
    let target = -1;
    if (ev.key === 'ArrowRight') target = next(i, 1);
    else if (ev.key === 'ArrowLeft') target = next(i, -1);
    else if (ev.key === 'Home') target = next(-1, 1);
    else if (ev.key === 'End') target = next(n, -1);
    if (target >= 0) {
      ev.preventDefault();
      select(target, true);
    }
  }

  $effect(() => {
    const el = tabEls[index];
    if (!el) return;
    const update = (): void => {
      indicator = { x: el.offsetLeft, w: el.offsetWidth, ready: true };
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  });
</script>

<div class="tabs {className}">
  <div class="tablist" role="tablist" aria-label={label}>
    {#each tabs as tab, i (tab.id)}
      <button
        bind:this={tabEls[i]}
        type="button"
        role="tab"
        id="{uid}-tab-{tab.id}"
        class="tab"
        aria-selected={tab.id === value}
        aria-controls="{uid}-panel-{tab.id}"
        tabindex={tab.id === value ? 0 : -1}
        disabled={tab.disabled}
        onclick={() => select(i, false)}
        onkeydown={(ev) => onKeydown(ev, i)}
      >
        {#if tab.icon}<Icon icon={tab.icon} size={16} />{/if}
        <span>{tab.label}</span>
        {#if tab.count !== undefined}<span class="count">{tab.count}</span>{/if}
      </button>
    {/each}
    {#if indicator.ready}
      <span class="indicator" aria-hidden="true" style:transform="translateX({indicator.x}px)" style:width="{indicator.w}px"></span>
    {/if}
  </div>
  {#if panel}
    {#each tabs as tab (tab.id)}
      <div
        role="tabpanel"
        id="{uid}-panel-{tab.id}"
        aria-labelledby="{uid}-tab-{tab.id}"
        class="panel"
        hidden={tab.id !== value}
        tabindex="0"
      >
        {#if tab.id === value}{@render panel(tab.id)}{/if}
      </div>
    {/each}
  {/if}
</div>

<style>
  .tablist {
    position: relative;
    display: flex;
    gap: var(--space-5);
    border-bottom: 1px solid var(--hairline);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: calc(2.6rem * var(--density));
    min-height: var(--hit-min);
    padding: 0 2px;
    color: var(--text-2);
    font-size: 0.9286rem; /* 13px */
    font-weight: 500;
    white-space: nowrap;
    transition: color var(--t-1) var(--ease-out);
  }

  .tab:hover:not(:disabled) {
    color: var(--text);
  }

  .tab[aria-selected='true'] {
    color: var(--text);
  }

  .tab:focus-visible {
    outline-offset: -2px;
    border-radius: var(--radius-sm);
  }

  .tab:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .count {
    font-size: var(--text-xs);
    min-width: 18px;
    padding: 1px 6px;
    border-radius: var(--radius-pill);
    background: var(--selected);
    color: var(--text-2);
    font-weight: 600;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  .indicator {
    position: absolute;
    left: 0;
    bottom: -1px;
    height: 2px;
    border-radius: 2px 2px 0 0;
    /* Monochrome selection (DESIGN.md §10 Tabs): the accent is for actions, not navigation. */
    background: var(--text);
    transition:
      transform var(--t-2) var(--ease-out),
      width var(--t-2) var(--ease-out);
  }

  .panel {
    padding-top: var(--space-5);
    outline: none;
  }

  .panel:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 4px;
    border-radius: var(--radius-sm);
  }
</style>
