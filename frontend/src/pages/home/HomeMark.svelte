<!--
  The monochrome GNOME mark (public/brand-v2/gnome-mark-mono.svg) drawn in the current text color through a CSS mask,
  so it is white on the dark theme and ink on the light one. Decorative: Home shows the word "GNOME" next to it.
-->
<script lang="ts">
  interface Props {
    /** Rendered height in px (the mark is 382 × 499). */
    size?: number;
    class?: string;
  }

  let { size = 52, class: className = '' }: Props = $props();
</script>

<span class="mark {className}" style:--mark-h="{size}px" aria-hidden="true"></span>

<style>
  .mark {
    display: block;
    flex: none;
    height: var(--mark-h);
    width: calc(var(--mark-h) * 382 / 499);
    background-color: currentColor;
    -webkit-mask: url('/brand-v2/gnome-mark-mono.svg') center / contain no-repeat;
    mask: url('/brand-v2/gnome-mark-mono.svg') center / contain no-repeat;
  }

  /* Forced colors drop background colors: show the mark in the system text color instead of an empty box. */
  @media (forced-colors: active) {
    .mark {
      background-color: CanvasText;
      forced-color-adjust: none;
    }
  }
</style>
