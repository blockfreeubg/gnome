<!--
  Modal sheet sliding from an edge (left · right · bottom), on the native <dialog> element.
  Bottom sheets have a grab handle and can be dragged down to dismiss.
-->
<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import X from '@lucide/svelte/icons/x';
  import { captureFocus, focusFirst, trapFocus } from './focus';
  import { modalClosed, modalShown } from './modal-stack.svelte';
  import { animate, canMove, DUR } from './motion';
  import IconButton from './IconButton.svelte';

  interface Props {
    open: boolean;
    side?: 'left' | 'right' | 'bottom';
    title: string;
    /** Visually hide the title (still labels the sheet). */
    hideTitle?: boolean;
    /** Width for side sheets / max height for bottom sheets (CSS length). */
    size?: string;
    initialFocus?: string;
    onclose?: () => void;
    children?: Snippet;
    footer?: Snippet;
    class?: string;
  }

  let {
    open = $bindable(false),
    side = 'right',
    title,
    hideTitle = false,
    size,
    initialFocus,
    onclose,
    children,
    footer,
    class: className = '',
  }: Props = $props();

  const uid = $props.id();
  let dialogEl = $state<HTMLDialogElement>();
  let panelEl = $state<HTMLDivElement>();
  let mounted = $state(false);
  let restoreFocus: (() => void) | null = null;
  let downOnBackdrop = false;

  // Drag-to-dismiss (bottom sheets).
  let dragY = $state(0);
  let dragging = $state(false);
  let dragStart = { y: 0, t: 0 };

  const offscreen = $derived(side === 'left' ? 'translateX(-100%)' : side === 'right' ? 'translateX(100%)' : 'translateY(100%)');

  function requestClose(): void {
    if (!open) return;
    open = false;
    onclose?.();
  }

  /** The browser closed the dialog itself (e.g. a repeated Escape is not cancelable): bring state in line. */
  function onNativeClose(): void {
    // Our own close() at the end of the exit animation, or reopened before this asynchronous event arrived.
    if (!open || dialogEl?.open) return;
    if (dialogEl) modalClosed(dialogEl);
    mounted = false;
    dragY = 0;
    restoreFocus?.();
    restoreFocus = null;
    requestClose();
  }

  $effect(() => {
    const el = dialogEl;
    if (!el) return;
    if (open && !el.open) {
      restoreFocus = captureFocus();
      mounted = true;
      dragY = 0;
      el.showModal();
      modalShown(el);
      void tick().then(() => {
        if (!panelEl) return;
        focusFirst(panelEl, initialFocus ? { preferSelector: initialFocus } : {});
        void animate(
          panelEl,
          canMove() ? [{ transform: offscreen }, { transform: 'none' }] : [{ opacity: 0 }, { opacity: 1 }],
          DUR[4],
        );
      });
    } else if (!open && el.open) {
      const panel = panelEl;
      const done = (): void => {
        if (open) return; // reopened while the exit animation ran
        el.close();
        modalClosed(el);
        mounted = false;
        dragY = 0;
        restoreFocus?.();
        restoreFocus = null;
      };
      if (panel) {
        const from = dragY ? `translateY(${dragY}px)` : 'none';
        void animate(panel, canMove() ? [{ transform: from }, { transform: offscreen }] : [{ opacity: 1 }, { opacity: 0 }], DUR[3]).then(done);
      } else done();
    }
  });

  // Destroyed while open (e.g. the page that owns it went away).
  $effect(() => {
    const el = dialogEl;
    return () => {
      if (el) modalClosed(el);
    };
  });

  function onDragStart(ev: PointerEvent): void {
    if (side !== 'bottom' || ev.button !== 0) return;
    if ((ev.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    dragging = true;
    dragStart = { y: ev.clientY, t: performance.now() };
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }

  function onDragMove(ev: PointerEvent): void {
    if (!dragging) return;
    dragY = Math.max(0, ev.clientY - dragStart.y);
  }

  function onDragEnd(ev: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    const dt = Math.max(1, performance.now() - dragStart.t);
    const velocity = (ev.clientY - dragStart.y) / dt;
    const height = panelEl?.offsetHeight ?? 400;
    if (dragY > height * 0.28 || velocity > 0.6) requestClose();
    else {
      const from = dragY;
      dragY = 0;
      if (panelEl) void animate(panelEl, [{ transform: `translateY(${from}px)` }, { transform: 'none' }], DUR[2]);
    }
  }
</script>

<dialog
  bind:this={dialogEl}
  class="sheet {side} {className}"
  aria-labelledby="{uid}-title"
  aria-modal="true"
  style:--sheet-size={size}
  oncancel={(ev) => {
    ev.preventDefault();
    requestClose();
  }}
  onclose={onNativeClose}
  onpointerdown={(ev) => {
    downOnBackdrop = ev.target === dialogEl;
  }}
  onclick={(ev) => {
    if (downOnBackdrop && ev.target === dialogEl) requestClose();
    downOnBackdrop = false;
  }}
>
  {#if mounted}
    <div
      class="panel"
      class:dragging
      bind:this={panelEl}
      style:transform={dragY ? `translateY(${dragY}px)` : undefined}
      {@attach trapFocus}
    >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <header
        class="head"
        onpointerdown={onDragStart}
        onpointermove={onDragMove}
        onpointerup={onDragEnd}
        onpointercancel={onDragEnd}
      >
        {#if side === 'bottom'}<span class="handle" aria-hidden="true"></span>{/if}
        <h2 id="{uid}-title" class="title" class:sr-only={hideTitle}>{title}</h2>
        <IconButton icon={X} label="Close" size="sm" tooltip={false} onclick={requestClose} />
      </header>
      {#if children}<div class="body">{@render children()}</div>{/if}
      {#if footer}<footer class="foot">{@render footer()}</footer>{/if}
    </div>
  {/if}
</dialog>

<style>
  .sheet {
    margin: 0;
    padding: 0;
    color: var(--text);
    overflow: visible;
  }

  .sheet.right {
    inset: 0 0 0 auto;
    height: 100dvh;
    width: min(var(--sheet-size, 400px), 100vw);
  }

  .sheet.left {
    inset: 0 auto 0 0;
    height: 100dvh;
    width: min(var(--sheet-size, 400px), 100vw);
  }

  .sheet.bottom {
    inset: auto 0 0 0;
    width: 100%;
    max-height: var(--sheet-size, 86dvh);
  }

  .sheet::backdrop {
    background: var(--scrim, rgba(0, 0, 0, 0.62));
    -webkit-backdrop-filter: blur(4px);
    backdrop-filter: blur(4px);
    animation: backdrop-in calc(var(--dur-3, 240ms) * var(--motion, 1)) ease-out both;
  }

  :global(:root.no-gpu-effects) .sheet::backdrop,
  :global(:root.reduce-transparency) .sheet::backdrop {
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }

  @keyframes backdrop-in {
    from {
      opacity: 0;
    }
  }

  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    max-height: inherit;
    background: var(--glass-bg);
    -webkit-backdrop-filter: var(--glass-filter);
    backdrop-filter: var(--glass-filter);
    box-shadow: var(--glass-inset), var(--shadow-sheet);
    overflow: hidden;
  }

  /* DESIGN.md §10 Sheet: glass, a hairline and the 2xl radius on the open edge. */
  .left .panel {
    border-right: 1px solid var(--hairline-strong);
    border-radius: 0 var(--radius-2xl) var(--radius-2xl) 0;
  }

  .right .panel {
    border-left: 1px solid var(--hairline-strong);
    border-radius: var(--radius-2xl) 0 0 var(--radius-2xl);
  }

  .bottom .panel {
    border-top: 1px solid var(--hairline-strong);
    border-radius: var(--radius-2xl) var(--radius-2xl) 0 0;
    padding-bottom: var(--safe-bottom);
    touch-action: none;
  }

  .head {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-5) var(--space-4) var(--space-3) var(--space-6);
  }

  .bottom .head {
    padding-top: var(--space-6);
    cursor: grab;
  }

  .dragging .head {
    cursor: grabbing;
  }

  .handle {
    position: absolute;
    top: 8px;
    left: 50%;
    width: 36px;
    height: 4px;
    margin-left: -18px;
    border-radius: var(--radius-pill);
    background: var(--hairline-strong);
  }

  .title {
    flex: 1;
    font-family: var(--font-display);
    font-variation-settings: var(--display-variation);
    font-weight: var(--weight-display, 800);
    font-size: var(--text-xl);
    letter-spacing: var(--tracking-display);
    line-height: var(--lh-display);
  }

  .body {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0 var(--space-6) var(--space-6);
    touch-action: pan-y;
  }

  .foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-6);
    border-top: 1px solid var(--hairline);
  }
</style>
