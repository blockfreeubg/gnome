import { describe, expect, it } from 'vitest';
import { compileCombos, forwardedCombo } from './keys';

const ev = (key: string, code: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) => ({
  key,
  code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta,
});

describe('forwarded shortcuts', () => {
  const pc = compileCombos(['Alt+T', 'Mod+Shift+K', 'F6', 'Mod+A', 'not a combo++x'], false);
  it('matches with src/lib/keys.ts (layout-independent letters) and returns the string the app sent', () => {
    expect(forwardedCombo(pc, ev('†', 'KeyT', { alt: true }), false)).toBe('Alt+T');
    expect(forwardedCombo(pc, ev('K', 'KeyK', { ctrl: true, shift: true }), false)).toBe('Mod+Shift+K');
    expect(forwardedCombo(pc, ev('F6', 'F6'), false)).toBe('F6');
    expect(forwardedCombo(pc, ev('t', 'KeyT'), false)).toBeNull();
    expect(pc.list.map((c) => c.text)).toEqual(['Alt+T', 'Mod+Shift+K', 'F6', 'Mod+A']);
  });
  it('skips text-editing combos while the target is editable, and composing input', () => {
    expect(forwardedCombo(pc, ev('a', 'KeyA', { ctrl: true }), true)).toBeNull();
    expect(forwardedCombo(pc, ev('a', 'KeyA', { ctrl: true }), false)).toBe('Mod+A');
    expect(forwardedCombo(pc, ev('F6', 'F6'), true)).toBeNull(); // a plain key types/moves in an editable
    expect(forwardedCombo(pc, { ...ev('†', 'KeyT', { alt: true }), isComposing: true }, false)).toBeNull();
  });
  it('uses Cmd for Mod on Apple', () => {
    const mac = compileCombos(['Mod+Shift+K'], true);
    expect(forwardedCombo(mac, ev('k', 'KeyK', { meta: true, shift: true }), false)).toBe('Mod+Shift+K');
    expect(forwardedCombo(mac, ev('k', 'KeyK', { ctrl: true, shift: true }), false)).toBeNull();
  });
});
