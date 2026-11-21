<!-- Calm empty state with the GNOME mark (or an icon), a display-face title, one honest sentence and actions. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { LucideIcon } from '@lucide/svelte';
  import Icon from './Icon.svelte';
  import Logo from './Logo.svelte';

  interface Props {
    title: string;
    description?: string;
    /** Show an icon instead of the mark. */
    icon?: LucideIcon;
    mark?: boolean;
    size?: 'sm' | 'md';
    align?: 'center' | 'start';
    headingLevel?: 2 | 3;
    actions?: Snippet;
    children?: Snippet;
    class?: string;
  }

  let {
    title,
    description,
    icon,
    mark = true,
    size = 'md',
    align = 'center',
    headingLevel = 2,
    actions,
    children,
    class: className = '',
  }: Props = $props();
</script>

<section class="empty {size} {align} {className}" aria-label={title}>
  {#if icon}
    <span class="icon-wrap"><Icon {icon} size={size === 'sm' ? 20 : 24} /></span>
  {:else if mark}
    <span class="mark-wrap"><Logo size={size === 'sm' ? 36 : 48} decorative /></span>
  {/if}
  <svelte:element this={headingLevel === 2 ? 'h2' : 'h3'} class="title">{title}</svelte:element>
  {#if description}<p class="desc">{description}</p>{/if}
  {#if children}<div class="extra">{@render children()}</div>{/if}
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</section>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-12) var(--space-6);
  }

  .center {
    align-items: center;
    text-align: center;
  }

  .start {
    align-items: flex-start;
    text-align: left;
  }

  .sm {
    padding: var(--space-8) var(--space-4);
    gap: var(--space-2);
  }

  /* DESIGN.md §10 EmptyState: the mono mark, quiet (--text-3 at 60%), never the accent. */
  .mark-wrap {
    display: grid;
    place-items: center;
    margin-bottom: var(--space-2);
    opacity: 0.6;
  }

  .mark-wrap :global(.logo) {
    color: var(--text-3);
  }

  .icon-wrap {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    margin-bottom: var(--space-2);
    border-radius: var(--radius-lg);
    background: var(--selected);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
    color: var(--text-2);
  }

  .sm .icon-wrap {
    width: 40px;
    height: 40px;
    border-radius: var(--radius);
  }

  .title {
    font-family: var(--font-display);
    font-variation-settings: var(--display-variation);
    font-weight: var(--weight-heading, 700);
    font-size: 1.2857rem; /* 18px */
    letter-spacing: var(--tracking-display);
    line-height: var(--lh-display);
    color: var(--text);
  }

  .sm .title {
    font-size: var(--text-lg);
  }

  .desc {
    max-width: 46ch;
    font-size: 0.9286rem; /* 13px */
    color: var(--text-3);
    line-height: 1.55;
  }

  .extra {
    width: 100%;
    max-width: 520px;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }

  .center .actions {
    justify-content: center;
  }
</style>
