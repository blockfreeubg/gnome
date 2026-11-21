import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MARK_PATH, MARK_VIEWBOX } from './logo-mark';

describe('logo mark', () => {
  it('matches public/brand-v2/gnome-mark-mono.svg', () => {
    const svg = readFileSync(fileURLToPath(new URL('../../public/brand-v2/gnome-mark-mono.svg', import.meta.url)), 'utf8');
    expect(svg).toContain(`viewBox="${MARK_VIEWBOX}"`);
    expect(svg).toContain(`fill-rule="evenodd"`);
    expect(svg.match(/ d="([^"]+)"/)?.[1]).toBe(MARK_PATH);
  });
});
