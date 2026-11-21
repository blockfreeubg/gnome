<!--
  Windowed list: renders only the rows in (and near) the viewport. Heights are fixed or per-item (known, not
  measured). Scrolls itself (`scroller="self"`, fills its parent's height) or follows the nearest scrolling ancestor
  (`scroller="parent"`, e.g. the page). Keyboard: ↑↓ Home End PageUp PageDown move the active row, Enter activates.
  `onEndReached` fires once per length change when the end comes within `endThreshold` px (infinite scroll).
-->
<script lang="ts" generics="T">
  import { untrack, type Snippet } from 'svelte';
  import { ensureVisible, observeScroll, prefixOffsets, scrollParent, visibleRange, type ScrollMetrics } from './virtual';

  interface Props {
    items: readonly T[];
    itemHeight: number | ((item: T, index: number) => number);
    getKey?: (item: T, index: number) => string | number;
    label: string;
    scroller?: 'self' | 'parent';
    /** CSS height in self mode (default fills the parent). */
    height?: string;
    overscan?: number;
    /** 'listbox' (selectable rows, default) or 'list'. */
    role?: 'listbox' | 'list';
    activeIndex?: number;
    item: Snippet<[T, { index: number; active: boolean }]>;
    empty?: Snippet;
    onactivate?: (item: T, index: number) => void;
    onEndReached?: () => void;
    endThreshold?: number;
    class?: string;
  }

  let {
    items,
    itemHeight,
    getKey = (_item: T, index: number) => index,
    label,
    scroller = 'self',
    height = '100%',
    overscan = 480,
    role = 'listbox',
    activeIndex = $bindable(-1),
    item,
    empty,
    onactivate,
    onEndReached,
    endThreshold = 600,
    class: className = '',
  }: Props = $props();

  const uid = $props.id();
  let listEl = $state<HTMLDivElement>();
  let metrics = $state<ScrollMetrics>({ scrollTop: 0, viewport: 800, listTop: 0 });
  let scrollerEl: HTMLElement | null = null;
  let reachedFor = -1;

  const offsets = $derived(
    prefixOffsets(items.length, typeof itemHeight === 'number' ? () => itemHeight : (i) => itemHeight(items[i] as T, i)),
  );
  const total = $derived(offsets[items.length] ?? 0);
  const local = $derived(scroller === 'self' ? metrics.scrollTop : metrics.scrollTop - metrics.listTop);
  const range = $derived(visibleRange(offsets, local, metrics.viewport, overscan));
  const visible = $derived.by(() => {
    const out: Array<{ item: T; index: number }> = [];
    for (let i = range.start; i <= range.end; i++) out.push({ item: items[i] as T, index: i });
    return out;
  });

  $effect(() => {
    const el = listEl;
    if (!el) return;
    scrollerEl = scroller === 'self' ? el : scrollParent(el);
    if (scroller === 'self') {
      const update = (): void => {
        metrics = { scrollTop: el.scrollTop, viewport: el.clientHeight, listTop: 0 };
      };
      update();
      const ro = new ResizeObserver(update);
      ro.observe(el);
      el.addEventListener('scroll', update, { passive: true });
      return () => {
        ro.disconnect();
        el.removeEventListener('scroll', update);
      };
    }
    return observeScroll(el, scrollerEl, (m) => (metrics = m));
  });

  // Infinite scroll.
  $effect(() => {
    if (!onEndReached || items.length === 0) return;
    const remaining = total - (local + metrics.viewport);
    if (remaining < endThreshold && reachedFor !== items.length) {
      reachedFor = items.length;
      // The callback typically reads and sets loading state: keep its reads out of this effect's dependencies.
      const cb = onEndReached;
      untrack(() => cb());
    }
  });

  function heightOf(i: number): number {
    return (offsets[i + 1] ?? 0) - (offsets[i] ?? 0);
  }

  function setActive(i: number): void {
    if (items.length === 0) return;
    const next = Math.max(0, Math.min(items.length - 1, i));
    activeIndex = next;
    ensureVisible(scrollerEl, scroller === 'self' ? 0 : metrics.listTop, offsets[next] ?? 0, heightOf(next));
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (items.length === 0) return;
    const page = Math.max(1, Math.floor(metrics.viewport / Math.max(1, heightOf(Math.max(0, activeIndex)))) - 1);
    switch (ev.key) {
      case 'ArrowDown':
        setActive(activeIndex + 1);
        break;
      case 'ArrowUp':
        setActive(activeIndex <= 0 ? 0 : activeIndex - 1);
        break;
      case 'Home':
        setActive(0);
        break;
      case 'End':
        setActive(items.length - 1);
        break;
      case 'PageDown':
        setActive(activeIndex + page);
        break;
      case 'PageUp':
        setActive(activeIndex - page);
        break;
      case 'Enter':
      case ' ':
        if (activeIndex >= 0 && items[activeIndex] !== undefined) onactivate?.(items[activeIndex] as T, activeIndex);
        else return;
        break;
      default:
        return;
    }
    ev.preventDefault();
  }
</script>

{#if items.length === 0 && empty}
  {@render empty()}
{:else}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    bind:this={listEl}
    class="vlist {scroller} {className}"
    style:height={scroller === 'self' ? height : `${total}px`}
    {role}
    aria-label={label}
    tabindex="0"
    aria-activedescendant={role === 'listbox' && activeIndex >= 0 ? `${uid}-row-${activeIndex}` : undefined}
    onkeydown={onKeydown}
    onfocus={() => {
      if (activeIndex < 0 && items.length) activeIndex = Math.max(0, range.start);
    }}
  >
    <div class="spacer" style:height="{total}px">
      {#each visible as v (getKey(v.item, v.index))}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          id="{uid}-row-{v.index}"
          class="row"
          class:active={v.index === activeIndex}
          role={role === 'listbox' ? 'option' : 'listitem'}
          aria-selected={role === 'listbox' ? v.index === activeIndex : undefined}
          aria-posinset={v.index + 1}
          aria-setsize={items.length}
          style:transform="translateY({offsets[v.index]}px)"
          style:height="{heightOf(v.index)}px"
          onpointerdown={() => (activeIndex = v.index)}
          onclick={() => role === 'listbox' && onactivate?.(v.item, v.index)}
        >
          {@render item(v.item, { index: v.index, active: v.index === activeIndex })}
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .vlist {
    position: relative;
    outline: none;
    contain: strict;
  }

  .vlist.self {
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .vlist.parent {
    contain: layout style;
  }

  .vlist:focus-visible {
    box-shadow: inset 0 0 0 2px var(--focus);
    border-radius: var(--radius);
  }

  .spacer {
    position: relative;
    width: 100%;
  }

  .row {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    will-change: transform;
  }

  /* The keyboard cursor is the monochrome "current item" of DESIGN.md §1.2: a tint in a rounded box. */
  .vlist:focus-visible .row.active {
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
    background: var(--selected);
  }
</style>
