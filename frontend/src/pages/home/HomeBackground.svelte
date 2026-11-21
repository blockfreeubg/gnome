<!--
  Home backdrop: the built-in wallpaper (default; its dark or light rendering follows the theme), the accent glow, or
  the user's color / gradient / image with dim and blur.
-->
<script lang="ts">
  import { kvGet } from '../../lib/idb';
  import { appearance } from '../../settings/appearance.svelte';
  import { cssUrl, resolveBackground, type HomeBackground } from './background';

  interface Props {
    background: HomeBackground;
  }

  let { background }: Props = $props();

  const bg = $derived(resolveBackground(background));
  const wallpaper = $derived(bg.kind === 'wallpaper' && bg.wallpaper ? bg.wallpaper[appearance.theme] : null);
  let objectUrl = $state<string | null>(null);

  // Images stored in IndexedDB become object URLs (revoked when replaced or unmounted).
  $effect(() => {
    const img = bg.image;
    if (!img || img.kind !== 'idb') return;
    let url: string | null = null;
    let cancelled = false;
    void kvGet<Blob>(img.key)
      .then((blob) => {
        if (cancelled || !(blob instanceof Blob)) return;
        url = URL.createObjectURL(blob);
        objectUrl = url;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      objectUrl = null;
    };
  });

  const imageCss = $derived(
    bg.kind === 'image' && bg.image ? (bg.image.kind === 'url' ? cssUrl(bg.image.url) : objectUrl ? cssUrl(objectUrl) : undefined) : undefined,
  );
</script>

<div class="backdrop {bg.kind}" aria-hidden="true">
  {#if wallpaper}
    <picture class="bg-layer" style:background-color={wallpaper.color}>
      <source type="image/avif" srcset={wallpaper.avif} />
      <img src={wallpaper.webp} alt="" decoding="async" fetchpriority="high" draggable="false" style:object-position={wallpaper.position} />
    </picture>
  {:else if bg.kind === 'color' || bg.kind === 'gradient' || bg.kind === 'image'}
    <div
      class="bg-layer"
      style:background-color={bg.kind === 'color' ? bg.color : undefined}
      style:background-image={bg.kind === 'gradient' ? bg.gradient : imageCss}
      style:filter={bg.blur ? `blur(${bg.blur}px)` : undefined}
      style:transform={bg.blur ? 'scale(1.06)' : undefined}
    ></div>
    <div class="dim" style:opacity={bg.dim}></div>
  {/if}
</div>

<style>
  .backdrop {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    z-index: 0;
  }

  .glow {
    background:
      radial-gradient(ellipse 58% 46% at 50% -6%, color-mix(in oklab, var(--accent) 10%, transparent), transparent 72%),
      radial-gradient(ellipse 40% 34% at 12% 88%, color-mix(in oklab, var(--moss) 5%, transparent), transparent 70%),
      radial-gradient(ellipse 36% 30% at 92% 70%, color-mix(in oklab, var(--slate) 4%, transparent), transparent 70%);
  }

  /* On the light page the secondary tints read as stains: only the top glow remains. */
  :global(.theme-light) .glow {
    background: radial-gradient(ellipse 58% 46% at 50% -6%, color-mix(in oklab, var(--accent) 12%, transparent), transparent 72%);
  }

  .bg-layer {
    position: absolute;
    inset: 0;
    background-size: cover;
    background-position: center;
  }

  picture.bg-layer img {
    width: 100%;
    height: 100%;
    max-width: none;
    object-fit: cover;
    user-select: none;
  }

  .dim {
    position: absolute;
    inset: 0;
    background: var(--bg);
  }
</style>
