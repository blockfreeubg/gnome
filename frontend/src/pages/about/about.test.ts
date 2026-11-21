import { describe, expect, it, vi } from 'vitest';
import { normalizeServerConfig, type ServerConfig } from '../../lib/api';
import { DEFAULT_SHORTCUTS } from '../../settings/defaults';
import { SHORTCUT_ACTIONS, type ShortcutAction } from '../../settings/schema';
import {
  engineSummary,
  isolationStatus,
  sourceOffer,
  stateLabel,
  statusTone,
  subsystemLabel,
} from './about';
import { groupingProblems, isDigitRange, shortcutReference, SHORTCUT_GROUPS } from './shortcut-reference';

vi.mock('../../lib/idb', () => ({
  idbGet: vi.fn(async () => undefined),
  idbPut: vi.fn(async () => 'current'),
}));

function config(over: Record<string, unknown> = {}): ServerConfig {
  return normalizeServerConfig({
    version: '0.1.0',
    access_mode: 'open',
    registration: 'open',
    features: { accounts: true, sync: true, games: true, vpn_gateway: false, thumb_proxy: true },
    wisp: { path: '/wisp/', ticket_ttl_s: 86400, profiles: [], custom_servers: false },
    engines: { default: 'scramjet', scramjet: true, ultraviolet: true },
    proxy: { origin: 'https://p.example.com', isolated: true },
    source_url: 'https://example.com/src',
    limits: { max_ws_per_session: 16 },
    ...over,
  } as unknown as ServerConfig);
}

describe('shortcut reference', () => {
  it('groups every action exactly once', () => {
    expect(groupingProblems()).toEqual([]);
    const listed = SHORTCUT_GROUPS.flatMap((g) => g.actions);
    expect([...listed].sort()).toEqual([...SHORTCUT_ACTIONS].sort());
  });

  it('shows the default bindings with tabs 1–8 collapsed into one row', () => {
    const groups = shortcutReference(DEFAULT_SHORTCUTS, false);
    const rows = groups.flatMap((g) => g.rows);
    const covered = rows.flatMap((r) => r.actions);
    expect([...covered].sort()).toEqual([...SHORTCUT_ACTIONS].sort());

    const range = rows.find((r) => r.id === 'selectTab1-8');
    expect(range?.caps).toEqual(['Alt', '1']);
    expect(range?.capsEnd).toEqual(['Alt', '8']);
    expect(range?.spoken).toBe('Alt+1 to Alt+8');
    expect(rows.find((r) => r.id === 'selectTab9')?.label).toBe('Go to last tab');

    const palette = rows.find((r) => r.id === 'commandPalette');
    expect(palette?.caps).toEqual(['Ctrl', 'K']);
    expect(palette?.label).toBe('Command palette');
  });

  it('formats for Apple platforms', () => {
    const rows = shortcutReference(DEFAULT_SHORTCUTS, true).flatMap((g) => g.rows);
    expect(rows.find((r) => r.id === 'commandPalette')?.caps).toEqual(['⌘', 'K']);
    expect(rows.find((r) => r.id === 'commandPalette')?.spoken).toBe('Command+K');
    expect(rows.find((r) => r.id === 'newTab')?.caps).toEqual(['⌥', 'T']);
  });

  it('reflects the user’s own bindings, including unbound actions', () => {
    const custom: Record<ShortcutAction, string> = { ...DEFAULT_SHORTCUTS, newTab: 'Mod+Shift+Y', reload: '' };
    const rows = shortcutReference(custom, false).flatMap((g) => g.rows);
    expect(rows.find((r) => r.id === 'newTab')?.caps).toEqual(['Ctrl', 'Shift', 'Y']);
    const reload = rows.find((r) => r.id === 'reload');
    expect(reload?.caps).toEqual([]);
    expect(reload?.spoken).toBe('');
  });

  it('leaves out shortcuts that do nothing in this build, and the groups they empty', () => {
    const shell = new Set(['commandPalette', 'toggleSidebar', 'home', 'openSettings']);
    const groups = shortcutReference(DEFAULT_SHORTCUTS, false, (a) => shell.has(a));
    const ids = groups.flatMap((g) => g.rows.map((r) => r.id));
    expect([...ids].sort()).toEqual([...shell].sort());
    expect(groups.map((g) => g.id)).toEqual(['general', 'page']);
  });

  it('lists tabs 1–8 individually once the bindings stop forming a range', () => {
    const custom = { ...DEFAULT_SHORTCUTS, selectTab3: 'Alt+Shift+3' };
    const rows = shortcutReference(custom, false).flatMap((g) => g.rows);
    expect(rows.some((r) => r.id === 'selectTab1-8')).toBe(false);
    expect(rows.find((r) => r.id === 'selectTab3')?.caps).toEqual(['Alt', 'Shift', '3']);
    expect(rows.filter((r) => r.id.startsWith('selectTab'))).toHaveLength(9);
  });

  it('recognizes digit ranges', () => {
    const range = ['1', '2', '3', '4', '5', '6', '7', '8'];
    expect(isDigitRange(range.map((d) => `Mod+${d}`))).toBe(true);
    expect(isDigitRange(range.map((d) => `Alt+Shift+${d}`))).toBe(true);
    expect(isDigitRange(range.map((d, i) => (i === 4 ? '' : `Alt+${d}`)))).toBe(false);
    expect(isDigitRange(range.map((d, i) => (i === 0 ? 'Ctrl+1' : `Alt+${d}`)))).toBe(false);
    expect(isDigitRange([...range].reverse().map((d) => `Alt+${d}`))).toBe(false);
    expect(isDigitRange(['Alt+1'])).toBe(false);
  });
});

