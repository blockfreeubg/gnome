<!--
  Modal dialog on the native <dialog> element (top layer, inert background, focus contained). Focus moves to
  `initialFocus` (selector) or the first focusable control and returns to the opener on close. Escape and backdrop
  clicks close unless `dismissible` is false.
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
    title: string;
    description?: string;
    size?: 'sm' | 'md' | 'lg';
    role?: 'dialog' | 'alertdialog';
    dismissible?: boolean;
    closeOnBackdrop?: boolean;
    hideClose?: boolean;
    /** CSS selector inside the dialog to focus first. */
    initialFocus?: string;
    onclose?: () => void;
    children?: Snippet;
    footer?: Snippet;
    class?: string;
  }

  let {
    open = $bindable(false),
    title,
    description,
    size = 'md',
    role = 'dialog',
    dismissible = true,
    closeOnBackdrop = true,
    hideClose = false,
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
      el.showModal();
      modalShown(el);
      void tick().then(() => {
        if (panelEl) {
          focusFirst(panelEl, initialFocus ? { preferSelector: initialFocus } : {});
          void animate(
            panelEl,
            [
              { opacity: 0, transform: canMove() ? 'translateY(6px) scale(0.985)' : 'none' },
              { opacity: 1, transform: 'none' },
            ],
            DUR[3],
          );
        }
      });
    } else if (!open && el.open) {
      const panel = panelEl;
      const done = (): void => {
        if (open) return; // reopened while the exit animation ran
        el.close();
        modalClosed(el);
        mounted = false;
        restoreFocus?.();
        restoreFocus = null;
      };
      if (panel) {
        void animate(panel, [{ opacity: 1 }, { opacity: 0, transform: canMove() ? 'scale(0.985)' : 'none' }], DUR[2]).then(done);
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
</script>

<dialog
  bind:this={dialogEl}
  class="dialog {size} {className}"
  {role}
  aria-labelledby="{uid}-title"
  aria-describedby={description ? `${uid}-desc` : undefined}
  aria-modal="true"
  oncancel={(ev) => {
    ev.preventDefault();
    if (dismissible) requestClose();
  }}
  onclose={onNativeClose}
  onpointerdown={(ev) => {
    downOnBackdrop = ev.target === dialogEl;
  }}
  onclick={(ev) => {
    if (closeOnBackdrop && dismissible && downOnBackdrop && ev.target === dialogEl) requestClose();
    downOnBackdrop = false;
  }}
>
  {#if mounted}
    <div class="panel" bind:this={panelEl} {@attach trapFocus}>
      <header class="head">
        <div class="titles">
          <h2 id="{uid}-title" class="title">{title}</h2>
          {#if description}<p id="{uid}-desc" class="desc">{description}</p>{/if}
        </div>
        {#if !hideClose && dismissible}
          <IconButton icon={X} label="Close" size="sm" tooltip={false} onclick={requestClose} />
        {/if}
      </header>
      {#if children}<div class="body">{@render children()}</div>{/if}
      {#if footer}<footer class="foot">{@render footer()}</footer>{/if}
    </div>
  {/if}
</dialog>

<style>
  /* DESIGN.md §10 Dialog: the ivy card — dense glass, a faint hairline and top highlight, a 2xl radius, a deep
     soft shadow; Montserrat 800 title with tight tracking; quiet footer without a band. */
  .dialog {
    margin: auto; /* centers the modal (the global margin reset removes the UA's auto margins) */
    width: min(var(--dialog-w), calc(100vw - 24px));
    max-height: calc(100dvh - 48px);
    overflow: visible;
    color: var(--text);
  }

  .sm {
    --dialog-w: 400px;
  }
  .md {
    --dialog-w: 520px;
  }
  .lg {
    --dialog-w: 720px;
  }

  .dialog::backdrop {
    background: var(--scrim, rgba(0, 0, 0, 0.62));
    -webkit-backdrop-filter: blur(4px);
    backdrop-filter: blur(4px);
    animation: backdrop-in calc(var(--dur-2, 160ms) * var(--motion, 1)) ease-out both;
  }

  :global(:root.no-gpu-effects) .dialog::backdrop,
  :global(:root.reduce-transparency) .dialog::backdrop {
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }

  @keyframes backdrop-in {
    from {
      opacity: 0;
    }
  }

  .panel {
    position: relative;
    display: flex;
    flex-direction: column;
    max-height: calc(100dvh - 48px);
    border-radius: var(--radius-2xl);
    background: var(--glass-bg-card);
    -webkit-backdrop-filter: var(--glass-filter);
    backdrop-filter: var(--glass-filter);
    border: 1px solid var(--hairline);
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }

  .head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-8) var(--space-5) var(--space-4) 28px;
  }

  .titles {
    flex: 1;
    min-width: 0;
  }

  .title {
    font-family: var(--font-display);
    font-variation-settings: var(--display-variation);
    font-weight: var(--weight-display, 800);
    font-size: 1.5714rem; /* 22px */
    letter-spacing: var(--tracking-display);
    line-height: var(--lh-display);
    overflow-wrap: anywhere;
  }

  .md .title,
  .lg .title {
    font-size: 1.7143rem; /* 24px */
  }

  .desc {
    margin-top: var(--space-2);
    font-size: 0.9286rem; /* 13px */
    font-weight: 500;
    line-height: var(--lh-snug);
    color: var(--text-3);
  }

  /* The close button sits in the card's top-right corner, aligned with the title's cap height. */
  .head > :global(.icon-btn) {
    margin-top: -6px;
    margin-right: -4px;
    flex: none;
  }

  .body {
    padding: var(--space-2) 28px var(--space-6);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  /* Without a body the footer follows the header directly. */
  .head + .foot {
    padding-top: var(--space-2);
  }

  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-2) 28px 26px;
  }

  /* Small cards with a plain two-action footer (cancel + confirm): equal, taller buttons across the card (ivy). */
  .sm .foot:not(:has(> :global(:nth-child(3)))) > :global(.btn) {
    flex: 1 1 0;
    min-width: 0;
    height: var(--control-h-lg);
    border-radius: var(--radius-lg);
  }

  /* Cancel in that pair reads as ivy's outlined tertiary button. */
  .sm .foot:not(:has(> :global(:nth-child(3)))) > :global(.btn.ghost) {
    border-color: var(--hairline-strong);
    color: var(--text);
  }

  @media (max-width: 520px) {
    .head {
      padding: var(--space-6) var(--space-4) var(--space-3) var(--space-5);
    }
    .body {
      padding: var(--space-1) var(--space-5) var(--space-5);
    }
    .foot {
      padding: var(--space-2) var(--space-5) var(--space-5);
    }

    /* On a phone every one- or two-action footer fills the card, whatever the dialog's size. */
    .foot:not(:has(> :global(:nth-child(3)))) > :global(.btn) {
      flex: 1 1 0;
      min-width: 0;
      height: var(--control-h-lg);
      border-radius: var(--radius-lg);
    }

    .foot:not(:has(> :global(:nth-child(3)))) > :global(.btn.ghost) {
      border-color: var(--hairline-strong);
      color: var(--text);
    }
  }
</style>
