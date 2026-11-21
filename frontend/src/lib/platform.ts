/** Platform and capability detection. Every helper is safe to call outside a browser (tests, workers). */

const hasWindow = typeof window !== 'undefined';
const nav: (Navigator & { userAgentData?: { platform?: string; mobile?: boolean } }) | undefined =
  typeof navigator !== 'undefined' ? navigator : undefined;

function platformString(): string {
  return nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || '';
}

let applePlatformOverride: boolean | null = null;

/** macOS, iOS and iPadOS: ⌘ is the primary modifier and ⌥ produces special characters. */
export function isApplePlatform(): boolean {
  if (applePlatformOverride !== null) return applePlatformOverride;
  return /mac|iphone|ipad|ipod/i.test(platformString());
}

/** Test hook: force the Apple keyboard conventions on or off (null restores detection). */
export function setApplePlatformOverride(value: boolean | null): void {
  applePlatformOverride = value;
}

export function isIOS(): boolean {
  const p = platformString();
  // iPadOS 13+ reports "MacIntel" but has touch.
  return /iphone|ipad|ipod/i.test(p) || (/mac/i.test(p) && (nav?.maxTouchPoints ?? 0) > 1);
}

export function isAndroid(): boolean {
  return /android/i.test(nav?.userAgent ?? '');
}

export function isMobileUA(): boolean {
  return nav?.userAgentData?.mobile ?? (isIOS() || isAndroid());
}

export function matches(query: string): boolean {
  return hasWindow && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

export const isCoarsePointer = (): boolean => matches('(pointer: coarse)');
export const prefersReducedMotion = (): boolean => matches('(prefers-reduced-motion: reduce)');
export const prefersLight = (): boolean => matches('(prefers-color-scheme: light)');
export const prefersReducedTransparency = (): boolean => matches('(prefers-reduced-transparency: reduce)');

/** Running as an installed web app window (display-mode standalone / window-controls-overlay). */
export function isStandalone(): boolean {
  return (
    matches('(display-mode: standalone)') ||
    matches('(display-mode: window-controls-overlay)') ||
    (nav as (Navigator & { standalone?: boolean }) | undefined)?.standalone === true
  );
}

export function supportsViewTransitions(): boolean {
  return typeof document !== 'undefined' && typeof document.startViewTransition === 'function';
}

export function supportsPopover(): boolean {
  return typeof HTMLElement !== 'undefined' && Object.prototype.hasOwnProperty.call(HTMLElement.prototype, 'popover');
}

export function supportsBackdropFilter(): boolean {
  return (
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    (CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)'))
  );
}

export function supportsIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

/** Human label for the primary modifier ("⌘" on Apple platforms, "Ctrl" elsewhere). */
export function modKeyLabel(): string {
  return isApplePlatform() ? '⌘' : 'Ctrl';
}

/** requestIdleCallback with a timeout fallback (Safari). Returns a cancel function. */
export function onIdle(fn: () => void, timeout = 2000): () => void {
  if (hasWindow && typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(fn, { timeout });
    return () => window.cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 200);
  return () => clearTimeout(id);
}
