/**
 * Built-in Home wallpapers (Settings → Appearance → Home background → Wallpaper; docs/DESIGN.md §2, §6).
 * `appearance.homeBackground.value` holds the wallpaper id when `kind` is 'wallpaper'; an unknown id shows the
 * default. Each wallpaper has a dark and a light rendering of the same scene, so Home matches the theme. The images
 * are original artwork generated for GNOME (public/brand-v2/README.txt) and ship with the app: nothing is fetched
 * from another host.
 */

export interface WallpaperImage {
  /** AVIF and WebP renderings of the same picture (2560×1440), served from the app origin. */
  avif: string;
  webp: string;
  /** The picture's average color, painted while it loads (no flash of the page background). */
  color: string;
  /** CSS object-position / background-position that keeps the scene's focal point in view on narrow screens. */
  position: string;
}

export interface Wallpaper {
  id: string;
  label: string;
  description: string;
  dark: WallpaperImage;
  light: WallpaperImage;
}

export const WALLPAPERS: Readonly<Record<string, Wallpaper>> = {
  grove: {
    id: 'grove',
    label: 'Grove',
    description: 'A moonlit spruce forest in the mist',
    dark: {
      avif: '/brand-v2/wallpaper/grove-dark.avif',
      webp: '/brand-v2/wallpaper/grove-dark.webp',
      color: '#0e1110',
      position: '50% 40%',
    },
    light: {
      avif: '/brand-v2/wallpaper/grove-light.avif',
      webp: '/brand-v2/wallpaper/grove-light.webp',
      color: '#d5dcd8',
      position: '50% 40%',
    },
  },
};

export const DEFAULT_WALLPAPER = 'grove';

/** The wallpaper for an id (the default for unknown ids). */
export function wallpaperById(id: string): Wallpaper {
  return WALLPAPERS[id] ?? (WALLPAPERS[DEFAULT_WALLPAPER] as Wallpaper);
}

/** CSS `background-image` for a rendering: AVIF where supported, WebP otherwise. */
export function wallpaperImageSet(image: WallpaperImage): string {
  return `image-set(url("${image.avif}") type("image/avif"), url("${image.webp}") type("image/webp"))`;
}
