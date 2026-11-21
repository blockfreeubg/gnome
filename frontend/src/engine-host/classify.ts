/**
 * Failure classification (ENGINE-PROTOCOL §6.4): which TabErrorKind a failed navigation is, from what fired and the
 * transport's words. DNS, TLS and connect failures look alike to every transport (HolyWisp's CLOSE reasons are not
 * surfaced), so they are all `network`, and `detail` keeps the transport's text. Pure.
 */
import type { FailureSignal, TabErrorKind } from '../shared/engine-protocol';

/**
 * Transport and destination failures as libcurl.js, epoxy, bare-mux and the engines word them (spike §3 item 6 and
 * §6): connect/DNS ("code 6", "code 7 Could not connect", NXDOMAIN, "not known"), TLS ("code 35 SSL connect error",
 * "code 60", certificate, hyper's "UnexpectedEof … tls"), Wisp stream ends (MuxTaskEnded, Multiplexor), and the
 * engines' fetch failures ("Failed to fetch", "NetworkError", "no bare clients", a WebSocket error).
 */
const NETWORK_SIGNATURE =
  /\b(?:code (?:6|7|28|35|52|56|60)\b|could not (?:connect|resolve)|couldn'?t (?:connect|resolve)|resolve|nxdomain|not known|name or service|certificate|ssl|tls|unexpectedeof|connection (?:refused|reset|closed)|timed? ?out|muxtaskended|multiplexor|wisp|websocket|failed to fetch|networkerror|network error|load failed|no bare clients|econn|ehostunreach|enetunreach)/i;

export function hasNetworkSignature(detail: string): boolean {
  return NETWORK_SIGNATURE.test(detail);
}

export interface FailureContext {
  /** navigator.onLine is false. */
  offline: boolean;
  /** The engine's transport was offline (no ticket, gateway or upstream unreachable, …) when the navigation failed. */
  transportOffline: boolean;
}

export function classifyFailure(signal: FailureSignal, detail: string, ctx: FailureContext): TabErrorKind {
  if (signal === 'blocked') return 'blocked';
  if (ctx.offline) return 'offline';
  if (signal === 'timeout') return ctx.transportOffline ? 'gateway' : 'timeout';
  if (signal === 'frame-left-proxy' || signal === 'engine-unavailable') return 'engine';
  if (ctx.transportOffline) return 'gateway';
  // The error hook, UV's error page and a failed fallback carry the transport's words when the destination could not
  // be reached; anything else is the engine itself.
  return hasNetworkSignature(detail) ? 'network' : 'engine';
}
