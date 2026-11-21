/** Home background (Settings → Appearance → Home background): validation and CSS for each kind. */
import type { Settings } from '../../settings/schema';
import { parseHex } from '../../settings/color';
import { wallpaperById, type Wallpaper } from '../../styles/wallpapers';

export type HomeBackground = Settings['appearance']['homeBackground'];

const GRADIENT_RE = /^(?:repeating-)?(?:linear|radial|conic)-gradient\([^;{}<>]*\)$/i;

/** Accepts CSS gradients only (no url(), no extra declarations). */
export function isSafeGradient(value: string): boolean {
  return GRADIENT_RE.test(value.trim()) && !/url\s*\(|expression|image-set|var\s*\(/i.test(value);
}

/** https: image URLs, or an image stored in IndexedDB (`idb:<kv key>`). */
export function imageSource(value: string): { kind: 'url'; url: string } | { kind: 'idb'; key: string } | null {
  const v = value.trim();
  if (v.startsWith('idb:') && v.length > 4 && v.length < 200) return { kind: 'idb', key: v.slice(4) };
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? { kind: 'url', url: u.href } : null;
  } catch {
    return null;
  }
}

/** Quotes a URL for use inside CSS url(). */
export function cssUrl(url: string): string {
  return `url("${url.replace(/["\\\n\r]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}")`;
}

export interface ResolvedBackground {
  kind: HomeBackground['kind'];
  /** The built-in wallpaper (kind 'wallpaper'; also the fallback for invalid values). */
  wallpaper?: Wallpaper;
  color?: string;
  gradient?: string;
  image?: { kind: 'url'; url: string } | { kind: 'idb'; key: string };
  dim: number;
  blur: number;
}

/** Normalizes the setting; invalid values fall back to the default wallpaper (an unknown wallpaper id too). */
export function resolveBackground(bg: HomeBackground): ResolvedBackground {
  const base = { dim: Math.min(0.9, Math.max(0, bg.dim)), blur: Math.min(40, Math.max(0, bg.blur)) };
  const fallback = (): ResolvedBackground => ({ kind: 'wallpaper', wallpaper: wallpaperById(''), ...base });
  switch (bg.kind) {
    case 'wallpaper':
      return { kind: 'wallpaper', wallpaper: wallpaperById(bg.value.trim()), ...base };
    case 'glow':
      return { kind: 'glow', ...base };
    case 'none':
      return { kind: 'none', ...base };
    case 'color':
      return parseHex(bg.value) ? { kind: 'color', color: bg.value.trim(), ...base } : fallback();
    case 'gradient':
      return isSafeGradient(bg.value) ? { kind: 'gradient', gradient: bg.value.trim(), ...base } : fallback();
    case 'image': {
      const image = imageSource(bg.value);
      return image ? { kind: 'image', image, ...base } : fallback();
    }
    default:
      return fallback();
  }
}
