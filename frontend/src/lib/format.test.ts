import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatBytes, formatCompact, formatDayLabel, formatDuration, formatRelativeTime, pluralize } from './format';

describe('format', () => {
  it('formats bytes in binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536, { locale: 'en' })).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3, { locale: 'en' })).toBe('5 GB');
    expect(formatBytes(150 * 1024 ** 2, { locale: 'en' })).toBe('150 MB');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });

  it('formats relative times', () => {
    const now = Date.UTC(2026, 10, 10, 12, 0, 0);
    expect(formatRelativeTime(now - 10_000, now, 'en')).toBe('just now');
    expect(formatRelativeTime(now - 5 * 60_000, now, 'en')).toBe('5 minutes ago');
    expect(formatRelativeTime(now - 26 * 3_600_000, now, 'en')).toBe('yesterday');
    expect(formatRelativeTime(now + 3 * 86_400_000, now, 'en')).toBe('in 3 days');
    expect(formatRelativeTime(now - 400 * 86_400_000, now, 'en')).toBe('last year');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps phrases in the interface language whatever the browser locale', () => {
    const now = Date.UTC(2026, 10, 10, 12, 0, 0);
    vi.stubGlobal('navigator', { language: 'de-DE' });
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(formatDayLabel(Date.UTC(2026, 10, 2, 12), now)).toMatch(/^Monday/);
    vi.stubGlobal('navigator', { language: 'en-GB' });
    expect(formatRelativeTime(now - 26 * 3_600_000, now)).toBe('yesterday');
  });

  it('formats durations, compact numbers, day labels and plurals', () => {
    expect(formatDuration(42_000)).toBe('0:42');
    expect(formatDuration(725_000)).toBe('12:05');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatDuration(-5)).toBe('—');
    expect(formatCompact(1234, 'en')).toBe('1.2K');
    const now = new Date(2026, 10, 10, 15, 0).getTime();
    expect(formatDayLabel(now - 3_600_000, now)).toBe('Today');
    expect(formatDayLabel(new Date(2026, 10, 9, 23, 0).getTime(), now)).toBe('Yesterday');
    expect(pluralize(1, 'tab')).toBe('1 tab');
    expect(pluralize(3, 'entry', 'entries')).toBe('3 entries');
  });
});
