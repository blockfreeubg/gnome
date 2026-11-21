/**
 * JS motion helpers for Svelte transitions. Durations follow the --dur-n tokens multiplied by the user's motion
 * setting (none 0 · reduced 0.5 · normal 1 · expressive 1.25); "reduced" and "none" never translate or scale
 * (fades only), matching the CSS --motion / --motion-move variables.
 */
import type { TransitionConfig } from 'svelte/transition';
import { getMotionScale, motionAllowsMovement } from '../settings/apply';

export const DUR = { 1: 90, 2: 160, 3: 240, 4: 360 } as const;

/** Cubic-bezier easing (same curves as the CSS tokens). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number): number => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;
  const solveT = (x: number): number => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return t;
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 20; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (x > v) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (t) => (t <= 0 ? 0 : t >= 1 ? 1 : sampleY(solveT(t)));
}

export const easeOut = cubicBezier(0.2, 0.8, 0.2, 1);
export const easeInOut = cubicBezier(0.65, 0, 0.35, 1);
export const easeSpring = cubicBezier(0.34, 1.36, 0.64, 1);

/** Scales a token duration by the motion setting. */
export function dur(ms: number): number {
  return Math.round(ms * getMotionScale());
}

export function canMove(): boolean {
  return motionAllowsMovement();
}

interface Base {
  duration?: number;
  delay?: number;
  easing?: (t: number) => number;
}

/** Opacity only. */
export function fade(_node: Element, { duration = DUR[2], delay = 0, easing = easeOut }: Base = {}): TransitionConfig {
  return { duration: dur(duration), delay: dur(delay), easing, css: (t) => `opacity: ${t}` };
}

/** Fade + small rise (route content, toasts, list items). */
export function fadeRise(
  _node: Element,
  { duration = DUR[3], delay = 0, easing = easeOut, y = 6 }: Base & { y?: number } = {},
): TransitionConfig {
  const move = canMove() ? y : 0;
  return {
    duration: dur(duration),
    delay: dur(delay),
    easing,
    css: (t, u) => `opacity: ${t}; transform: translateY(${(u * move).toFixed(2)}px)`,
  };
}

/** Menus and popovers grow from their trigger: fade + slight scale from a transform origin. */
export function popIn(
  node: Element,
  { duration = DUR[2], delay = 0, easing = easeOut, scale = 0.97, origin }: Base & { scale?: number; origin?: string } = {},
): TransitionConfig {
  if (origin && node instanceof HTMLElement) node.style.transformOrigin = origin;
  const s = canMove() ? scale : 1;
  return {
    duration: dur(duration),
    delay: dur(delay),
    easing,
    css: (t) => `opacity: ${t}; transform: scale(${(s + (1 - s) * t).toFixed(4)})`,
  };
}

export type Edge = 'left' | 'right' | 'top' | 'bottom';

/** Sheets slide from their edge (fade only when movement is disabled). */
export function slideFrom(
  _node: Element,
  { duration = DUR[4], delay = 0, easing = easeOut, edge = 'right', distance = '100%' }: Base & { edge?: Edge; distance?: string } = {},
): TransitionConfig {
  const axis = edge === 'left' || edge === 'right' ? 'X' : 'Y';
  const sign = edge === 'left' || edge === 'top' ? '-' : '';
  if (!canMove()) return fade(_node, { duration: Math.min(duration, DUR[2]), delay, easing });
  return {
    duration: dur(duration),
    delay: dur(delay),
    easing,
    css: (_t, u) => `transform: translate${axis}(calc(${sign}${distance} * ${u.toFixed(4)}))`,
  };
}

/** Plays a WAAPI animation respecting the motion setting; resolves when finished (immediately for "none"). */
export function animate(el: Element, keyframes: Keyframe[], ms: number, easing = 'cubic-bezier(.2,.8,.2,1)'): Promise<void> {
  const d = dur(ms);
  if (d <= 0 || typeof el.animate !== 'function') return Promise.resolve();
  const a = el.animate(keyframes, { duration: d, easing, fill: 'none' });
  return a.finished.then(
    () => undefined,
    () => undefined,
  );
}
