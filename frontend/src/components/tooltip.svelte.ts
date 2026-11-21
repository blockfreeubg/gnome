/**
 * Tooltips: one shared floating element (rendered by <Tooltip /> in the app shell) driven by an attachment.
 *
 *   <button aria-label="Settings" {@attach tooltip({ text: 'Settings', action: 'openSettings' })}>…</button>
 *
 * Hover shows after a delay (instant while "warm" — moving between triggers), keyboard focus shows immediately.
 * WCAG 1.4.13: Escape hides it from anywhere (dismissible) and the pointer can move from the trigger onto the
 * tooltip without it disappearing (hoverable). Touch input never shows tooltips. Tooltips only repeat a control's
 * visible or aria-label name; pass `describe: true` when the text adds information so it is wired up with
 * aria-describedby.
 */
import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { ShortcutAction } from '../settings/schema';
import type { Placement } from './floating';

export interface TooltipOptions {
  text: string;
  /** Combo string to show as key caps. */
  shortcut?: string;
  /** Show the user's binding for this action. */
  action?: ShortcutAction;
  placement?: Placement;
  /** Hover delay in ms (default 450). */
  delay?: number;
  /** Adds aria-describedby while visible (when the tooltip is not just the accessible name). */
  describe?: boolean;
  disabled?: boolean;
}

export const TOOLTIP_ID = 'gnome-tooltip';

export const tooltipState = $state<{
  visible: boolean;
  text: string;
  shortcut: string | undefined;
  action: ShortcutAction | undefined;
  placement: Placement;
  anchor: HTMLElement | null;
}>({ visible: false, text: '', shortcut: undefined, action: undefined, placement: 'top', anchor: null });

let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let warmUntil = 0;
const WARM_MS = 400;
/** Time the pointer has to travel from the trigger onto the tooltip. */
const HOVER_GRACE_MS = 120;

function clearTimer(): void {
  if (showTimer) clearTimeout(showTimer);
  showTimer = null;
  cancelHide();
}

function cancelHide(): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
}

/** The pointer entered the tooltip itself: keep it open (called by <Tooltip />). */
export function keepTooltip(): void {
  cancelHide();
}

/** The pointer left the tooltip: hide it unless it moved back onto the trigger (called by <Tooltip />). */
export function releaseTooltip(): void {
  cancelHide();
  hideTimer = setTimeout(() => hideTooltip(), HOVER_GRACE_MS);
}

function show(node: HTMLElement, o: TooltipOptions): void {
  clearTimer();
  tooltipState.text = o.text;
  tooltipState.shortcut = o.shortcut;
  tooltipState.action = o.action;
  tooltipState.placement = o.placement ?? 'top';
  tooltipState.anchor = node;
  tooltipState.visible = true;
  if (o.describe) node.setAttribute('aria-describedby', TOOLTIP_ID);
}

export function hideTooltip(node?: HTMLElement): void {
  clearTimer();
  if (node && tooltipState.anchor !== node) return;
  if (tooltipState.visible) warmUntil = performance.now() + WARM_MS;
  const anchor = tooltipState.anchor;
  if (anchor?.getAttribute('aria-describedby') === TOOLTIP_ID) anchor.removeAttribute('aria-describedby');
  tooltipState.visible = false;
  tooltipState.anchor = null;
}

export function tooltip(input: string | TooltipOptions): Attachment<HTMLElement> {
  return (node) => {
    const o: TooltipOptions = typeof input === 'string' ? { text: input } : input;
    if (o.disabled || !o.text) return;

    const onEnter = (ev: PointerEvent): void => {
      if (ev.pointerType === 'touch') return;
      clearTimer();
      const warm = performance.now() < warmUntil || tooltipState.visible;
      if (warm) show(node, o);
      else showTimer = setTimeout(() => show(node, o), o.delay ?? 450);
    };
    const onLeave = (): void => hideTooltip(node);
    // Leaving the trigger: a grace period lets the pointer reach the tooltip (hoverable); a pending show is dropped.
    const onPointerLeave = (): void => {
      if (showTimer) clearTimeout(showTimer);
      showTimer = null;
      if (tooltipState.anchor !== node || !tooltipState.visible) return;
      cancelHide();
      hideTimer = setTimeout(() => hideTooltip(node), HOVER_GRACE_MS);
    };
    const onFocus = (): void => {
      if (node.matches(':focus-visible')) show(node, o);
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape' && tooltipState.anchor === node) hideTooltip(node);
    };
    const onDown = (): void => hideTooltip(node);

    node.addEventListener('pointerenter', onEnter);
    node.addEventListener('pointerleave', onPointerLeave);
    node.addEventListener('focus', onFocus);
    node.addEventListener('blur', onLeave);
    node.addEventListener('keydown', onKey);
    node.addEventListener('pointerdown', onDown);

    // Keep the visible tooltip in sync when options change for the hovered node.
    untrack(() => {
      if (tooltipState.anchor === node && tooltipState.visible) show(node, o);
    });

    return () => {
      node.removeEventListener('pointerenter', onEnter);
      node.removeEventListener('pointerleave', onPointerLeave);
      node.removeEventListener('focus', onFocus);
      node.removeEventListener('blur', onLeave);
      node.removeEventListener('keydown', onKey);
      node.removeEventListener('pointerdown', onDown);
      untrack(() => {
        if (tooltipState.anchor === node) hideTooltip(node);
      });
    };
  };
}
