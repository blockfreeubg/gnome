/**
 * Pure helpers for the About page: proxy isolation status (from GET /api/config → proxy), the source offer and
 * diagnostics labels. Kept out of the component so the offline / older-server cases are unit-tested.
 */
import type { ServerConfig } from '../../lib/api';
import type { StatusState } from '../../app/status';

export type IsolationState = 'on' | 'off' | 'unreported' | 'offline' | 'checking';

export interface IsolationStatus {
  state: IsolationState;
  title: string;
  detail: string;
  /** The proxy origin, when the server reported one. */
  origin: string | null;
}

/**
 * Proxy isolation as the server reports it (docs/ARCHITECTURE.md §4.6).
 * `reachable` is the server state: null = not checked yet, false = unreachable.
 */
export function isolationStatus(config: ServerConfig | null, reachable: boolean | null): IsolationStatus {
  if (!config) {
    if (reachable === null) {
      return { state: 'checking', title: 'Checking', detail: 'Asking the GNOME server how proxied pages are isolated.', origin: null };
    }
    return {
      state: 'offline',
      title: 'Unknown',
      detail: 'The GNOME server is not reachable, so it cannot report how proxied pages are isolated.',
      origin: null,
    };
  }
  const { origin, isolated } = config.proxy;
  if (isolated) {
    return {
      state: 'on',
      title: 'On',
      detail:
        'Proxied pages run on a separate proxy origin. They cannot read GNOME’s storage (settings, history, bookmarks) or call its signed-in API.',
      origin,
    };
  }
  if (origin) {
    return {
      state: 'off',
      title: 'Off (single-origin mode)',
      detail:
        'This server runs GNOME and proxied pages on the same origin. A hostile page that escapes the proxy engine could read GNOME’s local data. Operators can enable isolation by setting GNOME_PROXY_ORIGIN (or GNOME_PROXY_BIND) to a second hostname or port.',
      origin,
    };
  }
  return {
    state: 'unreported',
    title: 'Not reported',
    detail:
      'The server did not report a proxy origin: it is an older version, or it could not tell which address this page was loaded from.',
    origin: null,
  };
}

export type SourceOffer =
  | { kind: 'link'; url: string }
  | { kind: 'missing' } /* server answered without a source_url */
  | { kind: 'unknown' }; /* server not reachable (yet) */

export function sourceOffer(config: ServerConfig | null): SourceOffer {
  if (!config) return { kind: 'unknown' };
  return config.source_url ? { kind: 'link', url: config.source_url } : { kind: 'missing' };
}

export type Tone = 'success' | 'warning' | 'danger' | 'slate' | 'neutral';

export function statusTone(state: StatusState): Tone {
  switch (state) {
    case 'ok':
      return 'success';
    case 'degraded':
      return 'warning';
    case 'down':
      return 'danger';
    case 'starting':
      return 'slate';
    default:
      return 'neutral';
  }
}

const STATE_LABELS: Readonly<Record<StatusState, string>> = {
  ok: 'OK',
  starting: 'Starting',
  degraded: 'Degraded',
  down: 'Down',
  off: 'Off',
  unknown: 'Unknown',
};

export function stateLabel(state: StatusState): string {
  return STATE_LABELS[state] ?? 'Unknown';
}

const SUBSYSTEM_LABELS: Readonly<Record<string, string>> = {
  server: 'Server',
  settings: 'Settings',
  storage: 'Local storage',
  sync: 'Sync',
  engine: 'Proxy engine',
  transport: 'Transport',
  vpn: 'VPN',
  extensions: 'Extensions',
};

/** "server" → "Server", "engine-host" → "Engine host". */
export function subsystemLabel(name: string): string {
  const known = SUBSYSTEM_LABELS[name];
  if (known) return known;
  const words = name.replace(/[-_.]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

export const ACCESS_MODE_LABELS: Readonly<Record<ServerConfig['access_mode'], string>> = {
  open: 'Open to anyone',
  code: 'Access code',
  accounts: 'Accounts only',
};

/** Enabled engines in display order ("Scramjet (default) · Ultraviolet"). */
export function engineSummary(config: ServerConfig): string {
  const names: string[] = [];
  for (const id of ['scramjet', 'ultraviolet'] as const) {
    if (!config.engines[id]) continue;
    const name = id === 'scramjet' ? 'Scramjet' : 'Ultraviolet';
    names.push(config.engines.default === id ? `${name} (default)` : name);
  }
  return names.length ? names.join(' · ') : 'None enabled';
}
