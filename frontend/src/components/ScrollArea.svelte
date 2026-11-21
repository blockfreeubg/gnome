<!--
  Scroll container with thin scrollbars and soft edge fades that appear only when content is clipped.
  Pass `label` when the region holds non-focusable content so keyboard users can focus and scroll it.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    orientation?: 'vertical' | 'horizontal';
    maxHeight?: string;
    label?: string;
    fade?: boolean;
    element?: HTMLDivElement;
    class?: string;
    children: Snippet;
  }

  let {
    orientation = 'vertical',
    maxHeight,
    label,
    fade = true,
    element = $bindable(),
    class: className = '',
    children,
  }: Props = $props();

  let atStart = $state(true);
  let atEnd = $state(true);

  function update(): void {
    const el = element;
    if (!el) return;
    if (orientation === 'vertical') {
      atStart = el.scrollTop <= 1;
      atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    } else {
      atStart = el.scrollLeft <= 1;
      atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
    }
  }

  $effect(() => {
    const el = element;
    if (!el) return;
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrollable region must be keyboard-focusable) -->
<div
  bind:this={element}
  class="scroll-area {orientation} {className}"
  class:fade-start={fade && !atStart}
  class:fade-end={fade && !atEnd}
  style:max-height={maxHeight}
  role={label ? 'region' : undefined}
  aria-label={label}
  tabindex={label ? 0 : undefined}
  onscroll={update}
>
  {@render children()}
</div>

<style>
  .scroll-area {
    --fade: 18px;
    overscroll-behavior: contain;
    scrollbar-width: thin;
  }

  .vertical {
    overflow-y: auto;
    overflow-x: hidden;
  }

  .horizontal {
    overflow-x: auto;
    overflow-y: hidden;
  }

  .vertical.fade-start {
    mask-image: linear-gradient(to bottom, transparent, #000 var(--fade));
  }
  .vertical.fade-end {
    mask-image: linear-gradient(to top, transparent, #000 var(--fade));
  }
  .vertical.fade-start.fade-end {
    mask-image: linear-gradient(to bottom, transparent, #000 var(--fade), #000 calc(100% - var(--fade)), transparent);
  }

  .horizontal.fade-start {
    mask-image: linear-gradient(to right, transparent, #000 var(--fade));
  }
  .horizontal.fade-end {
    mask-image: linear-gradient(to left, transparent, #000 var(--fade));
  }
  .horizontal.fade-start.fade-end {
    mask-image: linear-gradient(to right, transparent, #000 var(--fade), #000 calc(100% - var(--fade)), transparent);
  }

  .scroll-area:focus-visible {
    outline-offset: -2px;
  }
</style>
