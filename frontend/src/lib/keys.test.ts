import { describe, expect, it } from 'vitest';
import {
  ariaKeyShortcut,
  comboFromEvent,
  describeCombo,
  eventKey,
  formatCombo,
  isTextEditingCombo,
  matchCombo,
  normalizeCombo,
  normalizeKeyName,
  parseCombo,
  sameCombo,
  type KeyEventLike,
} from './keys';

function ev(key: string, mods: Partial<KeyEventLike> = {}, code?: string): KeyEventLike {
  return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...(code ? { code } : {}), ...mods };
}

function matches(combo: string, e: KeyEventLike, apple = false): boolean {
  const c = parseCombo(combo);
  if (!c) throw new Error(`invalid combo ${combo}`);
  return matchCombo(c, e, apple);
}

describe('parseCombo / normalizeCombo', () => {
  it('parses modifiers in any order and canonicalizes', () => {
    expect(normalizeCombo('alt+t')).toBe('Alt+T');
    expect(normalizeCombo('Shift+Alt+t')).toBe('Alt+Shift+T');
    expect(normalizeCombo('CmdOrCtrl+k')).toBe('Mod+K');
    expect(normalizeCombo('control+option+shift+command+F5')).toBe('Ctrl+Meta+Alt+Shift+F5');
    expect(normalizeCombo(' Alt + PageDown ')).toBe('Alt+PageDown');
  });

  it('understands named keys, aliases and punctuation', () => {
    expect(normalizeCombo('Alt+Left')).toBe('Alt+ArrowLeft');
    expect(normalizeCombo('Alt+esc')).toBe('Alt+Escape');
    expect(normalizeCombo('Alt+pgdn')).toBe('Alt+PageDown');
    expect(normalizeCombo('Alt+,')).toBe('Alt+,');
    expect(normalizeCombo('Alt+=')).toBe('Alt+=');
    expect(normalizeCombo('Alt+-')).toBe('Alt+-');
    expect(normalizeCombo('Alt++')).toBe('Alt+Plus');
    expect(normalizeCombo('Alt+Plus')).toBe('Alt+Plus');
    expect(normalizeCombo('Mod+?')).toBe('Mod+?');
    expect(normalizeCombo('Alt+space')).toBe('Alt+Space');
    expect(normalizeCombo('F12')).toBe('F12');
    expect(normalizeCombo('shift+f24')).toBe('Shift+F24');
  });

  it('treats the empty string as unbound and rejects nonsense', () => {
    expect(normalizeCombo('')).toBe('');
    expect(normalizeCombo('   ')).toBe('');
    expect(parseCombo('')).toBeNull();
    for (const bad of ['Alt+', 'Alt+Hyper+T', 'Alt+F25', 'Alt+TT', 'Ctrl+Alt', 'Alt++T', 'Foo']) {
      expect(normalizeCombo(bad), bad).toBeNull();
    }
  });

  it('normalizeKeyName', () => {
    expect(normalizeKeyName('a')).toBe('A');
    expect(normalizeKeyName('7')).toBe('7');
    expect(normalizeKeyName(' ')).toBe('Space');
    expect(normalizeKeyName('arrowup')).toBe('ArrowUp');
    expect(normalizeKeyName('é')).toBeNull();
  });
});

describe('matchCombo', () => {
  it('matches exact modifier sets only', () => {
    expect(matches('Alt+T', ev('t', { altKey: true }))).toBe(true);
    expect(matches('Alt+T', ev('T', { altKey: true, shiftKey: true }))).toBe(false);
    expect(matches('Alt+T', ev('t', { altKey: true, ctrlKey: true }))).toBe(false);
    expect(matches('Alt+Shift+T', ev('T', { altKey: true, shiftKey: true }))).toBe(true);
    expect(matches('Alt+T', ev('t'))).toBe(false);
  });

  it('resolves Mod to Ctrl elsewhere and ⌘ on Apple platforms', () => {
    expect(matches('Mod+K', ev('k', { ctrlKey: true }), false)).toBe(true);
    expect(matches('Mod+K', ev('k', { metaKey: true }), false)).toBe(false);
    expect(matches('Mod+K', ev('k', { metaKey: true }), true)).toBe(true);
    expect(matches('Mod+K', ev('k', { ctrlKey: true }), true)).toBe(false);
  });

  it('uses the physical key when Option produces a special character (macOS)', () => {
    // Option+T types "†" on a US Mac layout; the binding Alt+T must still fire.
    expect(matches('Alt+T', ev('†', { altKey: true }, 'KeyT'), true)).toBe(true);
    // Option+, types "≤".
    expect(matches('Alt+,', ev('≤', { altKey: true }, 'Comma'), true)).toBe(true);
  });

  it('keeps the produced character on non-US Latin layouts', () => {
    // German layout: the key labelled "Z" sits where US has "Y" (code KeyY).
    expect(matches('Alt+Z', ev('z', { altKey: true }, 'KeyY'))).toBe(true);
    expect(matches('Alt+Y', ev('z', { altKey: true }, 'KeyY'))).toBe(false);
  });

  it('ignores the Shift needed to type a symbol', () => {
    // "+" is Shift+= on US layouts.
    expect(matches('Alt+Plus', ev('+', { altKey: true, shiftKey: true }, 'Equal'))).toBe(true);
    expect(matches('Alt+Plus', ev('+', { altKey: true }, 'NumpadAdd'))).toBe(true);
    expect(matches('Mod+?', ev('?', { ctrlKey: true, shiftKey: true }, 'Slash'))).toBe(true);
  });

  it('matches digits by physical key on layouts that need Shift for them (AZERTY)', () => {
    // AZERTY: the "1" key types "&" without Shift.
    expect(matches('Alt+1', ev('&', { altKey: true }, 'Digit1'))).toBe(true);
    expect(matches('Alt+1', ev('1', { altKey: true }, 'Digit1'))).toBe(true);
  });

  it('never matches lone modifiers or composition', () => {
    expect(eventKey(ev('Alt', { altKey: true }, 'AltLeft'))).toBeNull();
    expect(eventKey(ev('Shift', { shiftKey: true }, 'ShiftLeft'))).toBeNull();
    expect(eventKey(ev('Process', {}, 'KeyA'))).toBeNull();
  });

  it('handles dead keys through the physical key', () => {
    expect(matches('Alt+E', ev('Dead', { altKey: true }, 'KeyE'), true)).toBe(true);
  });
});

