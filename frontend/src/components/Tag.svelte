<!-- Static label (category, state). For interactive filters use Chip. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { LucideIcon } from '@lucide/svelte';
  import Icon from './Icon.svelte';

  interface Props {
    tone?: 'neutral' | 'accent' | 'moss' | 'slate' | 'success' | 'warning' | 'danger';
    icon?: LucideIcon;
    mono?: boolean;
    class?: string;
    children: Snippet;
  }

  let { tone = 'neutral', icon, mono = false, class: className = '', children }: Props = $props();
</script>

<span class="tag {tone} {className}" class:mono>
  {#if icon}<Icon {icon} size={12} />{/if}
  {@render children()}
</span>

<style>
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 8px;
    border-radius: var(--radius-pill);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.01em;
    white-space: nowrap;
    color: var(--tone);
    background: var(--tone-soft);
  }

  .mono {
    font-family: var(--font-mono);
    font-weight: 500;
    letter-spacing: 0;
  }

  .neutral {
    --tone: var(--text-2);
    --tone-soft: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--hairline-strong);
  }
  .accent {
    /* --accent-strong: the accent itself drops under 4.5:1 on its own tint in the light theme */
    --tone: var(--accent-strong);
    --tone-soft: var(--accent-soft);
  }
  .moss {
    --tone: var(--moss);
    --tone-soft: var(--moss-soft);
  }
  .slate {
    --tone: var(--slate);
    --tone-soft: var(--slate-soft);
  }
  .success {
    --tone: var(--success);
    --tone-soft: var(--success-soft);
  }
  .warning {
    --tone: var(--warning);
    --tone-soft: var(--warning-soft);
  }
  .danger {
    --tone: var(--danger);
    --tone-soft: var(--danger-soft);
  }
</style>
