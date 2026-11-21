<!--
  The GNOME mark as an icon-sized glyph with Lucide's props (size, class, aria attributes), so it can stand in for an
  icon wherever a LucideIcon is expected — the address bar's site icon for gnome:// pages.
-->
<script lang="ts">
  import type { LucideProps } from '@lucide/svelte';
  import { MARK_HEIGHT, MARK_PATH, MARK_VIEWBOX, MARK_WIDTH } from '../../components/logo-mark';

  let { size = 16, strokeWidth: _strokeWidth, color: _color, children: _children, title: _title, absoluteStrokeWidth: _a, nonScalingStroke: _n, ...rest }: LucideProps = $props();
  const h = $derived(Number(size));
</script>

<svg {...rest} viewBox={MARK_VIEWBOX} width={Math.round((h * MARK_WIDTH) / MARK_HEIGHT)} height={h} fill="currentColor">
  <path fill-rule="evenodd" d={MARK_PATH} />
</svg>
