import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHORTCUT_ACTIONS } from '../../settings/schema';
import {
  activeRowsOf,
  applyPaths,
  defaultAt,
  getAt,
  matchRanges,
  queryTerms,
  ROWS,
  ROW_BY_KEY,
  rowActive,
  searchSettings,
  sectionDescription,
  SECTIONS,
  withAt,
} from './registry';
import { SHELL_SHORTCUTS } from '../../settings/features';
import { createDefaultSettings } from '../../settings/defaults';

/** Every leaf path of the settings schema (records and arrays count as one leaf). */
function leafPaths(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [prefix];
  const entries = Object.entries(obj as Record<string, unknown>);
  // Records keyed by user data (empty objects by default) are leaves.
  if (!entries.length) return [prefix];
  return entries.flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
}

/**
 * Row ids each section component renders (`<Row section={S} id="…">`); the two lists built in a loop are expanded
 * from the arrays they loop over.
 */
function renderedRows(): Map<string, Set<string>> {
  const dir = new URL('./sections/', import.meta.url);
  const out = new Map<string, Set<string>>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.svelte'))) {
    let src = readFileSync(new URL(file, dir), 'utf8');
    const section = /const S = '([a-z]+)' as const/.exec(src)?.[1] ?? file;
    // Row components shared with another page (the content blocker's editors, src/extensions/app/ui/) render rows of
    // this section too.
    for (const m of src.matchAll(/from '((?:\.\.\/)+extensions\/app\/ui\/[A-Za-z]+\.svelte)'/g)) src += readFileSync(new URL(m[1]!, dir), 'utf8');
    const ids = new Set([...src.matchAll(/<Row\s+section=\{S\}\s+id="([^"]+)"/g)].map((m) => m[1]!));
    if (/<Row\s+section=\{S\}\s+id=\{b\.row\}/.test(src)) for (const m of src.matchAll(/\{ key: '[a-z]+', row: '([a-zA-Z]+)' \}/g)) ids.add(m[1]!);
    if (/<Row\s+section=\{S\}\s+id=\{action\}/.test(src)) for (const m of src.matchAll(/'([a-zA-Z0-9]+)'/g)) if ((SHORTCUT_ACTIONS as readonly string[]).includes(m[1]!)) ids.add(m[1]!);
    out.set(section, ids);
  }
  return out;
}

describe('registry', () => {
  it('matches what the section components render (search results always have a control to show)', () => {
    const rendered = renderedRows();
    expect([...rendered.keys()].sort()).toEqual(SECTIONS.map((s) => s.id).sort());
    for (const s of SECTIONS) {
      const registered = ROWS.filter((r) => r.section === s.id).map((r) => r.id).sort();
      expect([...(rendered.get(s.id) ?? [])].sort(), s.id).toEqual(registered);
    }
  });

  it('gives every schema key a row (no setting without a control)', () => {
    const covered = ROWS.flatMap((r) => r.paths);
    const leaves = leafPaths(createDefaultSettings()).filter((p) => p !== 'version');
    const missing = leaves.filter((leaf) => !covered.some((c) => leaf === c || leaf.startsWith(`${c}.`)));
    expect(missing).toEqual([]);
  });

  it('only names paths that exist', () => {
    for (const r of ROWS) for (const p of r.paths) expect(defaultAt(p), p).not.toBeUndefined();
  });

  it('has unique anchors per section and a row for every shortcut', () => {
    expect(ROW_BY_KEY.size).toBe(ROWS.length);
    for (const a of SHORTCUT_ACTIONS) expect(ROW_BY_KEY.has(`shortcuts.${a}`)).toBe(true);
    for (const s of SECTIONS) expect(ROWS.some((r) => r.section === s.id)).toBe(true);
  });

  it('reads and writes nested paths without mutating', () => {
    const s = createDefaultSettings();
    const next = withAt(s, 'browser.history.enabled', false);
    expect(getAt(next, 'browser.history.enabled')).toBe(false);
    expect(s.browser.history.enabled).toBe(true);
    expect(next.browser.history.retentionDays).toBe(90);
    expect(next.appearance).toBe(s.appearance);
    const both = applyPaths(s, [
      ['appearance.theme', 'light'],
      ['browser.shortcuts.newTab', ''],
    ]);
    expect(both.appearance.theme).toBe('light');
    expect(both.browser.shortcuts.newTab).toBe('');
    expect(both.browser.shortcuts.closeTab).toBe('Alt+W');
  });
});

