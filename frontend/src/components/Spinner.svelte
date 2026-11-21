<!-- Indeterminate spinner. With `label` it is announced (role=status); otherwise decorative. -->
<script lang="ts">
  interface Props {
    size?: number;
    label?: string;
    class?: string;
  }

  let { size = 16, label, class: className = '' }: Props = $props();
</script>

<span class="spinner {className}" role={label ? 'status' : undefined} aria-hidden={label ? undefined : 'true'}>
  <svg viewBox="0 0 24 24" width={size} height={size} focusable="false">
    <circle class="track" cx="12" cy="12" r="9" fill="none" stroke-width="2.25" />
    <path class="arc" d="M21 12a9 9 0 0 0-9-9" fill="none" stroke-width="2.25" stroke-linecap="round" />
  </svg>
  {#if label}<span class="sr-only">{label}</span>{/if}
</span>

<style>
  .spinner {
    display: inline-flex;
    color: currentColor;
    flex: none;
  }

  svg {
    /* Slower, never stopped, when motion is reduced: the spinner is the only sign that work is going on. */
    animation: spin calc(0.8s / max(var(--motion, 1), 0.4)) linear infinite;
  }

  .track {
    stroke: currentColor;
    opacity: 0.18;
  }

  .arc {
    stroke: currentColor;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
