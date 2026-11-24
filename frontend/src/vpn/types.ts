/** VPN wire shapes and the connection the app knows (docs/WAVE-C.md §3.2, §6.2, D13, D14). */
export type LocationStatus = 'up' | 'down' | 'unknown';
export type ExitError = 'upstream_unreachable' | 'connect_failed' | 'tls_failed' | 'http_status' | 'bad_answer' | 'timeout';

export interface VpnExit {
  /** ok = the service answered; failed = see error; unchecked = not yet, or not shown to this client (no session the
   *  access policy admits, §6.2); off = this server runs no exit checks. */
  state: 'ok' | 'failed' | 'unchecked' | 'off';
  ip: string | null;
  country: string | null;
  city: string | null;
  /** The service's own "this is one of our exits" flag (`mullvad_exit_ip` at am.i.mullvad.net); null = not said. */
  provider_exit: boolean | null;
  /** The service's country against the profile's: null when it cannot tell. */
  country_match: boolean | null;
  checked_at: number | null;
  error: ExitError | null;
  /** The IPv6 check (`GNOME_VPN_CHECK_URL_V6`); null when the server checks no IPv6 name. */
  v6: { state: 'ok' | 'failed' | 'unchecked'; ip: string | null; error: ExitError | null } | null;
}

export interface VpnLocation {
  id: string;
  label: string;
  country_code: string; // lowercase ISO 3166-1 alpha-2
  country: string;
  city: string;
  provider_note: string; // operator text, may be empty: render as text
  path: string;
  status: LocationStatus; // the health probe: the location's instance answers (not: its exit works)
  checked_at: number | null;
  exit: VpnExit;
}

export interface VpnLocations {
  profiles: VpnLocation[];
  verify_url: string | null; // null = no exit checks on this server
  check_service: string | null; // the check URL's host, for wording
}

export interface VpnLocationRef { id: string; label: string }
/** Exit-check failures are not here: they never change the connection (D14), they add a warning. */
export type VpnUnusable = 'location-down' | 'location-gone' | 'no-location';

/** What the VPN page and the chip show: the app's own facts (D13); `exitWarning` = the server's last check of that
 *  location failed (D14). */
export type VpnConnection =
  | { kind: 'off' }
  | { kind: 'connecting'; location: VpnLocationRef; exitWarning: ExitError | null }
  | { kind: 'connected'; location: VpnLocationRef; engine: 'running' | 'not-started'; exitWarning: ExitError | null }
  | { kind: 'blocked'; location: VpnLocationRef | null; reason: VpnUnusable } // kill switch on
  | { kind: 'fallback'; location: VpnLocationRef | null; reason: VpnUnusable }; // kill switch off: default route
