/**
 * GNOME's proxied-document CSP (ENGINE-PROTOCOL §6.16): Scramjet responses for every destination needsProxiedCsp()
 * lists (document, iframe, frame, object, embed, worker, sharedworker), any content type, carry PROXIED_DOCUMENT_CSP,
 * hard-wired (Ultraviolet responses get it from the service worker, lane b). The upstream policy is replaced, not
 * combined: Scramjet's own header rewriting already drops it (an upstream policy would break the engine), and no
 * report-uri/report-to is ever set (violations are counted in the engine host instead).
 */
import { PROXIED_DOCUMENT_CSP, needsProxiedCsp } from '../shared/proxy-origin';

export interface HeaderBag {
  get(name: string): string | null;
  set(name: string, value: string): void;
  delete?(name: string): void;
}

/**
 * Scramjet rewrites only `text/html` documents: an SVG, XHTML or XML document (or one without a usable Content-Type,
 * which the browser sniffs) reaches the frame unrewritten, so its scripts would run without any virtualization (and
 * without the WebRTC kill switch). For those, a second policy forbids scripts: the browser enforces both policies.
 */
export const SCRIPTLESS_DOCUMENT_CSP = "script-src 'none'";

/** Whether a navigable response of this MIME type can run scripts without Scramjet having rewritten it. */
export function scriptsUnrewritten(mime: string | null): boolean {
  if (mime === null) return true;
  if (mime === 'text/html') return false;
  return mime === 'image/svg+xml' || mime === 'application/xhtml+xml' || mime === 'text/xml' || mime === 'application/xml' || mime.endsWith('+xml') || mime === 'text/xsl';
}

/**
 * Frames and plugin content a proxied document may not have: a `data:` (or `blob:`) frame and an `<object>`/`<embed>`
 * document are fresh realms that no engine hook and no child-frame guard reaches (`data:` is opaque-origin), so their
 * scripts got the browser's own RTCPeerConnection: an ordinary Ultraviolet page leaked the user's IP through a
 * `data:` iframe in both browsers (tests/e2e/engine/suites/host-webrtc.mjs `fresh-realms`). PROXIED_DOCUMENT_CSP
 * allows `data:`/`blob:` for everything, frames included; the engine host adds this policy at the start of every UV
 * document (a `<meta>` policy, enforced from there on, also for `srcdoc` children, which inherit it). Engine-proxied
 * frames are same-origin (`'self'`); plugin loads never reach a service worker, so `<object>`/`<embed>` showed nothing
 * through either engine anyway.
 */
export const FRAME_RESTRICTION_CSP = "frame-src 'self'; object-src 'none'";

/** Sets the policy on a response for `destination`; returns whether it applied. */
export function applyProxiedCsp(destination: string, headers: HeaderBag, opts: { unrewrittenScripts?: boolean } = {}): boolean {
  if (!needsProxiedCsp(destination)) return false;
  headers.delete?.('content-security-policy-report-only');
  headers.set('content-security-policy', opts.unrewrittenScripts ? `${PROXIED_DOCUMENT_CSP}, ${SCRIPTLESS_DOCUMENT_CSP}` : PROXIED_DOCUMENT_CSP);
  return true;
}
