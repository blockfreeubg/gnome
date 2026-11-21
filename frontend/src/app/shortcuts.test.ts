import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeCombo, parseCombo, sameCombo, isTextEditingCombo, type KeyEventLike } from '../lib/keys';
import { setApplePlatformOverride } from '../lib/platform';
import { DEFAULT_SHORTCUTS, RESERVED_COMBOS } from '../settings/defaults';
import { SHORTCUT_ACTIONS } from '../settings/schema';
import { settings } from '../settings/store.svelte';
import {
  actionForEvent,
  bindingFor,
  conflictsFor,
  dispatch,
  dispatchForwardedShortcut,
  hasHandler,
  isPrivilegedForwarded,
  onForwardedShortcut,
  ORDINARY_FORWARDED,
  resetForwardedBudget,
  isReservedCombo,
  recordCombo,
  register,
  SHORTCUT_LABELS,
  shortcutCaps,
} from './shortcuts';

vi.mock('../lib/idb', () => ({
  idbGet: vi.fn(async () => undefined),
  idbPut: vi.fn(async () => 'current'),
}));

function key(k: string, mods: Partial<KeyEventLike> = {}, code?: string): KeyEventLike {
  return { key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...(code ? { code } : {}), ...mods };
}

const offs: Array<() => void> = [];
function reg(...args: Parameters<typeof register>): () => void {
  const off = register(...args);
  offs.push(off);
  return off;
}

beforeEach(() => {
  setApplePlatformOverride(false);
  settings.reset();
});

afterEach(() => {
  for (const off of offs.splice(0)) off();
  setApplePlatformOverride(null);
});

describe('default shortcuts', () => {
  it('bind every action to a valid, canonical combo', () => {
    for (const action of SHORTCUT_ACTIONS) {
      const combo = DEFAULT_SHORTCUTS[action];
      expect(parseCombo(combo), action).not.toBeNull();
      expect(normalizeCombo(combo), action).toBe(combo);
      expect(SHORTCUT_LABELS[action], action).toBeTruthy();
    }
  });

  it('are capturable by a web page: none is reserved by browsers', () => {
    for (const apple of [false, true]) {
      for (const action of SHORTCUT_ACTIONS) {
        const combo = DEFAULT_SHORTCUTS[action];
        expect(RESERVED_COMBOS.some((r) => sameCombo(r, combo, apple)), `${action} ${combo} apple=${apple}`).toBe(false);
      }
    }
  });

  it('do not collide with each other', () => {
    for (const apple of [false, true]) {
      const seen = new Map<string, string>();
      for (const action of SHORTCUT_ACTIONS) {
        const combo = DEFAULT_SHORTCUTS[action];
        for (const [other, otherCombo] of seen) {
          expect(sameCombo(combo, otherCombo, apple), `${action} vs ${other}`).toBe(false);
        }
        seen.set(action, combo);
      }
    }
  });

  it('only back/forward/home double as text-editing keys (they are skipped inside text fields)', () => {
    for (const apple of [false, true]) {
      const editing = SHORTCUT_ACTIONS.filter((a) => isTextEditingCombo(DEFAULT_SHORTCUTS[a], apple));
      expect(editing).toEqual(['back', 'forward', 'home']);
    }
  });

  it('reserved combos include the tab/window keys browsers keep', () => {
    for (const c of ['Ctrl+T', 'Ctrl+W', 'Ctrl+N', 'Ctrl+Shift+N', 'Ctrl+Tab', 'Meta+T', 'Meta+W']) {
      expect(isReservedCombo(c), c).toBe(true);
    }
    expect(isReservedCombo('Alt+T')).toBe(false);
  });
});

