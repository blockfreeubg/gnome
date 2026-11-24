/**
 * "This browser's check" (docs/WAVE-C.md §8.1, D15): the check service's answer through this browser's route, asked
 * by the engine host (`browser.verifyExit`, command `vpn.verify`). It runs once after each connect or route change
 * once the engine host is ready, and on **Check again**, only while `vpn.verifyExit` is on (default off) and the
 * server names a check service. The answer is kept in memory for this app page; it is never proof (a page that broke
 * out of the engine can fake it), and agreement with the server's check adds no wording ("confirmed" is never said).
 */
import { untrack } from 'svelte';
import type { VpnVerifyResult } from '../../shared/engine-protocol';
import { exitReport } from '../../vpn/copy';

export const BROWSER_CHECK_TITLE = 'This browser’s check';
export const BROWSER_CHECK_CAVEAT = 'A page that broke out of GNOME’s browser engine can fake this answer.';
export const BROWSER_CHECK_FAILED = 'This browser’s check got no answer from the check service.';
export const AUTO_CONNECT_LABEL = 'Connect automatically';
export const AUTO_CONNECT_HELP = 'Turn the VPN on each time GNOME opens in a new browser tab, also after you disconnected.';
export const VERIFY_LABEL = 'Check this browser’s exit';
export const VERIFY_HELP =
  'Ask the check service, through this browser’s route, which address sites see. Its answer is not proof, and the check service sees this server’s VPN address each time.';

/** "Through this browser's route, <service> reports <ip> in <city>, <country>". */
export function browserCheckText(service: string, r: Pick<VpnVerifyResult, 'ip' | 'city' | 'country'>): string {
  return `Through this browser’s route, ${exitReport(service, r)}`;
}

export function mismatchText(label: string): string {
  return `This browser’s check answered differently from the server’s check of ${label}. A page may have interfered with GNOME’s browser engine, or the location changed its exit address.`;
}

/** "<n> tabs may still use the previous route until you reload them" (singular for one). */
export function previousRouteText(n: number): string {
  return n === 1 ? '1 tab may still use the previous route until you reload it' : `${n} tabs may still use the previous route until you reload them`;
}

export interface BrowserCheckFacts {
  /** browser.vpnLocation */
  readonly vpnLocation: { id: string; status: string } | null;
  readonly engineState: string;
  readonly verifyExit: boolean;
  /** vpnState().verifyUrl */
  readonly verifyUrl: string | null;
  verify(url: string): Promise<VpnVerifyResult | null>;
}

export class BrowserCheck {
  /** The last answer, for the location it was asked through. */
  result = $state.raw<{ locationId: string; answer: VpnVerifyResult | null } | null>(null);
  running = $state(false);
  /** The route the automatic check last ran for (one run per connect or route change). */
  #lastKey: string | null = null;

  /** Runs the check through the current route (Check again, or the automatic run). */
  async run(f: BrowserCheckFacts): Promise<void> {
    const loc = f.vpnLocation;
    if (!loc || loc.status === 'none' || !f.verifyExit || !f.verifyUrl || this.running) return;
    this.running = true;
    try {
      const answer = await f.verify(f.verifyUrl);
      this.result = { locationId: loc.id, answer };
    } finally {
      this.running = false;
    }
  }

  /** The automatic run: once per route (connect, route change), once the engine host is ready. */
  maybeRun(f: BrowserCheckFacts): void {
    const loc = f.vpnLocation;
    const key = loc && loc.status !== 'none' ? loc.id : null;
    if (key === null) {
      this.#lastKey = null;
      return;
    }
    if (f.engineState !== 'ready' || !f.verifyExit || !f.verifyUrl || key === this.#lastKey) return;
    this.#lastKey = key;
    void this.run(f);
  }
}

export const browserCheck = new BrowserCheck();

/** vpn/start.ts: the automatic run follows the browser's facts. Returns the stop function. */
export function watchBrowserCheck(facts: BrowserCheckFacts, check: BrowserCheck = browserCheck): () => void {
  return $effect.root(() => {
    $effect(() => {
      void facts.vpnLocation?.id;
      void facts.vpnLocation?.status;
      void facts.engineState;
      void facts.verifyExit;
      void facts.verifyUrl;
      untrack(() => check.maybeRun(facts));
    });
  });
}