describe('comboFromEvent (recording)', () => {
  it('records platform-neutral combos', () => {
    expect(comboFromEvent(ev('k', { ctrlKey: true }, 'KeyK'), false)).toBe('Mod+K');
    expect(comboFromEvent(ev('k', { metaKey: true }, 'KeyK'), true)).toBe('Mod+K');
    expect(comboFromEvent(ev('k', { ctrlKey: true }, 'KeyK'), true)).toBe('Ctrl+K');
    expect(comboFromEvent(ev('T', { altKey: true, shiftKey: true }, 'KeyT'), false)).toBe('Alt+Shift+T');
    expect(comboFromEvent(ev('+', { altKey: true, shiftKey: true }, 'Equal'), false)).toBe('Alt+Plus');
    expect(comboFromEvent(ev('Shift', { shiftKey: true }, 'ShiftLeft'), false)).toBeNull();
  });

  it('round-trips: a recorded combo matches the same press', () => {
    const presses: Array<[KeyEventLike, boolean]> = [
      [ev('t', { altKey: true }, 'KeyT'), false],
      [ev('†', { altKey: true }, 'KeyT'), true],
      [ev('ArrowLeft', { altKey: true }, 'ArrowLeft'), false],
      [ev('k', { metaKey: true }, 'KeyK'), true],
      [ev('F5', {}, 'F5'), false],
    ];
    for (const [press, apple] of presses) {
      const combo = comboFromEvent(press, apple);
      expect(combo).not.toBeNull();
      expect(matches(combo!, press, apple), `${combo} on apple=${apple}`).toBe(true);
    }
  });
});

describe('formatting', () => {
  it('formats key caps per platform', () => {
    expect(formatCombo('Mod+K', false)).toEqual(['Ctrl', 'K']);
    expect(formatCombo('Mod+K', true)).toEqual(['⌘', 'K']);
    expect(formatCombo('Alt+Shift+ArrowLeft', true)).toEqual(['⌥', '⇧', '←']);
    expect(formatCombo('Alt+PageDown', false)).toEqual(['Alt', 'PgDn']);
    expect(formatCombo('Ctrl+Meta+Alt+Shift+K', true)).toEqual(['⌃', '⌥', '⇧', '⌘', 'K']);
    expect(formatCombo('nonsense+', false)).toEqual([]);
  });

  it('describes combos for assistive technology', () => {
    expect(describeCombo('Mod+K', true)).toBe('Command+K');
    expect(describeCombo('Mod+K', false)).toBe('Ctrl+K');
    expect(describeCombo('Alt+T', true)).toBe('Option+T');
  });

  it('writes aria-keyshortcuts values with UI Events modifier names', () => {
    expect(ariaKeyShortcut('Mod+K', false)).toBe('Control+K');
    expect(ariaKeyShortcut('Mod+K', true)).toBe('Meta+K');
    expect(ariaKeyShortcut('alt+shift+t', false)).toBe('Alt+Shift+T');
    expect(ariaKeyShortcut('Ctrl+Alt+ArrowLeft', true)).toBe('Control+Alt+ArrowLeft');
    expect(ariaKeyShortcut('Alt+PageDown', false)).toBe('Alt+PageDown');
    expect(ariaKeyShortcut('Alt+,', false)).toBe('Alt+,');
    expect(ariaKeyShortcut('', false)).toBe('');
    expect(ariaKeyShortcut('Bogus+Key', false)).toBe('');
  });

  it('compares combos after Mod resolution', () => {
    expect(sameCombo('Mod+K', 'Ctrl+K', false)).toBe(true);
    expect(sameCombo('Mod+K', 'Ctrl+K', true)).toBe(false);
    expect(sameCombo('Mod+K', 'Meta+K', true)).toBe(true);
    expect(sameCombo('alt+shift+t', 'Shift+Alt+T', false)).toBe(true);
  });
});

describe('isTextEditingCombo', () => {
  it('flags combos that edit text', () => {
    for (const c of ['T', 'Shift+T', 'Alt+ArrowLeft', 'Mod+ArrowRight', 'Alt+Backspace', 'Mod+C', 'Mod+V', 'Mod+Z', 'Home']) {
      expect(isTextEditingCombo(c, false), c).toBe(true);
    }
    expect(isTextEditingCombo('Mod+A', true)).toBe(true);
  });

  it('leaves app shortcuts alone', () => {
    for (const c of ['Alt+T', 'Mod+K', 'Alt+Shift+F', 'Alt+,', 'Alt+1', 'Mod+F', 'Alt+PageDown']) {
      expect(isTextEditingCombo(c, false), c).toBe(false);
    }
  });
});