describe('proxy isolation status', () => {
  it('reports isolation from /api/config', () => {
    const on = isolationStatus(config(), true);
    expect(on.state).toBe('on');
    expect(on.origin).toBe('https://p.example.com');
  });

  it('explains single-origin mode', () => {
    const off = isolationStatus(config({ proxy: { origin: 'https://gnome.example.com', isolated: false } }), true);
    expect(off.state).toBe('off');
    expect(off.detail).toMatch(/GNOME_PROXY_ORIGIN/);
  });

  it('degrades when an older server omits proxy', () => {
    const cfg = config();
    const raw = { ...cfg } as Record<string, unknown>;
    delete raw.proxy;
    const s = isolationStatus(normalizeServerConfig(raw as unknown as ServerConfig), true);
    expect(s.state).toBe('unreported');
    expect(s.origin).toBeNull();
  });

  it('degrades with the backend offline or not checked yet', () => {
    expect(isolationStatus(null, false).state).toBe('offline');
    expect(isolationStatus(null, null).state).toBe('checking');
  });
});

describe('source offer', () => {
  it('links the configured source', () => {
    expect(sourceOffer(config())).toEqual({ kind: 'link', url: 'https://example.com/src' });
  });
  it('is missing when the operator set none, unknown when offline', () => {
    expect(sourceOffer(config({ source_url: '' }))).toEqual({ kind: 'missing' });
    expect(sourceOffer(config({ source_url: 'javascript:alert(1)' }))).toEqual({ kind: 'missing' });
    expect(sourceOffer(null)).toEqual({ kind: 'unknown' });
  });
});

describe('diagnostics labels', () => {
  it('maps states to tones and labels', () => {
    expect(statusTone('ok')).toBe('success');
    expect(statusTone('degraded')).toBe('warning');
    expect(statusTone('down')).toBe('danger');
    expect(statusTone('starting')).toBe('slate');
    expect(statusTone('off')).toBe('neutral');
    expect(stateLabel('ok')).toBe('OK');
    expect(stateLabel('unknown')).toBe('Unknown');
  });

  it('names subsystems', () => {
    expect(subsystemLabel('storage')).toBe('Local storage');
    expect(subsystemLabel('engine-host')).toBe('Engine host');
    expect(subsystemLabel('filter_engine')).toBe('Filter engine');
  });

  it('summarizes enabled engines', () => {
    expect(engineSummary(config())).toBe('Scramjet (default) · Ultraviolet');
    expect(engineSummary(config({ engines: { default: 'ultraviolet', scramjet: false, ultraviolet: true } }))).toBe(
      'Ultraviolet (default)',
    );
    expect(engineSummary(config({ engines: { default: 'scramjet', scramjet: false, ultraviolet: false } }))).toBe(
      'None enabled',
    );
  });
});
