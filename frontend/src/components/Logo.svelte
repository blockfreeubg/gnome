<!--
  The GNOME mark with an optional typographic wordmark (DESIGN.md §2).
  `variant="mono"` (default): the v2 monochrome mark, inline in `currentColor` (white on dark, ink on light; set
  `color` on the component to change it). `variant="color"`: the original colored cutout (About's "original logo").
  `size` is the rendered height of the mark in px.
-->
<script lang="ts">
  import { MARK_HEIGHT, MARK_PATH, MARK_VIEWBOX, MARK_WIDTH } from './logo-mark';

  interface Props {
    size?: number;
    wordmark?: boolean;
    /** Decorative marks get no accessible name (e.g. next to a visible "GNOME" heading). */
    decorative?: boolean;
    /** Eager-load (hero placements above the fold; only matters for the color raster). */
    priority?: boolean;
    variant?: 'mono' | 'color';
    class?: string;
  }

  let { size = 28, wordmark = false, decorative = false, priority = false, variant = 'mono', class: className = '' }: Props = $props();

  const width = $derived(Math.round((size * MARK_WIDTH) / MARK_HEIGHT));
  const hidden = $derived(decorative || wordmark);
</script>

<span class="logo {variant} {className}" style:--logo-h="{size}px">
  {#if variant === 'mono'}
    <svg
      class="mark"
      viewBox={MARK_VIEWBOX}
      {width}
      height={size}
      fill="currentColor"
      role={hidden ? undefined : 'img'}
      aria-label={hidden ? undefined : 'GNOME'}
      aria-hidden={hidden ? 'true' : undefined}
      focusable="false"
    >
      <path fill-rule="evenodd" d={MARK_PATH} />
    </svg>
  {:else}
    <picture>
      <source
        type="image/webp"
        srcset="/brand/gnome-mark-48.webp 37w, /brand/gnome-mark-96.webp 73w, /brand/gnome-mark-192.webp 147w, /brand/gnome-mark-384.webp 294w, /brand/gnome-mark.webp 382w"
        sizes="{width}px"
      />
      <img
        src="/brand/gnome-mark-96.png"
        srcset="/brand/gnome-mark-48.png 37w, /brand/gnome-mark-96.png 73w, /brand/gnome-mark-192.png 147w, /brand/gnome-mark-384.png 294w, /brand/gnome-mark.png 382w"
        sizes="{width}px"
        {width}
        height={size}
        alt={hidden ? '' : 'GNOME'}
        draggable="false"
        decoding="async"
        loading={priority ? 'eager' : 'lazy'}
        fetchpriority={priority ? 'high' : 'auto'}
      />
    </picture>
  {/if}
  {#if wordmark}
    <span class="wordmark">GNOME</span>
  {/if}
</span>

<style>
  .logo {
    display: inline-flex;
    align-items: flex-end;
    /* §2: the mark is ~1.5× the wordmark's cap height; gap 0.3× the wordmark size */
    gap: calc(var(--logo-h) * 0.27);
    color: var(--text);
    line-height: 1;
  }

  .mark,
  picture,
  img {
    display: block;
    flex: none;
    height: var(--logo-h);
    width: auto;
    user-select: none;
  }

  .mark {
    overflow: visible;
  }

  .wordmark {
    font-family: var(--font-display);
    font-weight: var(--weight-wordmark);
    letter-spacing: var(--tracking-wordmark);
    font-size: calc(var(--logo-h) * 0.92);
    line-height: 1;
    /* sit the baseline on the mark's foot */
    transform: translateY(0.13em);
  }

  .color .wordmark {
    font-size: calc(var(--logo-h) * 0.62);
    align-self: center;
    transform: translateY(0.04em);
  }

  @media (forced-colors: active) {
    .mark {
      color: CanvasText;
    }
  }
</style>
