<!-- A quiet one-line notice above a library list (history off, storage unavailable, …) with an optional action. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { LucideIcon } from '@lucide/svelte';

  interface Props {
    icon: LucideIcon;
    tone?: 'neutral' | 'warning' | 'danger';
    title: string;
    children?: Snippet;
    actions?: Snippet;
  }

  let { icon: Icon, tone = 'neutral', title, children, actions }: Props = $props();
</script>

<div class="notice {tone}" role={tone === 'neutral' ? 'status' : 'alert'}>
  <span class="icon"><Icon size={16} strokeWidth={1.75} aria-hidden="true" /></span>
  <div class="text">
    <p class="title">{title}</p>
    {#if children}<p class="body">{@render children()}</p>{/if}
  </div>
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</div>

<style>
  .notice {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-lg);
    background: var(--glass-bg-card);
    box-shadow: var(--glass-inset);
  }

  .notice.warning {
    border-color: color-mix(in oklab, var(--warning) 40%, var(--hairline));
    background: color-mix(in oklab, var(--warning) 8%, var(--surface-1));
  }

  .notice.danger {
    border-color: color-mix(in oklab, var(--danger) 40%, var(--hairline));
    background: color-mix(in oklab, var(--danger) 8%, var(--surface-1));
  }

  /* 30px icon tile, as in settings rows (DESIGN.md §10 SettingRow). */
  .icon {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: var(--radius);
    background: var(--selected);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
    color: var(--text);
    flex: none;
  }

  .warning .icon {
    color: var(--warning);
    background: var(--warning-soft);
    box-shadow: none;
  }

  .danger .icon {
    color: var(--danger);
    background: var(--danger-soft);
    box-shadow: none;
  }

  .text {
    flex: 1;
    min-width: 0;
  }

  .title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }

  .body {
    margin: 2px 0 0;
    font-size: var(--text-sm);
    color: var(--text-3);
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    flex: none;
  }

  @media (max-width: 759px) {
    .notice {
      flex-wrap: wrap;
    }

    .actions {
      width: 100%;
      justify-content: flex-end;
    }
  }
</style>
