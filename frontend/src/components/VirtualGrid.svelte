<!--
  Windowed responsive grid (game catalogs). Column count follows the available width (`minItemWidth` + `gap`);
  row height may depend on the column width (e.g. 16:9 thumbnails + caption). Only visible rows render.
  Keyboard (role="grid"): ←→ move, ↑↓ move by a row, Home/End row start/end, Ctrl+Home/End first/last,
  PageUp/PageDown by a screen, Enter activates. `onEndReached` drives infinite scroll.
-->
<script lang="ts" generics="T">
  import { untrack, type Snippet } from 'svelte';
  import { ensureVisible, gridColumns, observeScroll, scrollParent, type ScrollMetrics } from './virtual';

  interface Props {
    items: readonly T[];
    minItemWidth: number;
    /** Row content height for a given column width (px), excluding the gap. */
    itemHeight: number | ((columnWidth: number) => number);
    gap?: number;
    maxColumns?: number;
    getKey?: (item: T, index: number) => string | number;
    label: string;
    scroller?: 'self' | 'parent';
    height?: string;
    overscanRows?: number;
    activeIndex?: number;
    item: Snippet<[T, { index: number; active: boolean; width: number; height: number }]>;
    empty?: Snippet;
    onactivate?: (item: T, index: number) => void;
    onEndReached?: () => void;
    endThreshold?: number;
    class?: string;
  }

  let {
    items,
    minItemWidth,
    itemHeight,
    gap = 16,
    maxColumns = 12,
    getKey = (_item: T, index: number) => index,
    label,
    scroller = 'parent',
    height = '100%',
    overscanRows = 2,
    activeIndex = $bindable(-1),
    item,
    empty,
    onactivate,
    onEndReached,
    endThreshold = 800,
    class: className = '',
  }: Props = $props();

  const uid = $props.id();
  let gridEl = $state<HTMLDivElement>();
  let width = $state(0);
  let metrics = $state<ScrollMetrics>({ scrollTop: 0, viewport: 800, listTop: 0 });
  let scrollerEl: HTMLElement | null = null;
  let reachedFor = -1;

  const columns = $derived(gridColumns(width, minItemWidth, gap, maxColumns));
  const colWidth = $derived(columns > 0 ? (width - gap * (columns - 1)) / columns : width);
  const cellHeight = $derived(Math.round(typeof itemHeight === 'number' ? itemHeight : itemHeight(colWidth)));
  const rowStride = $derived(cellHeight + gap);
  const rowCount = $derived(Math.ceil(items.length / columns));
  const total = $derived(Math.max(0, rowCount * rowStride - gap));
  const local = $derived(scroller === 'self' ? metrics.scrollTop : metrics.scrollTop - metrics.listTop);
  const firstRow = $derived(Math.max(0, Math.floor(local / rowStride) - overscanRows));
  const lastRow = $derived(Math.min(rowCount - 1, Math.ceil((local + metrics.viewport) / rowStride) + overscanRows));
  const rows = $derived.by(() => {
    const out: Array<{ row: number; cells: Array<{ item: T; index: number }> }> = [];
    for (let r = firstRow; r <= lastRow; r++) {
      const cells: Array<{ item: T; index: number }> = [];
      for (let c = 0; c < columns; c++) {
        const index = r * columns + c;
        if (index >= items.length) break;
        cells.push({ item: items[index] as T, index });
      }
      out.push({ row: r, cells });
    }
    return out;
  });

  $effect(() => {
    const el = gridEl;
    if (!el) return;
    const ro = new ResizeObserver(() => (width = el.clientWidth));
    ro.observe(el);
    width = el.clientWidth;
    scrollerEl = scroller === 'self' ? el : scrollParent(el);
    if (scroller === 'self') {
      const update = (): void => {
        metrics = { scrollTop: el.scrollTop, viewport: el.clientHeight, listTop: 0 };
      };
      update();
      el.addEventListener('scroll', update, { passive: true });
      ro.observe(el);
      return () => {
        ro.disconnect();
        el.removeEventListener('scroll', update);
      };
    }
    const stop = observeScroll(el, scrollerEl, (m) => (metrics = m));
    return () => {
      ro.disconnect();
      stop();
    };
  });

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

  function setActive(i: number): void {
    if (items.length === 0) return;
    const next = Math.max(0, Math.min(items.length - 1, i));
    activeIndex = next;
    const row = Math.floor(next / columns);
    ensureVisible(scrollerEl, scroller === 'self' ? 0 : metrics.listTop, row * rowStride, cellHeight);
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (items.length === 0) return;
    const cur = Math.max(0, activeIndex);
    const visibleRows = Math.max(1, Math.floor(metrics.viewport / rowStride));
    switch (ev.key) {
      case 'ArrowRight':
        setActive(cur + 1);
        break;
      case 'ArrowLeft':
        setActive(cur - 1);
        break;
      case 'ArrowDown':
        if (cur + columns < items.length) setActive(cur + columns);
        break;
      case 'ArrowUp':
        if (cur - columns >= 0) setActive(cur - columns);
        break;
      case 'Home':
        setActive(ev.ctrlKey || ev.metaKey ? 0 : cur - (cur % columns));
        break;
      case 'End':
        setActive(ev.ctrlKey || ev.metaKey ? items.length - 1 : Math.min(items.length - 1, cur - (cur % columns) + columns - 1));
        break;
      case 'PageDown':
        setActive(Math.min(items.length - 1, cur + visibleRows * columns));
        break;
      case 'PageUp':
        setActive(Math.max(0, cur - visibleRows * columns));
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
  <div
    bind:this={gridEl}
    class="vgrid {scroller} {className}"
    style:height={scroller === 'self' ? height : `${total}px`}
    role="grid"
    aria-label={label}
    aria-rowcount={rowCount}
    aria-colcount={columns}
    tabindex="0"
    aria-activedescendant={activeIndex >= 0 ? `${uid}-cell-${activeIndex}` : undefined}
    onkeydown={onKeydown}
    onfocus={() => {
      if (activeIndex < 0 && items.length) activeIndex = Math.min(items.length - 1, firstRow * columns);
    }}
  >
    <div class="spacer" style:height="{total}px">
      {#each rows as r (r.row)}
        <div
          class="row"
          role="row"
          aria-rowindex={r.row + 1}
          style:transform="translateY({r.row * rowStride}px)"
          style:height="{cellHeight}px"
          style:grid-template-columns="repeat({columns}, minmax(0, 1fr))"
          style:column-gap="{gap}px"
        >
          {#each r.cells as c (getKey(c.item, c.index))}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              id="{uid}-cell-{c.index}"
              class="cell"
              class:active={c.index === activeIndex}
              role="gridcell"
              tabindex="-1"
              aria-colindex={(c.index % columns) + 1}
              aria-selected={c.index === activeIndex}
              onpointerdown={() => (activeIndex = c.index)}
            >
              {@render item(c.item, { index: c.index, active: c.index === activeIndex, width: colWidth, height: cellHeight })}
            </div>
          {/each}
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .vgrid {
    position: relative;
    outline: none;
  }

  .vgrid.self {
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .vgrid:focus-visible {
    box-shadow: 0 0 0 2px var(--focus);
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
    display: grid;
  }

  .cell {
    min-width: 0;
    height: 100%;
  }

  .vgrid:focus-visible .cell.active {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
    border-radius: var(--radius);
  }
</style>
