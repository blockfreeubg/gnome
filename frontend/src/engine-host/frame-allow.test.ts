import { describe, expect, it } from 'vitest';
import { tabFrameAllow } from '../shared/site-rules';
import { tabFrameAllowList } from './frame-allow';

const ALLOW = { autoplay: 'allow', fullscreen: 'allow', clipboard: 'allow' } as const;
const BLOCK = { autoplay: 'block', fullscreen: 'block', clipboard: 'block' } as const;

describe('tab iframe allow attribute', () => {
  it('Chromium (all three enforced): exactly the contract’s attribute', () => {
    const all = ['autoplay', 'fullscreen', 'clipboard'] as const;
    expect(tabFrameAllowList(ALLOW, all)).toBe(tabFrameAllow(ALLOW, all));
    expect(tabFrameAllowList(BLOCK, all)).toBe("autoplay 'none'; fullscreen 'none'; clipboard-write 'none'");
  });

  it('Firefox (fullscreen only): the unsupported features are left out, never blocked by omission', () => {
    expect(tabFrameAllowList(ALLOW, ['fullscreen'])).toBe('fullscreen');
    expect(tabFrameAllowList(BLOCK, ['fullscreen'])).toBe("fullscreen 'none'");
    expect(tabFrameAllowList(BLOCK, ['fullscreen'])).not.toMatch(/autoplay|clipboard/);
  });

  it('a browser that enforces nothing gets an empty attribute (every feature keeps its default allowlist)', () => {
    expect(tabFrameAllowList(BLOCK, [])).toBe('');
  });
});
