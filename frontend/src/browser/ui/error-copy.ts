/**
 * Wording of GNOME's error overlay (ENGINE-PROTOCOL §6.4). Pure, so the rules are unit-tested.
 *
 * "This VPN location is down" comes from the app's own facts (§6.4, §1.2 rule 3): the route the app chose is that
 * location's profile and `/api/vpn/locations` reports it down (or `/api/config` no longer offers it). The engine
 * host's error only says what failed (`kind`); its `detail` is shown apart, as the transport's words.
 */
import { parseBlockerDetail, type BlockerFailReason } from '../../extensions/core/detail';
import type { BlockCategory, BlockerListError, BlockerStatus } from '../../shared/engine-protocol';
import type { TabError } from '../tabs.svelte';

export type ErrorGlyph = 'unplug' | 'timer' | 'server' | 'offline' | 'blocked';

/** What the app knows about the VPN location pages are routed through (Browser.vpnLocation), or null off it. */
export interface VpnFacts {
  label: string;
  status: 'up' | 'down' | 'unknown' | 'gone' | 'none';
}

export interface ErrorCopy {
  glyph: ErrorGlyph;
  title: string;
  body: string;
}

export function errorCopy(error: Pick<TabError, 'kind'> & Partial<Pick<TabError, 'detail'>>, ctx: { host: string; vpn: VpnFacts | null; killSwitch: boolean; engine: string }): ErrorCopy {
  const { host, vpn } = ctx;
  if (vpn && (error.kind === 'gateway' || error.kind === 'network') && (vpn.status === 'down' || vpn.status === 'gone' || vpn.status === 'none')) {
    const locked = ctx.killSwitch ? ' The kill switch keeps pages off every other route until it is back.' : '';
    if (vpn.status === 'none') return { glyph: 'server', title: 'No VPN location is available', body: `This server offers no VPN location to route pages through.${locked}` };
    if (vpn.status === 'gone') {
      return { glyph: 'server', title: 'This VPN location is no longer offered', body: `The server does not offer “${vpn.label}” any more. Choose another location in Settings → VPN.${locked}` };
    }
    return { glyph: 'server', title: 'This VPN location is down', body: `GNOME’s server reports “${vpn.label}” as down. Choose another location in Settings → VPN, or try again later.${locked}` };
  }
  switch (error.kind) {
    case 'network':
      return { glyph: 'unplug', title: `Can’t reach ${host || 'this site'}`, body: 'The site could not be reached. It may be down, the address may be wrong, or its name could not be found.' };
    case 'timeout':
      return { glyph: 'timer', title: `${host || 'The site'} took too long to respond`, body: 'No page arrived within 20 seconds.' };
    case 'gateway':
      return vpn
        ? { glyph: 'server', title: 'The VPN location is not reachable', body: `Pages are routed through “${vpn.label}”, and it is not answering right now. It reconnects on its own.` }
        : { glyph: 'server', title: 'GNOME’s proxy is not reachable', body: 'The connection between your browser and GNOME’s gateway is down. It reconnects on its own.' };
    case 'offline':
      return { glyph: 'offline', title: 'You are offline', body: 'Your device has no network connection.' };
    case 'blocked':
      return { glyph: 'blocked', title: 'Blocked by GNOME', body: blockedReason(blockedCategory(error.detail ?? '')) };
    default:
      return { glyph: 'server', title: 'This page could not be shown', body: `${ctx.engine} failed to load it.` };
  }
}

// ── Content blocker texts (WAVE-B3 C5, C5b, §7.1) ──────────────────────────────────────────────────────────────────
// Everything the engine host says about the blocker is a code; these are GNOME's own sentences for them. Nothing the
// engine host writes is shown as text (a page that escaped its engine could otherwise write into GNOME's UI).


/** Plain names of the block categories (the shield, the Extensions page). */
export const BLOCK_CATEGORY_LABELS: Readonly<Record<BlockCategory, string>> = {
  ads: 'Ads',
  trackers: 'Trackers',
  security: 'Scam and malware sites',
  urlparams: 'Tracking parameters removed',
  cookies: 'Cookie notices',
  annoyances: 'Annoyances',
  'direct-connection': 'Direct connections stopped',
};

