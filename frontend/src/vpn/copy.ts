/**
 * The VPN page's and chip's texts (docs/WAVE-C.md §7.3, exact). A unit test runs every exported string (and every
 * exported function's output) through the forbidden-words check: no provider name, no "secure", "anonymous",
 * "protected", "encrypted", "no logs", "hide your IP", "your IP is hidden" or "system-wide". The provider's name may
 * appear only inside operator text (`provider_note`) and the check service's host, which this file never contains.
 */
import type { ExitError, VpnConnection, VpnExit, VpnUnusable } from './types';

function unusableText(prefix: 'Blocked' | 'Not in use', reason: VpnUnusable, label: string | null): string {
  if (reason === 'no-location' || !label) return `${prefix}: no VPN location`;
  return reason === 'location-gone' ? `${prefix}: ${label} is no longer offered` : `${prefix}: ${label} is down`;
}

/** The `status` "Connection" text. */
export function stateText(c: VpnConnection): string {
  switch (c.kind) {
    case 'off':
      return 'Off';
    case 'connecting':
      return `Connecting to ${c.location.label}`;
    case 'connected':
      return c.engine === 'running' ? `Connected to ${c.location.label}` : `Ready: ${c.location.label}`;
    case 'blocked':
      return unusableText('Blocked', c.reason, c.location?.label ?? null);
    case 'fallback':
      return unusableText('Not in use', c.reason, c.location?.label ?? null);
  }
}

/** The one-line consequence under the state. */
export function stateLine(c: VpnConnection): string {
  switch (c.kind) {
    case 'off':
      return "Pages you open in GNOME go through this server's own connection.";
    case 'connecting':
      return `Pages you open in GNOME will go through ${c.location.label}.`;
    case 'connected':
      return c.engine === 'running'
        ? `Pages you open in GNOME are routed through ${c.location.label}.`
        : `Pages you open in GNOME will be routed through ${c.location.label}.`;
    case 'blocked': {
      const label = c.location?.label;
      if (c.reason === 'no-location' || !label) {
        return 'The kill switch stops pages from loading. This server offers no VPN location to route them through.';
      }
      const until = c.reason === 'location-gone' ? 'until you choose another location' : `until ${label} is back`;
      return `The kill switch stops pages from loading ${until}, instead of using this server's own connection.`;
    }
    case 'fallback':
      return "Pages load through this server's own connection until the VPN can be used again.";
  }
}

export const EXIT_REASONS: Readonly<Record<ExitError, string>> = {
  upstream_unreachable: 'The location does not answer.',
  connect_failed: "Connections through this location to the check service fail: the location's tunnel or the check service may be down.",
  tls_failed: "The check service's HTTPS connection failed through this location.",
  http_status: 'The check service answered with an error.',
  bad_answer: "The check service's answer could not be read.",
  timeout: 'The check took too long.',
};

/** "The exit check through <label> fails: <reason>" (the reason in lower case without its final period). */
export function exitWarningText(label: string, error: ExitError): string {
  const reason = EXIT_REASONS[error];
  return `The exit check through ${label} fails: ${reason.charAt(0).toLowerCase()}${reason.slice(1).replace(/\.$/, '')}`;
}

export const NO_CHECKS = 'This server runs no exit checks.';
export const CHECK_DENIED = 'Enter the access code or sign in to see exit checks.';
export const NOT_CHECKED = 'Not checked yet.';
export const CHECK_AGAIN = 'Check again';
export const NO_LOCATIONS = 'This server offers no VPN locations.';
export const AUTOMATIC = 'Automatic — the first location that is online';
export const KILL_SWITCH_LABEL = 'Block if the location is down';
export const KILL_SWITCH_HELP = 'Kept in this browser only.';
export const LOCATIONS_ERROR = 'The VPN locations could not be loaded.';
export const FOOTER = "GNOME is not affiliated with any VPN provider. These locations are run by this server's operator.";
export const WEBRTC_WARNING =
  'WebRTC is allowed in Privacy settings: pages can connect to other computers directly, outside GNOME and the VPN, and learn your address.';

export const STATUS_WORDS: Readonly<Record<'up' | 'down' | 'unknown', string>> = {
  up: 'Online',
  down: 'Offline',
  unknown: 'Not checked yet',
};

/** Until lane v3's persistent count: shown for 10 s after a route change while connected. */
export function routeChangeNotice(label: string): string {
  return `Tabs you opened earlier keep their pages. Reload them to load them through ${label}.`;
}

export function nowUsingToast(label: string): string {
  return `Now using ${label}`;
}

/** "<service> reports <ip> in <city>, <country>" (the place as far as the service said it). */
export function exitReport(service: string, exit: Pick<VpnExit, 'ip' | 'city' | 'country'>): string {
  const place = [exit.city, exit.country].filter((p): p is string => !!p).join(', ');
  return `${service} reports ${exit.ip ?? 'no address'}${place ? ` in ${place}` : ''}`;
}

export function providerExitText(service: string, yes: boolean): string {
  return `${service} says this address is one of its VPN exits: ${yes ? 'yes' : 'no'}`;
}

export function countryMismatchText(service: string, exitCountry: string, profileCountry: string): string {
  return `${service} places this exit in ${exitCountry}, not ${profileCountry}`;
}

export function v6Text(service: string, v6: NonNullable<VpnExit['v6']>): string {
  if (v6.state === 'ok') return `IPv6: ${service} reports ${v6.ip ?? 'no address'}`;
  if (v6.state === 'failed') return `IPv6: ${v6.error ? EXIT_REASONS[v6.error] : 'The check failed.'}`;
  return `IPv6: ${NOT_CHECKED}`;
}

/** "What the VPN does and does not do" (verbatim); `service` = check_service; Checks only when a service is set. */
export function privacyParagraphs(service: string | null): Array<{ lead: string; text: string }> {
  const out = [
    {
      lead: 'What it does.',
      text: "Pages you open in GNOME's browser leave this GNOME server through the location you choose, so the sites you open in GNOME see that location's address instead of this server's. Your device's address is not sent with GNOME's page requests, but a page built to attack GNOME can still make your browser reveal it (WebRTC and the other gaps under Kill switch).",
    },
    {
      lead: 'What it does not do.',
      text: "It does not route your device, your other browser tabs or apps, GNOME's own pages and settings, or games: games load directly from their publishers, who see your own address. It is not a VPN app and changes nothing on your device.",
    },
    {
      lead: 'Who runs it.',
      text: "This server's operator runs these locations over internet connections they are authorized to share with the people who use this server. The VPN service and the location's exit can see the names of the sites you open (not the content of HTTPS pages). This server's operator runs GNOME itself and is trusted with more. GNOME is not affiliated with any VPN provider.",
    },
  ];
  if (service) {
    out.push({
      lead: 'Checks.',
      text: `The exit check asks ${service} which address it sees from a location. It shows what ${service} reports, not proof that your pages use the VPN: GNOME knows that from its own route choice, which this server enforces.`,
    });
  }
  out.push(
    {
      lead: 'Kill switch.',
      text: 'With "Block if the location is down" on, pages stop loading while the location is down instead of going through this server\'s own connection. While the VPN and the kill switch are on, GNOME also blocks WebRTC in pages; a site built to get around that block can still learn your address.',
    },
    {
      lead: 'This browser only.',
      text: 'The VPN switch and the kill switch are kept in this browser: your other devices and settings files you import don\'t change them. "Connect automatically" syncs with your other settings.',
    },
  );
  return out;
}

export const PRIVACY_TITLE = 'What the VPN does and does not do';
