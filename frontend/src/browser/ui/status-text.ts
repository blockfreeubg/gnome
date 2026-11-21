/** Wording for the engine host's transport states (ENGINE-PROTOCOL §6.6 "App shows"). Pure. */
import type { TransportStatus } from '../../shared/engine-protocol';

export interface TransportText {
  /** A few words for badges and lists. */
  short: string;
  /** A sentence for the notice and the engine panel, or null when there is nothing to say. */
  long: string | null;
  /** Offline in a way the user should see in the content area. */
  blocking: boolean;
}

const seconds = (ms: number | null): string => (ms === null ? '' : ` in ${Math.max(1, Math.round(ms / 1000))} s`);

export function describeTransport(t: TransportStatus): TransportText {
  const via = t.endpoint === 'profile' ? 'the VPN location' : t.endpoint === 'custom' ? 'your Wisp server' : 'GNOME’s gateway';
  // `ready` means built with nothing known wrong, not "a socket is open" (sockets open on demand, ENGINE-PROTOCOL §6.6).
  if (t.state === 'ready') return { short: `${t.transport} ready`, long: null, blocking: false };
  if (t.state === 'connecting') return { short: 'Connecting…', long: null, blocking: false };
  if (t.state === 'degraded') return { short: 'Reconnecting…', long: null, blocking: false };
  switch (t.detail) {
    case 'ticket-missing':
      return { short: 'Not signed in', long: 'Sign in to keep browsing.', blocking: true };
    case 'ticket-rejected':
      return { short: 'Reconnecting…', long: 'Reconnecting to the server…', blocking: false };
    case 'gateway-unreachable':
      return {
        short: 'Server unreachable',
        long: t.endpoint === 'custom' ? `Your Wisp server does not answer. Retrying${seconds(t.retryInMs)}.` : `GNOME’s server is unreachable. Retrying${seconds(t.retryInMs)}.`,
        blocking: true,
      };
    case 'upstream-unreachable':
      return {
        short: t.endpoint === 'profile' ? 'VPN location down' : 'Proxy service down',
        long: t.endpoint === 'profile' ? `This VPN location is down. Retrying${seconds(t.retryInMs)}.` : `GNOME’s proxy service is down. Retrying${seconds(t.retryInMs)}.`,
        blocking: true,
      };
    case 'unknown-profile':
      return { short: 'VPN location removed', long: 'The server no longer offers this VPN location. Choose another one under VPN.', blocking: true };
    case 'rate-limited':
      return { short: 'Too many connections', long: `Too many connections, retrying${seconds(t.retryInMs)}.`, blocking: true };
    case 'rebuild-limit':
      return { short: 'Connection unstable', long: `The connection to ${via} is unstable, retrying${seconds(t.retryInMs)}.`, blocking: true };
    default:
      return { short: 'Offline', long: `Not connected to ${via}.`, blocking: true };
  }
}
