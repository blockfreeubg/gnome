<!--
  Non-modal floating panel anchored to an element (role="dialog"). Closes on Escape and outside clicks and returns
  focus to the anchor. Use for small forms and details; use Menu for lists of actions.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { autoPosition, topLayer, type Placement } from './floating';
  import { focusFirst } from './focus';
  import { popIn } from './motion';

  interface Props {
    open: boolean;
    anchor: HTMLElement | undefined;
    label: string;
    placement?: Placement;
    /** Move focus into the popover when it opens (default true). */
    autofocus?: boolean;
    onclose?: () => void;
    width?: string;
    children: Snippet;
    class?: string;
  }

  let {
    open = $bindable(false),
    anchor,
    label,
    placement = 'bottom-start',
    autofocus = true,
    onclose,
    width,
    children,
    class: className = '',
  }: Props = $props();

  function close(refocus: boolean): void {
    if (!open) return;
    open = false;
    onclose?.();
    if (refocus) anchor?.focus();
  }

  function behaviour(node: HTMLElement): () => void {
    const stop = anchor ? autoPosition(anchor, node, placement, { offset: 6 }) : () => undefined;
    if (autofocus) queueMicrotask(() => focusFirst(node));
    const onDown = (ev: PointerEvent): void => {
      const t = ev.target as Node;
      if (!node.contains(t) && !anchor?.contains(t)) close(false);
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        close(true);
      }
    };
    // Tabbing out closes it: a non-modal panel in the top layer would otherwise cover the newly focused content.
    const onFocusOut = (ev: FocusEvent): void => {
      const next = ev.relatedTarget as Node | null;
      if (next && !node.contains(next) && !anchor?.contains(next)) close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    node.addEventListener('keydown', onKey);
    node.addEventListener('focusout', onFocusOut);
    return () => {
      stop();
      document.removeEventListener('pointerdown', onDown, true);
      node.removeEventListener('keydown', onKey);
      node.removeEventListener('focusout', onFocusOut);
    };
  }
</script>

{#if open}
  <div
    class="popover {className}"
    role="dialog"
    aria-label={label}
    tabindex="-1"
    style:width
    {@attach topLayer}
    {@attach behaviour}
    transition:popIn={{ duration: 140, origin: placement.startsWith('top') ? 'bottom center' : 'top center' }}
  >
    {@render children()}
  </div>
{/if}

<style>
  .popover {
    position: fixed;
    max-width: calc(100vw - 16px);
    max-height: calc(100dvh - 16px);
    overflow: auto;
    padding: 14px;
    border-radius: var(--radius-lg);
    /* Dense glass: popovers carry text and controls and stay legible where backdrop blur is not rendered. */
    background: var(--glass-bg-dense);
    -webkit-backdrop-filter: var(--glass-filter);
    backdrop-filter: var(--glass-filter);
    border: 1px solid var(--glass-border);
    box-shadow: var(--glass-inset), var(--shadow-pop);
    color: var(--text);
    outline: none;
  }
</style>
