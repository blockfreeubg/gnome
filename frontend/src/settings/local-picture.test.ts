import { describe, expect, it, vi } from 'vitest';
import { kvDelete } from '../lib/idb';
import { createDefaultSettings } from './defaults';
import { releaseReplacedPictures, storedPictureKey, withLocalPicture } from './local-picture';
import type { Settings } from './schema';

vi.mock('../lib/idb', () => ({ kvDelete: vi.fn(async () => undefined) }));

const picture = (key: string): Settings['appearance']['homeBackground'] => ({ kind: 'image', value: `idb:${key}`, dim: 0.2, blur: 0 });

describe('home background pictures stay in their browser', () => {
  it('recognizes stored pictures only', () => {
    expect(storedPictureKey('idb:home-bg:1')).toBe('home-bg:1');
    expect(storedPictureKey('https://example.com/a.png')).toBeNull();
    expect(storedPictureKey('idb:')).toBeNull();
    expect(storedPictureKey(undefined)).toBeNull();
  });

  it('keeps this browser’s backdrop when a document references a picture stored elsewhere', () => {
    const device = { kind: 'gradient' as const, value: 'linear-gradient(#000, #111)', dim: 0, blur: 0 };
    const doc = { appearance: { theme: 'light', homeBackground: picture('home-bg:other') } };
    expect(withLocalPicture(doc, device)).toEqual({ appearance: { theme: 'light', homeBackground: device } });
    // Its own picture, colors and https images pass through unchanged.
    expect(withLocalPicture({ appearance: { homeBackground: picture('home-bg:mine') } }, picture('home-bg:mine'))).toEqual({
      appearance: { homeBackground: picture('home-bg:mine') },
    });
    const url = { appearance: { homeBackground: { kind: 'image', value: 'https://example.com/a.png', dim: 0, blur: 0 } } };
    expect(withLocalPicture(url, device)).toBe(url);
    expect(withLocalPicture(null, device)).toBeNull();
  });

  it('deletes a stored picture once the setting stops using it (and never the current one)', () => {
    let value = createDefaultSettings();
    value.appearance.homeBackground = picture('home-bg:a');
    let listener: ((c: { sections: readonly string[] }) => void) | null = null;
    const store = {
      get value() {
        return value;
      },
      onChange: (fn: (c: { sections: readonly string[] }) => void) => ((listener = fn), () => (listener = null)),
    };
    const off = releaseReplacedPictures(store);
    const change = (bg: Settings['appearance']['homeBackground'], sections = ['appearance']): void => {
      value = { ...value, appearance: { ...value.appearance, homeBackground: bg } };
      listener?.({ sections });
    };
    change(picture('home-bg:a'), ['browser']);
    expect(kvDelete).not.toHaveBeenCalled();
    change(picture('home-bg:b')); // replaced
    expect(kvDelete).toHaveBeenLastCalledWith('home-bg:a');
    change({ kind: 'glow', value: '', dim: 0, blur: 0 }); // reset / another kind
    expect(kvDelete).toHaveBeenLastCalledWith('home-bg:b');
    expect(kvDelete).toHaveBeenCalledTimes(2);
    off();
  });
});