describe('dispatch', () => {
  it('runs the handler bound to the pressed combo and reports consumption', () => {
    const fn = vi.fn();
    reg('newTab', fn);
    expect(hasHandler('newTab')).toBe(true);
    expect(dispatch(key('t', { altKey: true }, 'KeyT'))).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(dispatch(key('t', { ctrlKey: true }, 'KeyT'))).toBe(false); // Ctrl+T is not bound
  });

  it('accepts plain objects forwarded from proxied frames', () => {
    const fn = vi.fn();
    reg('commandPalette', fn);
    const forwarded = JSON.parse(JSON.stringify(key('k', { ctrlKey: true }, 'KeyK'))) as KeyEventLike;
    expect(dispatch(forwarded)).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('gives the latest registration precedence, and lets handlers decline', () => {
    const calls: string[] = [];
    reg('reload', () => {
      calls.push('shell');
    });
    const offTab = reg('reload', () => {
      calls.push('tab');
      return false;
    });
    expect(dispatch(key('r', { altKey: true }, 'KeyR'))).toBe(true);
    expect(calls).toEqual(['tab', 'shell']);
    offTab();
    calls.length = 0;
    dispatch(key('r', { altKey: true }, 'KeyR'));
    expect(calls).toEqual(['shell']);
  });

  it('returns false when every handler declines or none is registered', () => {
    reg('zoomIn', () => false);
    expect(dispatch(key('=', { altKey: true }, 'Equal'))).toBe(false);
    expect(dispatch(key('0', { altKey: true }, 'Digit0'))).toBe(false); // zoomReset: no handler
  });

  it('unregister removes only that handler', () => {
    const a = vi.fn();
    const off = register('pinTab', a);
    off();
    off(); // idempotent
    expect(hasHandler('pinTab')).toBe(false);
    expect(dispatch(key('P', { altKey: true, shiftKey: true }, 'KeyP'))).toBe(false);
    expect(a).not.toHaveBeenCalled();
  });

  it('follows rebinding in settings, and unbound actions never fire', () => {
    const fn = vi.fn();
    reg('openSettings', fn);
    settings.patch({ browser: { shortcuts: { ...settings.value.browser.shortcuts, openSettings: 'Alt+Shift+S' } } });
    expect(bindingFor('openSettings')).toBe('Alt+Shift+S');
    expect(dispatch(key(',', { altKey: true }, 'Comma'))).toBe(false);
    expect(dispatch(key('S', { altKey: true, shiftKey: true }, 'KeyS'))).toBe(true);
    settings.patch({ browser: { shortcuts: { ...settings.value.browser.shortcuts, openSettings: '' } } });
    expect(dispatch(key('S', { altKey: true, shiftKey: true }, 'KeyS'))).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('skips auto-repeat unless the handler opts in', () => {
    const once = vi.fn();
    const repeating = vi.fn();
    reg('closeTab', once);
    reg('zoomOut', repeating, { repeat: true });
    expect(dispatch({ ...key('w', { altKey: true }, 'KeyW'), repeat: true })).toBe(false);
    expect(dispatch({ ...key('-', { altKey: true }, 'Minus'), repeat: true })).toBe(true);
    expect(once).not.toHaveBeenCalled();
    expect(repeating).toHaveBeenCalledOnce();
  });

  it('lets text editing keys through in editable fields but keeps app shortcuts', () => {
    const back = vi.fn();
    const palette = vi.fn();
    reg('back', back); // Alt+ArrowLeft = word navigation on macOS / in text fields
    reg('commandPalette', palette);
    expect(dispatch(key('ArrowLeft', { altKey: true }, 'ArrowLeft'), { editable: true })).toBe(false);
    expect(back).not.toHaveBeenCalled();
    expect(dispatch(key('ArrowLeft', { altKey: true }, 'ArrowLeft'), { editable: false })).toBe(true);
    expect(dispatch(key('k', { ctrlKey: true }, 'KeyK'), { editable: true })).toBe(true);
    expect(palette).toHaveBeenCalledOnce();
  });

  it('ignores keys during IME composition', () => {
    const fn = vi.fn();
    reg('newTab', fn);
    expect(dispatch({ ...key('t', { altKey: true }, 'KeyT'), isComposing: true })).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('contains handler errors (the key still counts as handled)', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    reg('findInPage', () => {
      throw new Error('boom');
    });
    expect(dispatch(key('f', { ctrlKey: true }, 'KeyF'))).toBe(true);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('uses ⌘ for Mod on Apple platforms', () => {
    setApplePlatformOverride(true);
    const fn = vi.fn();
    reg('commandPalette', fn);
    expect(dispatch(key('k', { ctrlKey: true }, 'KeyK'))).toBe(false);
    expect(dispatch(key('k', { metaKey: true }, 'KeyK'))).toBe(true);
    expect(shortcutCaps('commandPalette')).toEqual(['⌘', 'K']);
    setApplePlatformOverride(false);
    expect(shortcutCaps('commandPalette')).toEqual(['Ctrl', 'K']);
  });
});

describe('editor helpers', () => {
  it('maps events to actions and records combos', () => {
    expect(actionForEvent(key('h', { altKey: true }, 'KeyH'))).toBe('openHistory');
    expect(actionForEvent(key('q', { altKey: true }, 'KeyQ'))).toBeNull();
    expect(recordCombo(key('j', { altKey: true }, 'KeyJ'))).toBe('Alt+J');
  });

  it('reports conflicts with other actions', () => {
    expect(conflictsFor('Alt+T')).toEqual(['newTab']);
    expect(conflictsFor('Alt+T', 'newTab')).toEqual([]);
    expect(conflictsFor('Alt+Q')).toEqual([]);
    expect(conflictsFor('')).toEqual([]);
  });
});

describe('dispatchForwardedShortcut (ENGINE-PROTOCOL §6.7)', () => {
  beforeEach(() => resetForwardedBudget());
  afterEach(() => onForwardedShortcut(null));

  it('classifies every action exactly once, matching the protocol table', () => {
    const privileged = SHORTCUT_ACTIONS.filter((a) => isPrivilegedForwarded(a)).sort();
    expect(privileged).toEqual(
      ['newTab', 'duplicateTab', 'reopenClosedTab', 'closeTab', 'pinTab', 'bookmarkPage', 'toggleFullscreen', 'focusOmnibox', 'openHistory', 'openBookmarks', 'openDownloads', 'openSettings', 'openGames', 'commandPalette'].sort(),
    );
    for (const a of ORDINARY_FORWARDED) expect(SHORTCUT_ACTIONS).toContain(a);
  });

  it('runs ordinary actions for the exact combo the app sent, without activation', () => {
    const reload = vi.fn();
    reg('reload', reload);
    expect(dispatchForwardedShortcut('Alt+R', false, { activation: () => false })).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(dispatchForwardedShortcut('Alt+Q', false, { activation: () => true })).toBe(false);
  });

  it('runs privileged actions only with the app document activation, and at most 2 at once then 1 per second', () => {
    const newTab = vi.fn();
    reg('newTab', newTab);
    const outcomes: string[] = [];
    onForwardedShortcut((o) => outcomes.push(o));
    expect(dispatchForwardedShortcut('Alt+T', false, { activation: () => false, now: 0 })).toBe(false);
    expect(dispatchForwardedShortcut('Alt+T', false, { activation: () => null, now: 0 })).toBe(false);
    expect(newTab).not.toHaveBeenCalled();
    expect(dispatchForwardedShortcut('Alt+T', false, { activation: () => true, now: 0 })).toBe(true);
    expect(dispatchForwardedShortcut('Alt+T', false, { activation: () => true, now: 10 })).toBe(true);
    expect(dispatchForwardedShortcut('Alt+T', false, { activation: () => true, now: 20 })).toBe(false);
    expect(dispatchForwardedShortcut('Alt+T', false, { activation: () => true, now: 1100 })).toBe(true);
    expect(newTab).toHaveBeenCalledTimes(3);
    expect(outcomes).toEqual(['refused-activation', 'refused-activation', 'ran', 'ran', 'refused-rate', 'ran']);
  });

  it('honours repeat like the shell (only handlers registered with repeat run for auto-repeat)', () => {
    const zoom = vi.fn();
    const back = vi.fn();
    reg('zoomIn', zoom, { repeat: true });
    reg('back', back);
    expect(dispatchForwardedShortcut('Alt+=', true)).toBe(true);
    expect(dispatchForwardedShortcut('Alt+ArrowLeft', true)).toBe(false);
    expect(zoom).toHaveBeenCalledOnce();
    expect(back).not.toHaveBeenCalled();
  });
});
