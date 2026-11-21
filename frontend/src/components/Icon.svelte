<!--
  Lucide icon with GNOME defaults (stroke 1.75, currentColor). Decorative unless `label` is given.
  Usage: <Icon icon={House} /> · <Icon icon={Shield} size={20} label="Protected" />
-->
<script lang="ts">
  import type { LucideIcon } from '@lucide/svelte';

  interface Props {
    icon: LucideIcon;
    size?: number;
    strokeWidth?: number;
    /** Accessible name; omit for decorative icons. */
    label?: string;
    class?: string;
  }

  let { icon: Glyph, size = 18, strokeWidth = 1.75, label, class: className = '' }: Props = $props();
</script>

<Glyph
  {size}
  {strokeWidth}
  class={`gnome-icon ${className}`.trim()}
  aria-hidden={label ? undefined : 'true'}
  role={label ? 'img' : undefined}
  aria-label={label}
  focusable="false"
/>

<style>
  :global(.gnome-icon) {
    flex: none;
    display: block;
  }
</style>