describe('rows of features that are not in this build', () => {
  const none = (): boolean => false;
  const all = (): boolean => true;

  it('are hidden until the feature registers; everything else always shows', () => {
    expect(rowActive(ROW_BY_KEY.get('appearance.theme')!, none)).toBe(true);
    expect(rowActive(ROW_BY_KEY.get('browser.searchEngine')!, none)).toBe(true);
    expect(rowActive(ROW_BY_KEY.get('browser.startup')!, none)).toBe(false);
    expect(rowActive(ROW_BY_KEY.get('browser.startup')!, (f) => f === 'browser')).toBe(true);
    expect(rowActive(ROW_BY_KEY.get('privacy.sendGpc')!, (f) => f === 'browser')).toBe(false);
    for (const r of ROWS) expect(rowActive(r, all), `${r.section}.${r.id}`).toBe(true);
  });

  it('every section has rows once every feature is present', () => {
    for (const s of SECTIONS) expect(activeRowsOf(s.id, all).length, s.id).toBeGreaterThan(0);
    expect(activeRowsOf('vpn', none)).toEqual([]);
    expect(activeRowsOf('games', none)).toEqual([]);
    expect(activeRowsOf('extensions', none)).toEqual([]);
  });

  it('shortcut rows: shell actions always, browser actions with the browser', () => {
    expect(rowActive(ROW_BY_KEY.get('shortcuts.commandPalette')!, none)).toBe(true);
    expect(rowActive(ROW_BY_KEY.get('shortcuts.newTab')!, none)).toBe(false);
    for (const a of SHELL_SHORTCUTS) expect(ROW_BY_KEY.get(`shortcuts.${a}`)?.needs, a).toBeUndefined();
  });

  it('sections describe what this build shows', () => {
    expect(sectionDescription('browser', none)).toBe('Search engine and home page.');
    expect(sectionDescription('browser', all)).toMatch(/start-up, tabs, history/);
    expect(sectionDescription('appearance', none)).toMatch(/Theme, accent/);
    for (const s of SECTIONS) expect(sectionDescription(s.id, all), s.id).toBe(s.description);
  });

  it('are never search results', () => {
    const found = (q: string): string[] => searchSettings(q, none).map((h) => `${h.row.section}.${h.row.id}`);
    expect(found('utm')).not.toContain('privacy.stripTrackingParams');
    expect(found('mullvad')).toEqual([]);
    expect(found('theme')[0]).toBe('appearance.theme');
    expect(found('history')).toContain('privacy.clearData');
    expect(found('history')).not.toContain('browser.history');
  });
});

describe('searchSettings', () => {
  // Every feature present, so every row can be found.
  const ids = (q: string): string[] => searchSettings(q, () => true).map((h) => `${h.row.section}.${h.row.id}`);

  it('returns nothing for an empty query', () => {
    expect(searchSettings('  ', () => true)).toEqual([]);
  });

  it('finds rows by label, best match first', () => {
    expect(ids('theme')[0]).toBe('appearance.theme');
    expect(ids('blur')).toContain('appearance.blur');
  });

  it('finds rows by keyword and description', () => {
    expect(ids('dark mode')[0]).toBe('appearance.theme');
    expect(ids('utm')).toContain('privacy.stripTrackingParams');
    expect(ids('mullvad')).toContain('vpn.mode');
  });

  it('requires every term to match', () => {
    expect(ids('cookies exit')[0]).toBe('privacy.cookiesClearOnExit');
    expect(ids('cookies exit')).not.toContain('privacy.cookies');
    expect(ids('zzzz theme')).toEqual([]);
  });

  it('is case and accent insensitive', () => {
    expect(ids('THÉME')[0]).toBe('appearance.theme');
  });

  it('finds shortcuts by action name', () => {
    expect(ids('reopen closed')[0]).toBe('shortcuts.reopenClosedTab');
  });

  it('ranks label matches above description matches', () => {
    const hits = ids('history');
    expect(hits.indexOf('browser.history')).toBeLessThan(hits.indexOf('privacy.clearData'));
  });
});

describe('matchRanges', () => {
  it('finds and merges every occurrence', () => {
    expect(matchRanges('Clear history when GNOME closes', ['history'])).toEqual([[6, 13]]);
    expect(matchRanges('Tab tab TAB', ['tab'])).toEqual([
      [0, 3],
      [4, 7],
      [8, 11],
    ]);
    expect(matchRanges('background', ['back', 'ackg'])).toEqual([[0, 5]]);
  });

  it('works with accents and quotes', () => {
    expect(matchRanges('Thème', ['theme'])).toEqual([[0, 5]]);
    expect(queryTerms('  Dark,  MODE dark ')).toEqual(['dark', 'mode']);
  });
});
