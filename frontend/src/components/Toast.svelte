<!--
  A single toast: icon by kind, title, description, actions and a dismiss button. Auto-dismisses after `duration`
  ms (null = stays) and pauses while hovered, focused or while the page is hidden.
-->
<script lang="ts" module>
  export interface ToastViewAction {
    label: string;
    onClick: () => void | Promise<void>;
    dismiss?: boolean;
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Info from '@lucide/svelte/icons/info';
  import X from '@lucide/svelte/icons/x';
  import Icon from './Icon.svelte';

  interface Props {
    title: string;
    description?: string;
    kind?: 'info' | 'success' | 'warning' | 'error';
    actions?: readonly ToastViewAction[];
    duration?: number | null;
    ondismiss: () => void;
  }

  let { title, description, kind = 'info', actions = [], duration = 5000, ondismiss }: Props = $props();

  const ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert } as const;

  let remaining = 0;
  let startedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hovered = false;
  let focused = false;

  function stop(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      remaining -= performance.now() - startedAt;
    }
  }

  function start(): void {
    if (duration === null || timer || hovered || focused || document.visibilityState === 'hidden') return;
    startedAt = performance.now();
    timer = setTimeout(ondismiss, Math.max(0, remaining));
  }

  onMount(() => {
    remaining = duration ?? 0;
    start();
    const onVis = (): void => (document.visibilityState === 'hidden' ? stop() : start());
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  });

  async function run(action: ToastViewAction): Promise<void> {
    try {
      await action.onClick();
    } finally {
      if (action.dismiss !== false) ondismiss();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<article
  class="toast {kind}"
  aria-label={title}
  onpointerenter={() => {
    hovered = true;
    stop();
  }}
  onpointerleave={() => {
    hovered = false;
    start();
  }}
  onfocusin={() => {
    focused = true;
    stop();
  }}
  onfocusout={() => {
    focused = false;
    start();
  }}
  onkeydown={(ev) => {
    if (ev.key === 'Escape') ondismiss();
  }}
>
  <span class="kind-icon"><Icon icon={ICONS[kind]} size={18} /></span>
  <div class="content">
    <p class="title">{title}</p>
    {#if description}<p class="desc">{description}</p>{/if}
    {#if actions.length}
      <div class="actions">
        {#each actions as action (action.label)}
          <button type="button" class="action" onclick={() => run(action)}>{action.label}</button>
        {/each}
      </div>
    {/if}
  </div>
  <button type="button" class="close" aria-label="Dismiss notification" onclick={ondismiss}>
    <X size={14} strokeWidth={2} aria-hidden="true" />
  </button>
</article>

<style>
  /* DESIGN.md §10 Toast: a glass card with the lg radius, a tone icon in its soft tint, 13px text, actions as
     small outlined buttons. Dense glass keeps the text at AA over any page or picture underneath. */
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    width: min(380px, calc(100vw - 24px));
    padding: 12px 10px 12px 12px;
    border-radius: var(--radius-lg);
    background: var(--glass-bg-dense);
    -webkit-backdrop-filter: var(--glass-filter);
    backdrop-filter: var(--glass-filter);
    border: 1px solid var(--glass-border);
    box-shadow: var(--glass-inset), var(--shadow-pop);
    color: var(--text);
    font-size: 0.9286rem; /* 13px */
  }

  .kind-icon {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    flex: none;
    border-radius: calc(var(--radius-sm) + 2px);
    background: var(--tone-soft);
    color: var(--tone);
  }

  .info {
    --tone: var(--slate);
    --tone-soft: var(--slate-soft, var(--selected));
  }
  .success {
    --tone: var(--success);
    --tone-soft: var(--success-soft);
  }
  .warning {
    --tone: var(--warning);
    --tone-soft: var(--warning-soft);
  }
  .error {
    --tone: var(--danger);
    --tone-soft: var(--danger-soft);
  }

  .content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 4px;
  }

  .title {
    font-weight: 600;
    line-height: 1.4;
  }

  .desc {
    font-size: var(--text-sm);
    color: var(--text-2);
    line-height: 1.45;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .action {
    position: relative;
    height: 28px;
    padding: 0 12px;
    border: 1px solid var(--hairline-strong);
    border-radius: calc(var(--radius-sm) + 2px);
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text);
    transition:
      background-color var(--t-1) var(--ease-out),
      border-color var(--t-1) var(--ease-out);
  }

  /* The first action is the one the toast offers (Undo, Reload…): it carries the accent. */
  .action:first-child {
    border-color: transparent;
    background: var(--accent);
    color: var(--accent-ink);
  }

  .action:hover {
    background: var(--hover);
    border-color: var(--field-border-hover);
  }

  .action:first-child:hover {
    background: var(--accent-strong);
    border-color: transparent;
  }

  .action:active {
    transform: scale(var(--press-scale));
  }

  .close {
    position: relative;
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    flex: none;
    border-radius: var(--radius-sm);
    color: var(--text-3);
    transition:
      background-color var(--t-1) var(--ease-out),
      color var(--t-1) var(--ease-out);
  }

  /* Invisible hit area up to --hit-min. */
  .close::after {
    content: '';
    position: absolute;
    inset: min(0px, calc((24px - var(--hit-min)) / 2));
  }

  .close:hover {
    color: var(--text);
    background: var(--hover);
  }
</style>