const FAIL_REASONS: Readonly<Record<BlockerFailReason, string>> = {
  'all-lists-failed': 'None of the filter lists could be loaded from this server.',
  'worker-crashed': 'The background task that prepares them stopped unexpectedly.',
  'out-of-memory': 'This device ran out of memory while preparing them: turn off some filter lists.',
  'build-error': 'The filter engine could not be built from them.',
};

const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;

export type BlockerTone = 'off' | 'busy' | 'ok' | 'warn' | 'error';

export interface BlockerStateCopy {
  tone: BlockerTone;
  /** One or two words ("Ready", "Preparing", "Off", "Problem"). */
  label: string;
  /** GNOME's sentence for the state and its code; null when there is nothing to add. */
  text: string | null;
}

/** The text of `status.blocker` (state + its C5b detail code). */
export function blockerStateCopy(s: Pick<BlockerStatus, 'state' | 'detail' | 'lists'>): BlockerStateCopy {
  const d = parseBlockerDetail(s.detail);
  switch (s.state) {
    case 'off':
      return { tone: 'off', label: 'Off', text: null };
    case 'building':
      return { tone: 'busy', label: 'Preparing', text: 'Preparing filter lists…' };
    case 'failed':
      return {
        tone: 'error',
        label: 'Problem',
        text: d?.code === 'failed' ? `Filter lists could not be prepared. ${FAIL_REASONS[d.reason]}` : s.detail === null ? 'Filter lists could not be prepared.' : 'The content blocker reported a problem.',
      };
    case 'ready': {
      if (s.detail === null) return { tone: 'ok', label: 'Ready', text: null };
      if (!d) return { tone: 'warn', label: 'Ready', text: 'The content blocker reported a problem.' };
      switch (d.code) {
        case 'lists-failed':
          return { tone: 'warn', label: 'Ready', text: `${d.failed} of ${d.total} filter lists could not be loaded` };
        case 'over-cache-limit':
          return { tone: 'warn', label: 'Ready', text: `The filter data (${mib(d.bytes)}) is larger than the cache limit (${mib(d.limitBytes)}): it is rebuilt each time GNOME starts` };
        case 'cache-rejected':
          return { tone: 'ok', label: 'Ready', text: 'The cached filter data did not verify and was rebuilt' };
        default:
          return { tone: 'warn', label: 'Ready', text: 'The content blocker reported a problem.' };
      }
    }
  }
}

/** Why one list was not compiled (`blocker.stats` → a list's `error` code, WAVE-B3 C5/D9). */
export function listErrorText(code: BlockerListError | null): string {
  switch (code) {
    case 'download':
      return 'Could not be downloaded from this server';
    case 'changed':
      return 'Changed on the server since GNOME last checked; it is used again once GNOME has the new version';
    case 'too-large':
      return 'Too large to load';
    case 'invalid-utf8':
      return 'Not a readable text list';
    case 'build':
      return 'The filter engine could not read it';
    default:
      return 'Not loaded';
  }
}

/** The category of a blocked page (`tab.error {kind: 'blocked'}`, `detail` exactly `blocked:<category>`), else null. */
export function blockedCategory(detail: string): BlockCategory | null {
  const m = /^blocked:([a-z-]{1,32})$/.exec(detail);
  const c = m?.[1];
  return c && (Object.keys(BLOCK_CATEGORY_LABELS) as string[]).includes(c) ? (c as BlockCategory) : null;
}

/** The blocked page's reason line for a category (the generic text for anything else). */
export function blockedReason(category: BlockCategory | null): string {
  switch (category) {
    case 'security':
      return 'This site is on a list of scam and malware sites.';
    case 'ads':
      return 'GNOME’s content blocker stopped this page from loading: a filter list for ads names this address.';
    case 'trackers':
      return 'GNOME’s content blocker stopped this page from loading: a filter list for trackers names this address.';
    case 'cookies':
      return 'GNOME’s content blocker stopped this page from loading: a cookie-notice filter list names this address.';
    case 'annoyances':
      return 'GNOME’s content blocker stopped this page from loading: an annoyance filter list names this address.';
    default:
      return 'GNOME’s content blocker stopped this page from loading.';
  }
}
