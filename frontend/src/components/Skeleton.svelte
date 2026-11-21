<!--
  Loading placeholder. Use only where a load is genuinely slow (> 150 ms) — see `delay`, which keeps the skeleton
  invisible for fast loads so it never flashes.
-->
<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    width?: string;
    height?: string;
    /** Number of text lines (the last one is shorter). */
    lines?: number;
    circle?: boolean;
    radius?: string;
    /** Milliseconds before the skeleton becomes visible (default 150). */
    delay?: number;
    class?: string;
  }

  let { width = '100%', height = '1em', lines, circle = false, radius, delay = 150, class: className = '' }: Props = $props();

  let visible = $state(false);
  onMount(() => {
    if (delay <= 0) {
      visible = true;
      return;
    }
    const t = setTimeout(() => (visible = true), delay);
    return () => clearTimeout(t);
  });
</script>

{#if lines && lines > 1}
  <span class="lines {className}" class:visible aria-hidden="true" style:width>
    {#each { length: lines } as _, i (i)}
      <span class="skeleton" style:width={i === lines - 1 ? '62%' : '100%'} style:height></span>
    {/each}
  </span>
{:else}
  <span
    class="skeleton {className}"
    class:visible
    class:circle
    aria-hidden="true"
    style:width={circle ? height : width}
    style:height
    style:border-radius={radius}
  ></span>
{/if}

<style>
  .skeleton {
    display: block;
    border-radius: calc(var(--radius-sm) + 2px);
    background: linear-gradient(
      100deg,
      var(--skeleton-base) 30%,
      var(--skeleton-shine) 50%,
      var(--skeleton-base) 70%
    );
    background-size: 300% 100%;
    animation: shimmer calc(1.6s / max(var(--motion), 0.5)) linear infinite;
    opacity: 0;
    transition: opacity var(--t-2) var(--ease-out);
  }

  .visible,
  .visible .skeleton {
    opacity: 1;
  }

  .circle {
    border-radius: 50%;
  }

  .lines {
    display: flex;
    flex-direction: column;
    gap: 0.55em;
  }

  .lines .skeleton {
    transition: opacity var(--t-2) var(--ease-out);
  }

  @keyframes shimmer {
    from {
      background-position: 100% 0;
    }
    to {
      background-position: 0 0;
    }
  }

  :global(.motion-reduced) .skeleton,
  :global(.motion-none) .skeleton {
    animation: none;
  }
</style>
