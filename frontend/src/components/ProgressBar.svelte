<!-- Determinate (value/max) or indeterminate (no value) progress bar. Always give it a label. -->
<script lang="ts">
  interface Props {
    value?: number | null;
    max?: number;
    label: string;
    /** Visible value text (e.g. "12 MB of 40 MB"); also used as aria-valuetext. */
    valueText?: string;
    size?: 'xs' | 'sm' | 'md';
    tone?: 'accent' | 'moss' | 'danger';
    class?: string;
  }

  let { value = null, max = 1, label, valueText, size = 'sm', tone = 'accent', class: className = '' }: Props = $props();

  const indeterminate = $derived(value === null || value === undefined || !Number.isFinite(value));
  const pct = $derived(indeterminate ? 0 : Math.min(100, Math.max(0, ((value as number) / (max || 1)) * 100)));
</script>

<div
  class="progress {size} {tone} {className}"
  class:indeterminate
  role="progressbar"
  aria-label={label}
  aria-valuemin={indeterminate ? undefined : 0}
  aria-valuemax={indeterminate ? undefined : max}
  aria-valuenow={indeterminate ? undefined : value}
  aria-valuetext={valueText}
>
  <span class="fill" style:width={indeterminate ? undefined : `${pct}%`}></span>
</div>

<style>
  .progress {
    position: relative;
    width: 100%;
    overflow: hidden;
    border-radius: var(--radius-pill);
    background: var(--selected);
  }

  .xs {
    height: 2px;
  }
  .sm {
    height: 4px;
  }
  .md {
    height: 6px;
  }

  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: inherit;
    background: var(--tone);
    transition: width var(--t-3) var(--ease-out);
  }

  .indeterminate .fill {
    width: 40%;
    background: linear-gradient(90deg, transparent, var(--tone) 35%, var(--tone) 65%, transparent);
    animation: travel calc(1.25s / max(var(--motion), 0.5)) var(--ease-in-out) infinite;
  }

  @keyframes travel {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(250%);
    }
  }

  .accent {
    --tone: var(--accent);
  }
  .moss {
    --tone: var(--moss);
  }
  .danger {
    --tone: var(--danger);
  }
</style>
