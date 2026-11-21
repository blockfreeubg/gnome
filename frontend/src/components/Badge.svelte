<!-- Small count or status dot. Counts above `max` show "99+". Provide `label` for the accessible meaning. -->
<script lang="ts">
  interface Props {
    count?: number;
    dot?: boolean;
    max?: number;
    tone?: 'accent' | 'neutral' | 'moss' | 'slate' | 'success' | 'warning' | 'danger';
    /** Accessible description, e.g. "3 downloads in progress". */
    label?: string;
    pulse?: boolean;
    class?: string;
  }

  let { count, dot = false, max = 99, tone = 'accent', label, pulse = false, class: className = '' }: Props = $props();

  const text = $derived(count === undefined ? '' : count > max ? `${max}+` : String(count));
</script>

<!-- aria-label is not allowed on a plain <span>: a labelled dot is an image, a labelled count carries hidden text. -->
{#if dot}
  <span class="dot {tone} {className}" class:pulse role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : 'true'}></span>
{:else if count !== undefined && count > 0}
  <span class="badge {tone} {className}" title={label}>
    {#if label}<span aria-hidden="true">{text}</span><span class="sr-only">{label}</span>{:else}{text}{/if}
  </span>
{/if}

<style>
  .badge {
    position: relative;
    display: inline-grid;
    place-items: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: var(--radius-pill);
    font-size: var(--text-xs);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    background: var(--tone-soft);
    color: var(--tone);
  }

  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--tone);
    box-shadow: 0 0 0 3px var(--tone-soft);
    flex: none;
  }

  .pulse {
    animation: pulse calc(1.8s / max(var(--motion), 0.5)) var(--ease-in-out) infinite;
  }

  /* Reduced motion keeps fades only: the expanding ring is decorative (the dot's color already carries the state). */
  :global(.motion-reduced) .pulse {
    animation: none;
  }

  @keyframes pulse {
    50% {
      box-shadow: 0 0 0 5px transparent;
    }
  }

  .accent {
    --tone: var(--accent);
    --tone-soft: var(--accent-soft);
  }

  /* Accent counts are solid (DESIGN.md §10): ink on the accent fill. */
  .badge.accent {
    background: var(--accent);
    color: var(--accent-ink);
  }

  .neutral {
    --tone: var(--text-2);
    --tone-soft: var(--hover);
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
